"""
rules_admin.py — view and update the validation rule catalog.

The Configuration page edits setup_error_messages_source_VW (the rules of the
HCM-phase modules; FIN / SCM / GL are filtered out by the view itself). Which
fields may change, and to what, is decided here and handed to the page, so
the screen and the server cannot disagree:

  read-only     Entity, Validation_code, OctaneA-D, TransformationLogicApplied
  fixed values  Validation_Type, Severity, the four Y/N flags
  free text     Error_Message, Error_Message_SPA, PATH_FORWARD, Notes, InternalNote

Every saved change is written, field by field, to
SETUP_ERROR_MESSAGES_SOURCE_AUDIT (created on first use) in the same
transaction as the update.

The team loads the path forward into the main rule table. A test target works
on its own copy of that table, so rules_sync brings the path forward across
for the rules whose copy has none, and never overwrites one edited here.
"""
import pyodbc

import api_util
import authz
import validation_seed
from api_util import ApiError

ACTIONS = {"rules_list", "rules_update", "rules_audit", "rules_sync"}

DB = validation_seed.TARGET_DB
SOURCE = validation_seed.SOURCE_DB
VIEW = "setup_error_messages_source_VW"
TABLE = "SETUP_ERROR_MESSAGES_SOURCE"
AUDIT = "SETUP_ERROR_MESSAGES_SOURCE_AUDIT"
KEY = "Validation_code"

VALIDATION_TYPES = ["Record Count", "Error", "Informative", "Warning", "Critical Error", "Extract Error"]
SEVERITIES = ["High", "Informative", "Low", "Medium"]
YES_NO = ["Y", "N"]


def _field(name, label, editable=False, values=None, max_length=None, multiline=False, allow_blank=True):
    return {"name": name, "label": label, "editable": editable, "values": values,
            "max_length": max_length, "multiline": multiline,
            "allow_blank": allow_blank if editable else False}


# In the order the view lists them. The five Octane / transformation fields
# carry no read/write annotation in the request, so they stay read-only.
FIELDS = [
    _field("Entity", "Entity"),
    _field("Validation_code", "Validation code"),
    _field("Validation_Type", "Validation type", True, values=VALIDATION_TYPES, allow_blank=False),
    _field("Error_Message", "Error message", True, max_length=200, multiline=True),
    _field("Error_Message_SPA", "Error message (Spanish)", True, max_length=250, multiline=True),
    _field("PATH_FORWARD", "Path forward", True, multiline=True),
    _field("Severity", "Severity", True, values=SEVERITIES, allow_blank=False),
    _field("OctaneA", "Octane A"),
    _field("OctaneB", "Octane B"),
    _field("OctaneC", "Octane C"),
    _field("OctaneD", "Octane D"),
    _field("TransformationLogicApplied", "Transformation logic applied"),
    _field("RecordsConverted", "Records converted", True, values=YES_NO),
    _field("Notes", "Notes", True, multiline=True),
    _field("AgencyReports", "Agency reports", True, values=YES_NO),
    _field("Sourcereports", "Source reports", True, values=YES_NO),
    _field("OATRHReports", "OATRH reports", True, values=YES_NO),
    _field("InternalNote", "Internal note", True, max_length=500, multiline=True),
]
_BY_NAME = {f["name"]: f for f in FIELDS}
_NAMES = [f["name"] for f in FIELDS]
_SELECT = ", ".join(f"[{n}]" for n in _NAMES)

_READY = {"view": False, "audit": False}   # checked once per container


# ── pure helpers (no database) ───────────────────────────────────────────────

def _like_escape(text):
    """Literal text for a LIKE ... ESCAPE '\\' pattern (codes contain '_')."""
    for ch in ("\\", "%", "_", "["):
        text = text.replace(ch, "\\" + ch)
    return text


def _type_sql(dtype, clen, prec, scale):
    t = dtype.upper()
    if t in ("VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "VARBINARY", "BINARY"):
        t += "(MAX)" if clen == -1 else f"({clen})"
    elif t in ("DECIMAL", "NUMERIC"):
        t += f"({prec},{scale})"
    return t


def _quote(name):
    return "[" + str(name).replace("]", "]]") + "]"


def _blank_to_none(value):
    return None if value is None or str(value).strip() == "" else value


def clean_changes(changes):
    """Validate {field: value} against the field rules. Returns {field: str | None}
    (text trimmed, blank -> None). Raises ApiError(400) naming the exact problem."""
    if not isinstance(changes, dict) or not changes:
        raise ApiError("changes must be a non-empty object of {field: value}")
    clean = {}
    for name, value in changes.items():
        spec = _BY_NAME.get(name)
        if not spec:
            raise ApiError(f"Unknown field: {name!r}")
        if not spec["editable"]:
            raise ApiError(f"{name} is read-only")
        if value is not None and not isinstance(value, str):
            raise ApiError(f"{name} must be text")
        value = (value or "").strip() or None
        if value is None:
            if not spec["allow_blank"]:
                raise ApiError(f"{name} cannot be blank; valid values: {', '.join(spec['values'])}")
        elif spec["values"] is not None:
            if value not in spec["values"]:
                raise ApiError(f"{name} must be one of: {', '.join(spec['values'])}")
        elif spec["max_length"] and len(value) > spec["max_length"]:
            raise ApiError(f"{name} is {len(value)} characters; the limit is {spec['max_length']}")
        clean[name] = value
    return clean


def diff_changes(rows, clean):
    """The fields whose stored value really differs from the requested one.
    `rows` are the current row dicts for the code (more than one when a code is
    duplicated). Returns [(field, old_text_for_audit, new_value)]."""
    out = []
    for name, new in clean.items():
        olds = []
        for r in rows:
            old = _blank_to_none(r.get(name))
            if old not in olds:
                olds.append(old)
        if olds == [new]:
            continue
        old_text = olds[0] if len(olds) == 1 else " | ".join("NULL" if o is None else str(o) for o in olds)
        out.append((name, old_text, new))
    return out


# ── database preparation ─────────────────────────────────────────────────────

def _exists(cur, name, catalog="objects"):
    cur.execute(f"SELECT COUNT(*) FROM [{DB}].sys.{catalog} WHERE name = ?", (name,))
    return cur.fetchone()[0] > 0


def _sync_table_columns(conn, cur):
    """Test target only: the test copy of the rule table was cloned before the
    team added columns to the original, and the view cannot be created over a
    table that lacks them. Add each missing column (same type, nullable) and
    fill it from the source table by validation code. Returns the added names."""
    if not validation_seed.is_test_target() or not _exists(cur, TABLE, "tables"):
        return []   # a missing table is cloned whole, with its rows, by the seeder
    cur.execute(f"SELECT COLUMN_NAME FROM [{DB}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?", (TABLE,))
    have = {r[0].upper() for r in cur.fetchall()}
    cur.execute(
        f"SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE "
        f"FROM [{SOURCE}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? ORDER BY ORDINAL_POSITION", (TABLE,))
    missing = [(r[0], _type_sql(r[1], r[2], r[3], r[4])) for r in cur.fetchall() if r[0].upper() not in have]
    if not missing:
        return []
    for col, type_sql in missing:
        cur.execute(f"ALTER TABLE [{DB}].dbo.[{TABLE}] ADD {_quote(col)} {type_sql} NULL")
    sets = ", ".join(f"t.{_quote(col)} = s.{_quote(col)}" for col, _ in missing)
    cur.execute(
        f"UPDATE t SET {sets} FROM [{DB}].dbo.[{TABLE}] t JOIN [{SOURCE}].dbo.[{TABLE}] s "
        f"ON s.[VALIDATION_CODE] COLLATE DATABASE_DEFAULT = t.[VALIDATION_CODE] COLLATE DATABASE_DEFAULT")
    conn.commit()
    return [col for col, _ in missing]


def _ensure_view(conn, cur):
    """Make sure the rules view can be read. Returns warnings for the page.
    Outside a test target nothing is ever created: the view belongs to the
    validation team."""
    if _READY["view"]:
        return []
    warnings = []
    if not _exists(cur, VIEW):
        if not validation_seed.is_test_target():
            raise ApiError(f"{VIEW} does not exist in {DB}", 500)
        try:
            added = _sync_table_columns(conn, cur)
            if added:
                warnings.append(f"Added to the test copy of {TABLE} from {SOURCE}: {', '.join(added)}")
            seeder = validation_seed.Seeder(conn)
            seeder.ensure(VIEW)
            warnings.extend(seeder.report["failed"])
        except Exception as e:  # noqa: BLE001 - reported to the page below
            conn.rollback()
            warnings.append(f"Could not prepare {VIEW} in {DB}: {str(e)[:200]}")
        if not _exists(cur, VIEW):
            raise ApiError(f"{VIEW} is not available in {DB}. " + " ; ".join(warnings), 500)
    _READY["view"] = True
    return warnings


def _ensure_audit(conn, cur):
    if _READY["audit"]:
        return
    if not _exists(cur, AUDIT, "tables"):
        cur.execute(
            f"CREATE TABLE [{DB}].dbo.[{AUDIT}] ("
            "[ID] INT IDENTITY(1,1) PRIMARY KEY, [Validation_Code] NVARCHAR(50) NULL, "
            "[Field_Name] VARCHAR(60) NULL, [Old_Value] NVARCHAR(MAX) NULL, [New_Value] NVARCHAR(MAX) NULL, "
            "[Changed_By] NVARCHAR(200) NULL, [Changed_DTTM] DATETIME NULL)")
        conn.commit()
    _READY["audit"] = True


def _rows_for_code(cur, code):
    cur.execute(f"SELECT {_SELECT} FROM [{DB}].dbo.[{VIEW}] WHERE [{KEY}] = ?", (code,))
    return [dict(zip(_NAMES, r)) for r in cur.fetchall()]


# ── actions ──────────────────────────────────────────────────────────────────

def _viewer(event):
    p = api_util.params(event)
    email = (p.get("email") or "").strip()
    if not email:
        raise ApiError("email is required")
    role = authz.require(email, authz.CERT_REVIEWER, what="viewing the validation rules")
    return p, role


def _list(event, headers, conn, cur):
    p, role = _viewer(event)
    warnings = _ensure_view(conn, cur)
    where, args = [], []
    for param, col in (("entity", "Entity"), ("validation_type", "Validation_Type"), ("severity", "Severity")):
        value = (p.get(param) or "").strip()
        if value:
            where.append(f"[{col}] = ?")
            args.append(value)
    q = (p.get("q") or "").strip()
    if q:
        where.append("([Validation_code] LIKE ? ESCAPE '\\' OR [Error_Message] LIKE ? ESCAPE '\\' "
                     "OR [Error_Message_SPA] LIKE ? ESCAPE '\\')")
        args += [f"%{_like_escape(q)}%"] * 3
    cur.execute(
        f"SELECT {_SELECT} FROM [{DB}].dbo.[{VIEW}]"
        + (" WHERE " + " AND ".join(where) if where else "")
        + " ORDER BY [Entity], [Validation_code]", args)
    rows = [dict(zip(_NAMES, r)) for r in cur.fetchall()]

    # Filter choices: the valid values first, then whatever else is stored, so
    # rows holding an out-of-list value can still be found and corrected.
    cur.execute(f"SELECT DISTINCT [Entity], [Validation_Type], [Severity] FROM [{DB}].dbo.[{VIEW}]")
    entities, types, severities = set(), set(), set()
    for entity, vtype, severity in cur.fetchall():
        for bucket, value in ((entities, entity), (types, vtype), (severities, severity)):
            if _blank_to_none(value) is not None:
                bucket.add(value)
    return api_util.ok(headers, {
        "db": DB, "can_edit": role == authz.SUPER_USER, "fields": FIELDS, "rows": rows,
        "entities": sorted(entities, key=str.upper),
        "validation_types": VALIDATION_TYPES + sorted(types - set(VALIDATION_TYPES)),
        "severities": SEVERITIES + sorted(severities - set(SEVERITIES)),
        "total": len(rows), "warnings": warnings,
    })


def _update(event, headers, conn, cur):
    body = api_util.body(event)
    actor = (body.get("actor") or "").strip()
    authz.require(actor, what="editing the validation rules")
    code = body.get("validation_code")
    # The stored code is used exactly as sent: trimming it could miss a rule
    # whose code carries stray whitespace, or land the update on another rule.
    if not isinstance(code, str) or not code.strip() or len(code) > 50:
        raise ApiError("validation_code is required (up to 50 characters)")
    clean = clean_changes(body.get("changes"))

    _ensure_view(conn, cur)
    _ensure_audit(conn, cur)
    rows = _rows_for_code(cur, code)
    if not rows:
        raise ApiError(f"Validation code {code} was not found", 404)
    if len(rows) > 1 and not body.get("allow_multiple"):
        # Codes are meant to be unique; when they are not, every rule sharing
        # the code would change, so the caller has to say that is intended.
        raise ApiError(f"{len(rows)} rules share the code {code}; saving changes all of them. "
                       f"Confirm to continue.", 409)
    diffs = diff_changes(rows, clean)
    if not diffs:
        return api_util.ok(headers, {"validation_code": code, "changed": [], "rows_affected": 0, "row": rows[0]})

    sets = ", ".join(f"[{name}] = ?" for name, _, _ in diffs)
    cur.execute(f"UPDATE [{DB}].dbo.[{VIEW}] SET {sets} WHERE [{KEY}] = ?", [new for _, _, new in diffs] + [code])
    affected = cur.rowcount
    for name, old, new in diffs:
        cur.execute(
            f"INSERT INTO [{DB}].dbo.[{AUDIT}] ([Validation_Code], [Field_Name], [Old_Value], [New_Value], "
            f"[Changed_By], [Changed_DTTM]) VALUES (?, ?, ?, ?, ?, GETDATE())",
            (code, name, old, new, actor))
    conn.commit()
    fresh = _rows_for_code(cur, code)
    return api_util.ok(headers, {
        "validation_code": code, "changed": [name for name, _, _ in diffs],
        "rows_affected": affected if affected is not None and affected >= 0 else len(rows),
        "row": fresh[0] if fresh else None,
    })


def _audit(event, headers, conn, cur):
    p, _ = _viewer(event)
    _ensure_audit(conn, cur)
    code = p.get("validation_code") or ""
    code = code if code.strip() else ""
    cur.execute(
        f"SELECT TOP 200 [ID], [Validation_Code], [Field_Name], [Old_Value], [New_Value], [Changed_By], [Changed_DTTM] "
        f"FROM [{DB}].dbo.[{AUDIT}]" + (" WHERE [Validation_Code] = ?" if code else "") + " ORDER BY [ID] DESC",
        (code,) if code else ())
    rows = [{"id": r[0], "validation_code": r[1], "field": r[2], "old": r[3], "new": r[4], "by": r[5], "at": r[6]}
            for r in cur.fetchall()]
    return api_util.ok(headers, {"rows": rows, "total": len(rows)})


def _has_text(alias):
    return f"NULLIF(LTRIM(RTRIM({alias}.[PATH_FORWARD])), '') IS NOT NULL"


def _sync(event, headers, conn, cur):
    body = api_util.body(event)
    actor = (body.get("actor") or "").strip()
    authz.require(actor, what="copying the path forward from the main rules")
    if not validation_seed.is_test_target():
        raise ApiError(f"{DB} holds the main rules; there is no test copy to fill")
    # Before the view is prepared: that step brings missing columns across as
    # well, and a path forward that arrived that way would go uncounted.
    added = [col.upper() for col in _sync_table_columns(conn, cur)]
    _ensure_view(conn, cur)
    _ensure_audit(conn, cur)
    audit = (f"INSERT INTO [{DB}].dbo.[{AUDIT}] ([Validation_Code], [Field_Name], [Old_Value], [New_Value], "
             f"[Changed_By], [Changed_DTTM]) SELECT t.[VALIDATION_CODE], 'PATH_FORWARD', NULL, ")
    if "PATH_FORWARD" in added:
        # The copy had no such column: the helper created it and brought every
        # value across, so what arrived is what gets recorded.
        cur.execute(
            audit + f"MAX(t.[PATH_FORWARD]), ?, GETDATE() FROM [{DB}].dbo.[{TABLE}] t "
            f"WHERE {_has_text('t')} GROUP BY t.[VALIDATION_CODE]", (actor,))
        updated = cur.rowcount
    else:
        # One value per code on the source side, so the audit row and the
        # update agree when a code is duplicated there.
        pending = (
            f"FROM [{DB}].dbo.[{TABLE}] t JOIN (SELECT [VALIDATION_CODE], MAX([PATH_FORWARD]) AS [PATH_FORWARD] "
            f"FROM [{SOURCE}].dbo.[{TABLE}] m WHERE {_has_text('m')} GROUP BY [VALIDATION_CODE]) s "
            f"ON s.[VALIDATION_CODE] COLLATE DATABASE_DEFAULT = t.[VALIDATION_CODE] COLLATE DATABASE_DEFAULT "
            f"WHERE NOT ({_has_text('t')})")
        cur.execute(audit + f"MAX(s.[PATH_FORWARD]), ?, GETDATE() {pending} GROUP BY t.[VALIDATION_CODE]", (actor,))
        updated = cur.rowcount
        cur.execute(f"UPDATE t SET t.[PATH_FORWARD] = s.[PATH_FORWARD] {pending}")
    conn.commit()
    return api_util.ok(headers, {"updated": max(updated or 0, 0)})


def handle(action, event, bucket, headers, conn_str):
    def run():
        with pyodbc.connect(conn_str, autocommit=False) as conn:
            cur = conn.cursor()
            if action == "rules_list":
                return _list(event, headers, conn, cur)
            if action == "rules_update":
                return _update(event, headers, conn, cur)
            if action == "rules_sync":
                return _sync(event, headers, conn, cur)
            return _audit(event, headers, conn, cur)

    return api_util.guarded(run, headers)
