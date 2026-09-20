"""
certifications.py — agencies certify their files and the validations reported
to them.

What must be certified comes from the validation team's own setup table,
SETUP_DATA_CLEANSE_FILE_LOCATION_<MOCK> WHERE CertificationRequired = 'Y'.
The certifying party of a row is its Agency, or its Source when the row has no
Agency (the same rule the team's view uses).

Validations reported to a party come from the Data Cleanse Log
(LOG_DATA_CLEANSE_DETAIL counted by Validation_Code / Source / BU) for the
rules the catalog marks AgencyReports = 'Y'. Only counts are read from the log;
no record-level column is ever selected.

Certifications are stored in the application's own tables (history is kept: a
re-certification retires the previous row and inserts a new one):

  DATA_CLEANSE_CERT_VALIDATION  Source/Agency, Validation Code, path forward,
                                notes, certified by
  DATA_CLEANSE_CERT_FILE        Source/Agency, entity + file type, notes,
                                certified by
  DATA_CLEANSE_CERT_ATTACHMENT  documents attached to either kind

Roles: an agency user certifies only for the sources / agencies / business
units they are allowed; a certification reviewer sees the status dashboard and
generates the status report; a super user does everything.
"""
import io
import re
import uuid
from datetime import datetime

import pyodbc

import api_util
import authz
import validation_seed
from api_util import ApiError

ACTIONS = {
    "cert_expected", "cert_validations", "cert_certify_validation", "cert_certify_file",
    "cert_upload_url", "cert_attachment_add", "cert_attachments", "cert_download_url",
    "cert_attachment_delete", "cert_status", "cert_status_report", "cert_revoke",
}

DB = validation_seed.TARGET_DB
SOURCE = validation_seed.SOURCE_DB

LOCATION_PREFIX = "SETUP_DATA_CLEANSE_FILE_LOCATION_"
LOG_TABLE = "LOG_DATA_CLEANSE_DETAIL"
CATALOG_TABLE = "SETUP_ERROR_MESSAGES_SOURCE"
T_VALIDATION = "DATA_CLEANSE_CERT_VALIDATION"
T_FILE = "DATA_CLEANSE_CERT_FILE"
T_ATTACHMENT = "DATA_CLEANSE_CERT_ATTACHMENT"

# Private root: not reachable with the browser's storage rights, only through
# links this module signs after the role check.
ATTACHMENT_PREFIX = f"{api_util.PRIVATE_ROOT}/Certifications"
REPORT_PREFIX = f"{api_util.PRIVATE_ROOT}/Reports"
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_KEY_LENGTH = 600
CERT_TYPES = ("FILE", "VALIDATION")

# Cycles outside the usual MOCKnn[HCM][PRE] shape that have a setup table.
_EXTRA_MOCKS = ("MOCK14DV",)
_LOCATION = re.compile(r"^SETUP_DATA_CLEANSE_FILE_LOCATION_(MOCK\d{1,2}(HCM)?(PRE\d*)?|MOCK14DV)$", re.I)

_DDL = {
    T_VALIDATION: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [BU] VARCHAR(100) NOT NULL, [Validation_Code] NVARCHAR(50) NOT NULL, "
        "[Path_Forward] NVARCHAR(MAX) NULL, [Notes] NVARCHAR(MAX) NULL, [Error_Count] INT NULL, "
        "[Certified_By] NVARCHAR(200) NULL, [Certified_DTTM] DATETIME NULL, "
        "[Is_Current] BIT NOT NULL DEFAULT 1, "
        "[Revoked_By] NVARCHAR(200) NULL, [Revoked_DTTM] DATETIME NULL, [Revoke_Reason] NVARCHAR(MAX) NULL"),
    T_FILE: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [BU] VARCHAR(100) NOT NULL, [Entity] VARCHAR(50) NOT NULL, "
        "[File_Type] VARCHAR(30) NOT NULL, [Notes] NVARCHAR(MAX) NULL, "
        "[Certified_By] NVARCHAR(200) NULL, [Certified_DTTM] DATETIME NULL, "
        "[Is_Current] BIT NOT NULL DEFAULT 1, "
        "[Revoked_By] NVARCHAR(200) NULL, [Revoked_DTTM] DATETIME NULL, [Revoke_Reason] NVARCHAR(MAX) NULL"),
    T_ATTACHMENT: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [BU] VARCHAR(100) NOT NULL, [Cert_Type] VARCHAR(20) NOT NULL, "
        "[Cert_Key] NVARCHAR(200) NOT NULL, [File_Name] NVARCHAR(300) NOT NULL, [S3_Key] NVARCHAR(600) NOT NULL, "
        "[Size_Bytes] BIGINT NULL, [Uploaded_By] NVARCHAR(200) NULL, [Uploaded_DTTM] DATETIME NULL, "
        "[Deleted] BIT NOT NULL DEFAULT 0"),
}


# ── small pure helpers ───────────────────────────────────────────────────────

def _s(value):
    return str(value if value is not None else "").strip()


def _k(*parts):
    """Case- and padding-insensitive key for matching rows across tables."""
    return tuple(_s(p).upper() for p in parts)


def _mock(value):
    token = _s(value).upper()
    return token if token in _EXTRA_MOCKS else api_util.mock(value)


def party_name(source, agency):
    """The certifying party: the Agency, or the Source when there is none."""
    return _s(agency) or _s(source)


def file_cert_key(entity, file_type):
    return f"{_s(entity)}|{_s(file_type)}"


def party_prefix(mock, source, agency, bu):
    """S3 folder that holds one party's certification documents."""
    seg = "_".join([api_util.safe_segment(source, "NA"), api_util.safe_segment(agency or "NA", "NA"),
                    api_util.safe_segment(bu or "NA", "NA")])
    return f"{ATTACHMENT_PREFIX}/{mock}/{seg}/"


def cert_prefix(mock, source, agency, bu, cert_type, cert_key):
    return f"{party_prefix(mock, source, agency, bu)}{cert_type}/{api_util.safe_segment(cert_key)}/"


def attachment_key(mock, source, agency, bu, cert_type, cert_key, file_name, when=None):
    when = when or datetime.now()
    return (cert_prefix(mock, source, agency, bu, cert_type, cert_key)
            + f"{when.strftime('%Y%m%d-%H%M%S')}_{api_util.safe_segment(file_name, 'file')}")


def report_key(mock, when=None):
    when = when or datetime.now()
    name = f"Certification_Status_{mock}_{when.strftime('%Y.%m.%d-%H.%M.%S')}.xlsx"
    # The object name is unique per request: a report is filtered to its
    # caller, so two requests must never share (and overwrite) one key.
    return f"{REPORT_PREFIX}/{mock}/Certification/{name[:-5]}_{uuid.uuid4().hex[:8]}.xlsx", name


def sort_mocks(tokens):
    """HCM phase-2 cycles first, newest first within each family."""
    def key(tok):
        return (0 if "HCM" in tok else 1, -int(re.search(r"\d+", tok).group()), tok)
    return sorted(set(tokens), key=key)


def validations_for(reported, source, bu):
    """{code: count} of what the log reports to one party: same Source and,
    when the party has a BU, the same first three BU characters."""
    by_bu = reported.get(_s(source).upper(), {})
    bu3 = _s(bu)[:3].upper()
    out = {}
    for log_bu3, codes in by_bu.items():
        if bu3 and log_bu3 != bu3:
            continue
        for code, n in codes.items():
            out[code] = out.get(code, 0) + n
    return out


def status_of(done, total):
    if total and done >= total:
        return "Complete"
    return "In progress" if done else "Not started"


def _pct(done, total):
    return round(100.0 * done / total, 1) if total else 0.0


# ── database helpers ─────────────────────────────────────────────────────────

def _existing(cur, db, names):
    marks = ", ".join("?" for _ in names)
    cur.execute(f"SELECT name FROM [{db}].sys.objects WHERE name IN ({marks})", tuple(names))
    return {r[0].upper() for r in cur.fetchall()}


def _columns(cur, table):
    cur.execute(f"SELECT COLUMN_NAME FROM [{DB}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?", (table,))
    return {r[0].upper() for r in cur.fetchall()}


_REVOKE_COLUMNS = (("Revoked_By", "NVARCHAR(200)"), ("Revoked_DTTM", "DATETIME"), ("Revoke_Reason", "NVARCHAR(MAX)"))
_TABLES_READY = False


def _ensure_tables(cur, conn):
    """Create the certification tables on first use (once per container) and
    add the revoke columns to tables created before they existed."""
    global _TABLES_READY
    if _TABLES_READY:
        return
    have = _existing(cur, DB, list(_DDL))
    for name, ddl in _DDL.items():
        if name.upper() not in have:
            cur.execute(f"CREATE TABLE [{DB}].dbo.[{name}] ({ddl})")
    for table in (T_VALIDATION, T_FILE):
        cols = _columns(cur, table)
        for col, sql_type in _REVOKE_COLUMNS:
            if col.upper() not in cols:
                cur.execute(f"ALTER TABLE [{DB}].dbo.[{table}] ADD [{col}] {sql_type} NULL")
    conn.commit()
    _TABLES_READY = True


def _ensure_team_objects(conn, cur, names, warnings):
    """Names (upper-cased) that exist in the application database. In a test
    database a missing one is cloned from the definitions of record; in
    production the team's objects are never created here."""
    have = _existing(cur, DB, names)
    missing = [n for n in names if n.upper() not in have]
    if not missing or not validation_seed.is_test_target():
        return have
    try:
        seeder = validation_seed.Seeder(conn)
        for name in missing:
            seeder.ensure(name)
        warnings.extend(f"Could not prepare {msg}" for msg in seeder.report["failed"])
    except Exception as e:  # noqa: BLE001 - reported to the caller as a warning
        conn.rollback()
        warnings.append(f"Could not prepare {', '.join(missing)} in {DB}: {str(e)[:200]}")
    return _existing(cur, DB, names)


def mocks_with_table(cur):
    cur.execute(f"SELECT name FROM [{SOURCE}].sys.tables WHERE name LIKE '{LOCATION_PREFIX}MOCK%'")
    return sort_mocks(m.group(1).upper() for m in (_LOCATION.match(r[0]) for r in cur.fetchall()) if m)


def _location_table(conn, cur, mock, warnings):
    """((table name, its column names), None) when the cycle has certifications
    set up, otherwise (None, payload for a friendly 'not available' answer)."""
    table = f"{LOCATION_PREFIX}{mock}"
    cycles = mocks_with_table(cur)
    if table.upper() in _existing(cur, DB, [table]) or (
            mock in cycles and table.upper() in _ensure_team_objects(conn, cur, [table], warnings)):
        have = _columns(cur, table)
        if "CERTIFICATIONREQUIRED" in have:
            return (table, have), None
        message = f"{table} has no CertificationRequired column, so nothing can be certified for {mock}."
    else:
        message = (f"Certifications are not set up for {mock} yet: {table} does not exist. "
                   "The validation team creates it when the cycle's expected files are defined.")
    return None, {"available": False, "mock": mock, "db": DB, "message": message,
                  "mocks_with_table": cycles, "warnings": warnings}


_LOCATION_COLUMNS = ["Pillar", "Source", "Agency", "BU", "File_Type", "Entity", "MODULE", "Response",
                     "Comments", "CertificationApplicable"]


def _required_rows(cur, location):
    """Rows of the setup table that require a certification."""
    table, have = location
    select = ", ".join(f"[{c}]" if c.upper() in have else f"NULL AS [{c}]" for c in _LOCATION_COLUMNS)
    cur.execute(
        f"SELECT {select} FROM [{DB}].dbo.[{table}] "
        "WHERE UPPER(LTRIM(RTRIM(ISNULL([CertificationRequired], '')))) = 'Y'")
    rows = []
    for r in cur.fetchall():
        rows.append({
            "pillar": _s(r[0]), "source": _s(r[1]), "agency": _s(r[2]), "bu": _s(r[3]),
            "file_type": _s(r[4]), "entity": _s(r[5]), "module": _s(r[6]), "response": _s(r[7]),
            "comments": _s(r[8]), "certification_applicable": _s(r[9]),
        })
    rows.sort(key=lambda r: _k(party_name(r["source"], r["agency"]), r["source"], r["bu"], r["entity"], r["file_type"]))
    return rows


def _parties(rows):
    seen, out = set(), []
    for r in rows:
        key = _k(r["source"], r["agency"], r["bu"])
        if key not in seen:
            seen.add(key)
            out.append({"source": r["source"], "agency": r["agency"], "bu": r["bu"],
                        "party": party_name(r["source"], r["agency"])})
    return sorted(out, key=lambda p: (p["party"].upper(), p["source"].upper(), p["bu"]))


def _file_certs(cur, mock):
    cur.execute(
        f"SELECT [Source], [Agency], [BU], [Entity], [File_Type], [Notes], [Certified_By], [Certified_DTTM] "
        f"FROM [{DB}].dbo.[{T_FILE}] WHERE [MOCK] = ? AND [Is_Current] = 1", (mock,))
    return {_k(*r[:5]): {"notes": r[5], "certified_by": r[6], "certified_at": r[7]} for r in cur.fetchall()}


def _validation_certs(cur, mock):
    cur.execute(
        f"SELECT [Source], [Agency], [BU], [Validation_Code], [Path_Forward], [Notes], [Error_Count], "
        f"[Certified_By], [Certified_DTTM] FROM [{DB}].dbo.[{T_VALIDATION}] WHERE [MOCK] = ? AND [Is_Current] = 1",
        (mock,))
    return {_k(*r[:4]): {"path_forward": r[4], "notes": r[5], "certified_count": r[6],
                         "certified_by": r[7], "certified_at": r[8]} for r in cur.fetchall()}


def _attachment_counts(cur, mock):
    cur.execute(
        f"SELECT [Source], [Agency], [BU], [Cert_Type], [Cert_Key], COUNT(*) FROM [{DB}].dbo.[{T_ATTACHMENT}] "
        "WHERE [MOCK] = ? AND [Deleted] = 0 GROUP BY [Source], [Agency], [BU], [Cert_Type], [Cert_Key]", (mock,))
    return {_k(*r[:5]): r[5] for r in cur.fetchall()}


def _reported(conn, cur, mock, warnings, source=None):
    """({SOURCE: {BU3: {code: count}}}, {CODE: catalog entry}) for the rules the
    catalog reports to agencies. Counts only — one aggregate over the log."""
    have = _ensure_team_objects(conn, cur, [LOG_TABLE, CATALOG_TABLE], warnings)
    if CATALOG_TABLE not in have:
        warnings.append(f"{CATALOG_TABLE} does not exist in {DB}; no validations can be listed.")
        return {}, {}
    cat_cols = _columns(cur, CATALOG_TABLE)
    if "AGENCYREPORTS" not in cat_cols:
        warnings.append(f"{CATALOG_TABLE} in {DB} has no AgencyReports column; no validations can be listed.")
        return {}, {}
    guidance = "[PATH_FORWARD]" if "PATH_FORWARD" in cat_cols else "NULL AS PATH_FORWARD"
    cur.execute(
        f"SELECT [VALIDATION_CODE], [ERROR_MESSAGE], [ERROR_MESSAGE_SPA], [ENTITY], [VALIDATION_TYPE], [Severity], "
        f"{guidance} FROM [{DB}].dbo.[{CATALOG_TABLE}] WHERE [AgencyReports] = 'Y'")
    catalog = {}
    for r in cur.fetchall():
        catalog.setdefault(_s(r[0]).upper(), {
            "message": r[1], "message_spa": r[2], "entity": r[3], "type": r[4],
            "severity": r[5], "guidance": r[6]})
    if LOG_TABLE not in have:
        warnings.append(f"{LOG_TABLE} does not exist in {DB}; no validations are reported.")
        return {}, catalog

    where, args = "d.[MOCK] = ?", [mock]
    if source:
        where += " AND d.[Source] = ?"
        args.append(source)
    cur.execute(
        f"SELECT d.[Source], LEFT(LTRIM(ISNULL(d.[BU], '')), 3), d.[Validation_Code], COUNT(*) "
        f"FROM [{DB}].dbo.[{LOG_TABLE}] d WHERE {where} "
        f"AND EXISTS (SELECT 1 FROM [{DB}].dbo.[{CATALOG_TABLE}] e "
        "WHERE e.[VALIDATION_CODE] = d.[Validation_Code] AND e.[AgencyReports] = 'Y') "
        "GROUP BY d.[Source], LEFT(LTRIM(ISNULL(d.[BU], '')), 3), d.[Validation_Code]", tuple(args))
    reported = {}
    for src, bu3, code, n in cur.fetchall():
        codes = reported.setdefault(_s(src).upper(), {}).setdefault(_s(bu3).upper(), {})
        codes[_s(code)] = codes.get(_s(code), 0) + n
    return reported, catalog


# ── access ───────────────────────────────────────────────────────────────────

class _Access:
    """What one caller may see or certify."""

    def __init__(self, email, *roles, what):
        self.email = _s(email)
        self.role = authz.require(self.email, *roles, what=what)
        self._memo = {}

    def party(self, source, agency, bu):
        if self.role != authz.AGENCY_USER:
            return True
        key = _k(source, agency, bu)
        if key not in self._memo:
            self._memo[key] = authz.can_act_on(self.email, source, agency, bu, _s(bu)[:3])
        return self._memo[key]

    def check(self, source, agency, bu):
        if not self.party(source, agency, bu):
            raise ApiError(f"{self.email} is not allowed to act for {party_name(source, agency)}", 403)


def _reader(email, what="viewing certifications"):
    return _Access(email, authz.AGENCY_USER, authz.CERT_REVIEWER, what=what)


def _certifier(email, what="certifying"):
    return _Access(email, authz.AGENCY_USER, what=what)


def _required_party(rows, source, agency, bu):
    """The party exactly as the setup table spells it (404 when nothing is
    required from it)."""
    wanted = _k(source, agency, bu)
    for r in rows:
        if _k(r["source"], r["agency"], r["bu"]) == wanted:
            return r["source"], r["agency"], r["bu"]
    raise ApiError(f"No certification is required from {party_name(source, agency)} (BU {_s(bu) or 'n/a'})", 404)


def _need(data, field, label=None, limit=None):
    value = _s(data.get(field))
    if not value:
        raise ApiError(f"{label or field} is required")
    if limit and len(value) > limit:
        raise ApiError(f"{label or field} is longer than {limit} characters")
    return value


def _cert_target(data):
    cert_type = _s(data.get("cert_type")).upper()
    if cert_type not in CERT_TYPES:
        raise ApiError("cert_type must be FILE or VALIDATION")
    return cert_type, _need(data, "cert_key", limit=200)


# ── status snapshot (dashboard + report) ─────────────────────────────────────

def _snapshot(conn, cur, mock, location, access, warnings):
    rows = [r for r in _required_rows(cur, location) if access.party(r["source"], r["agency"], r["bu"])]
    file_certs = _file_certs(cur, mock)
    validation_certs = _validation_certs(cur, mock)
    attachments = _attachment_counts(cur, mock)
    reported, catalog = _reported(conn, cur, mock, warnings)
    by_party = {}
    for r in rows:
        by_party.setdefault(_k(r["source"], r["agency"], r["bu"]), []).append(r)

    files, validations, parties = [], [], []
    for p in _parties(rows):
        src, agency, bu = p["source"], p["agency"], p["bu"]
        stamps, required, certified_files = [], set(), set()
        for r in by_party[_k(src, agency, bu)]:
            cert = file_certs.get(_k(src, agency, bu, r["entity"], r["file_type"]))
            files.append({**r, "party": p["party"], "certified": bool(cert), **(cert or {}),
                          "attachments": attachments.get(
                              _k(src, agency, bu, "FILE", file_cert_key(r["entity"], r["file_type"])), 0)})
            required.add(_k(r["entity"], r["file_type"]))
            if cert:
                certified_files.add(_k(r["entity"], r["file_type"]))
                stamps.append(cert["certified_at"])
        codes = validations_for(reported, src, bu)
        certified_validations = 0
        for code in sorted(codes):
            cert = validation_certs.get(_k(src, agency, bu, code))
            validations.append({**p, "validation_code": code, "count": codes[code],
                                **catalog.get(code.upper(), {}), "certified": bool(cert), **(cert or {}),
                                "attachments": attachments.get(_k(src, agency, bu, "VALIDATION", code), 0)})
            if cert:
                certified_validations += 1
                stamps.append(cert["certified_at"])
        done, total = len(certified_files) + certified_validations, len(required) + len(codes)
        parties.append({**p, "files_required": len(required), "files_certified": len(certified_files),
                        "validations_reported": len(codes), "validations_certified": certified_validations,
                        "pct": _pct(done, total), "last_activity": max(filter(None, stamps), default=None),
                        "status": status_of(done, total)})

    sums = {f: sum(p[f] for p in parties) for f in
            ("files_required", "files_certified", "validations_reported", "validations_certified")}
    totals = {"parties": len(parties), **sums,
              "pct_complete": _pct(sums["files_certified"] + sums["validations_certified"],
                                   sums["files_required"] + sums["validations_reported"])}
    return {"totals": totals, "parties": parties, "files": files, "validations": validations}


# ── status report workbook ───────────────────────────────────────────────────

def _xl(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, str):
        from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
        return ILLEGAL_CHARACTERS_RE.sub("", value)
    return value


def _sheet(ws, header, records, widths):
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    ws.append(header)
    for c in range(1, len(header) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = PatternFill("solid", fgColor="1F4E79")
        cell.font = Font(bold=True, color="FFFFFF")
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for rec in records:
        ws.append([_xl(v) for v in rec])
        for cell in ws[ws.max_row]:
            # Text typed by a user is never a formula.
            if isinstance(cell.value, str) and cell.value.startswith("="):
                cell.data_type = "s"
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{max(2, len(records) + 1)}"
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def build_status_workbook(mock, snapshot, generated_by, when=None):
    """Workbook bytes: Summary, File Certifications, Validation Certifications."""
    from openpyxl import Workbook
    from openpyxl.styles import Font
    when = when or datetime.now()
    wb = Workbook()

    ws = wb.active
    ws.title = "Summary"
    header = ["Party", "Source", "Agency", "BU", "Files Required", "Files Certified", "Validations Reported",
              "Validations Certified", "% Complete", "Status", "Last Activity"]
    parties = snapshot["parties"]
    _sheet(ws, header, [[p["party"], p["source"], p["agency"], p["bu"], p["files_required"], p["files_certified"],
                         p["validations_reported"], p["validations_certified"], p["pct"], p["status"],
                         p["last_activity"]] for p in parties], [34, 14, 34, 10, 14, 14, 18, 18, 12, 14, 20])
    t = snapshot["totals"]
    ws.append([])
    ws.append([f"Total ({t['parties']} parties)", "", "", "", t["files_required"], t["files_certified"],
               t["validations_reported"], t["validations_certified"], t["pct_complete"]])
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)
    ws.append([f"Certification status for {mock} generated {when.strftime('%Y-%m-%d %H:%M:%S')} by {generated_by}"])

    header = ["Party", "Source", "Agency", "BU", "Pillar", "Module", "Entity", "File Type", "Response",
              "Certification Applicable", "Status", "Certified By", "Certified At", "Notes", "Attachments"]
    _sheet(wb.create_sheet("File Certifications"), header,
           [[f["party"], f["source"], f["agency"], f["bu"], f["pillar"], f["module"], f["entity"], f["file_type"],
             f["response"], f["certification_applicable"], "Certified" if f["certified"] else "Pending",
             f.get("certified_by"), f.get("certified_at"), f.get("notes"), f["attachments"]]
            for f in snapshot["files"]], [34, 14, 34, 10, 12, 16, 26, 14, 18, 14, 12, 30, 20, 60, 12])

    header = ["Party", "Source", "Agency", "BU", "Validation Code", "Error Message", "Entity", "Validation Type",
              "Severity", "Error Count", "Status", "Path Forward", "Notes", "Certified By", "Certified At",
              "Error Count When Certified", "Attachments"]
    _sheet(wb.create_sheet("Validation Certifications"), header,
           [[v["party"], v["source"], v["agency"], v["bu"], v["validation_code"], v.get("message"), v.get("entity"),
             v.get("type"), v.get("severity"), v["count"], "Certified" if v["certified"] else "Pending",
             v.get("path_forward"), v.get("notes"), v.get("certified_by"), v.get("certified_at"),
             v.get("certified_count"), v["attachments"]]
            for v in snapshot["validations"]], [34, 14, 34, 10, 18, 60, 20, 16, 12, 12, 12, 50, 50, 30, 20, 14, 12])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ── actions ──────────────────────────────────────────────────────────────────

def _expected(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"))
    warnings = []
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        return api_util.ok(headers, unavailable)
    rows = [r for r in _required_rows(cur, location) if access.party(r["source"], r["agency"], r["bu"])]
    certs, attachments = _file_certs(cur, mock), _attachment_counts(cur, mock)
    out = []
    for r in rows:
        cert = certs.get(_k(r["source"], r["agency"], r["bu"], r["entity"], r["file_type"])) or {}
        out.append({**r, "certified": bool(cert), "certified_by": cert.get("certified_by"),
                    "certified_at": cert.get("certified_at"), "notes": cert.get("notes"),
                    "attachments": attachments.get(_k(r["source"], r["agency"], r["bu"], "FILE",
                                                      file_cert_key(r["entity"], r["file_type"])), 0)})
    return api_util.ok(headers, {"available": True, "mock": mock, "db": DB, "parties": _parties(rows),
                                 "rows": out, "warnings": warnings})


def _validations(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"))
    source, agency, bu = _need(p, "source"), _s(p.get("agency")), _s(p.get("bu"))
    warnings = []
    # Authorise on a party that really exists in the cycle's certification
    # list, never on the free-text values of the request.
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        raise ApiError(unavailable["message"], 404)
    source, agency, bu = _required_party(_required_rows(cur, location), source, agency, bu)
    access.check(source, agency, bu)
    reported, catalog = _reported(conn, cur, mock, warnings, source=source)
    codes = validations_for(reported, source, bu)
    certs, attachments = _validation_certs(cur, mock), _attachment_counts(cur, mock)
    out = []
    for code in sorted(codes):
        info = catalog.get(code.upper(), {})
        cert = certs.get(_k(source, agency, bu, code)) or {}
        out.append({"validation_code": code, "count": codes[code], "message": info.get("message"),
                    "message_spa": info.get("message_spa"), "entity": info.get("entity"), "type": info.get("type"),
                    "severity": info.get("severity"), "guidance": info.get("guidance"),
                    "certified": bool(cert), "path_forward": cert.get("path_forward"), "notes": cert.get("notes"),
                    "certified_by": cert.get("certified_by"), "certified_at": cert.get("certified_at"),
                    "certified_count": cert.get("certified_count"),
                    "attachments": attachments.get(_k(source, agency, bu, "VALIDATION", code), 0)})
    return api_util.ok(headers, {"mock": mock, "db": DB, "source": source, "agency": agency, "bu": bu,
                                 "party": party_name(source, agency), "validations": out, "warnings": warnings})


def _writable_party(conn, cur, data, what):
    """(access, mock, table rows, source, agency, bu) for a change: the caller
    may certify, the cycle is set up and the party is one that must certify."""
    access = _certifier(data.get("actor"), what)
    mock = _mock(data.get("mock"))
    source, agency, bu = _need(data, "source"), _s(data.get("agency")), _s(data.get("bu"))
    access.check(source, agency, bu)
    location, unavailable = _location_table(conn, cur, mock, [])
    if not location:
        raise ApiError(unavailable["message"], 404)
    rows = _required_rows(cur, location)
    source, agency, bu = _required_party(rows, source, agency, bu)
    return access, mock, rows, source, agency, bu


def _certify_validation(conn, cur, data, headers):
    access, mock, _, source, agency, bu = _writable_party(conn, cur, data, "certifying a validation")
    code = _need(data, "validation_code", "Validation code", 50)
    path_forward = _need(data, "path_forward", "Path forward")
    notes = _need(data, "notes", "Note")
    warnings = []
    reported, _ = _reported(conn, cur, mock, warnings, source=source)
    counts = {c.upper(): (c, n) for c, n in validations_for(reported, source, bu).items()}
    if code.upper() not in counts:
        raise ApiError(f"{code} is not reported to {party_name(source, agency)} for {mock}", 404)
    code, count = counts[code.upper()]
    cur.execute(
        f"UPDATE [{DB}].dbo.[{T_VALIDATION}] SET [Is_Current] = 0 WHERE [MOCK] = ? AND [Source] = ? "
        "AND [Agency] = ? AND [BU] = ? AND [Validation_Code] = ? AND [Is_Current] = 1",
        (mock, source, agency, bu, code))
    cur.execute(
        f"INSERT INTO [{DB}].dbo.[{T_VALIDATION}] ([MOCK], [Source], [Agency], [BU], [Validation_Code], "
        "[Path_Forward], [Notes], [Error_Count], [Certified_By], [Certified_DTTM], [Is_Current]) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 1)",
        (mock, source, agency, bu, code, path_forward, notes, count, access.email))
    conn.commit()
    return api_util.ok(headers, {"mock": mock, "source": source, "agency": agency, "bu": bu,
                                 "validation_code": code, "error_count": count, "certified_by": access.email})


def _certify_file(conn, cur, data, headers):
    access, mock, rows, source, agency, bu = _writable_party(conn, cur, data, "certifying a file")
    entity, file_type = _need(data, "entity", "Entity", 50), _need(data, "file_type", "File type", 30)
    notes = _need(data, "notes", "Notes")
    wanted = _k(source, agency, bu, entity, file_type)
    match = next((r for r in rows if _k(r["source"], r["agency"], r["bu"], r["entity"], r["file_type"]) == wanted), None)
    if not match:
        raise ApiError(f"{entity} ({file_type}) does not require a certification from "
                       f"{party_name(source, agency)} for {mock}", 404)
    entity, file_type = match["entity"], match["file_type"]
    cur.execute(
        f"UPDATE [{DB}].dbo.[{T_FILE}] SET [Is_Current] = 0 WHERE [MOCK] = ? AND [Source] = ? AND [Agency] = ? "
        "AND [BU] = ? AND [Entity] = ? AND [File_Type] = ? AND [Is_Current] = 1",
        (mock, source, agency, bu, entity, file_type))
    cur.execute(
        f"INSERT INTO [{DB}].dbo.[{T_FILE}] ([MOCK], [Source], [Agency], [BU], [Entity], [File_Type], [Notes], "
        "[Certified_By], [Certified_DTTM], [Is_Current]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 1)",
        (mock, source, agency, bu, entity, file_type, notes, access.email))
    conn.commit()
    return api_util.ok(headers, {"mock": mock, "source": source, "agency": agency, "bu": bu, "entity": entity,
                                 "file_type": file_type, "certified_by": access.email})


def _revoke(conn, cur, data, headers):
    """Withdraw the current certification of a file or a validation (super
    users only). The row stays as history, stamped with who revoked it and why."""
    actor = _s(data.get("actor"))
    authz.require(actor, what="revoking a certification")
    mock = _mock(data.get("mock"))
    source, agency, bu = _need(data, "source"), _s(data.get("agency")), _s(data.get("bu"))
    cert_type, cert_key = _cert_target(data)
    reason = _need(data, "reason", "Reason")
    if cert_type == "VALIDATION":
        table, where, params = T_VALIDATION, "[Validation_Code] = ?", (cert_key,)
    else:
        entity, _, file_type = cert_key.partition("|")
        table, where, params = T_FILE, "[Entity] = ? AND [File_Type] = ?", (entity, file_type)
    cur.execute(
        f"UPDATE [{DB}].dbo.[{table}] SET [Is_Current] = 0, [Revoked_By] = ?, [Revoked_DTTM] = GETDATE(), "
        f"[Revoke_Reason] = ? WHERE [MOCK] = ? AND [Source] = ? AND [Agency] = ? AND [BU] = ? AND {where} "
        "AND [Is_Current] = 1",
        (actor, reason, mock, source, agency, bu) + params)
    revoked = cur.rowcount
    conn.commit()
    if not revoked:
        raise ApiError("There is no current certification to revoke", 404)
    return api_util.ok(headers, {"revoked": revoked, "cert_type": cert_type, "cert_key": cert_key})


def _upload_url(conn, cur, data, bucket, headers):
    _, mock, _, source, agency, bu = _writable_party(conn, cur, data, "attaching a document")
    cert_type, cert_key = _cert_target(data)
    file_name = _need(data, "file_name", "File name", 300)
    content_type = _s(data.get("content_type")) or "application/octet-stream"
    try:
        size = int(data.get("size") or 0)
    except (TypeError, ValueError):
        raise ApiError("size must be a number of bytes")
    if size <= 0:
        raise ApiError(f"{file_name} is empty")
    if size > MAX_ATTACHMENT_BYTES:
        raise ApiError(f"{file_name} is larger than the {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB limit")
    key = attachment_key(mock, source, agency, bu, cert_type, cert_key, file_name)
    if len(key) > MAX_KEY_LENGTH:
        raise ApiError("The file name is too long")
    return api_util.ok(headers, {"key": key, "content_type": content_type,
                                 "url": api_util.presign_put(bucket, key, content_type)})


def _attachment_add(conn, cur, data, bucket, headers):
    access, mock, _, source, agency, bu = _writable_party(conn, cur, data, "attaching a document")
    cert_type, cert_key = _cert_target(data)
    key = _need(data, "key", limit=MAX_KEY_LENGTH)
    file_name = _need(data, "file_name", "File name", 300)
    prefix = cert_prefix(mock, source, agency, bu, cert_type, cert_key)
    if not key.startswith(prefix) or "/" in key[len(prefix):]:
        raise ApiError("The uploaded object does not belong to this certification", 403)
    size = api_util.object_size(bucket, key)
    if size is None:
        raise ApiError(f"{file_name} was not uploaded", 404)
    if size > MAX_ATTACHMENT_BYTES:
        raise ApiError(f"{file_name} is larger than the {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB limit")
    cur.execute(f"SELECT COUNT(*) FROM [{DB}].dbo.[{T_ATTACHMENT}] WHERE [S3_Key] = ? AND [Deleted] = 0", (key,))
    if cur.fetchone()[0]:
        raise ApiError(f"{file_name} is already attached", 409)
    cur.execute(
        f"INSERT INTO [{DB}].dbo.[{T_ATTACHMENT}] ([MOCK], [Source], [Agency], [BU], [Cert_Type], [Cert_Key], "
        "[File_Name], [S3_Key], [Size_Bytes], [Uploaded_By], [Uploaded_DTTM], [Deleted]) "
        "OUTPUT INSERTED.[ID] VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 0)",
        (mock, source, agency, bu, cert_type, cert_key, file_name, key, size, access.email))
    new_id = cur.fetchone()[0]
    conn.commit()
    return api_util.ok(headers, {"id": new_id, "file_name": file_name, "size": size})


def _attachments(cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"))
    source, agency, bu = _need(p, "source"), _s(p.get("agency")), _s(p.get("bu"))
    access.check(source, agency, bu)
    cert_type, cert_key = _cert_target(p)
    cur.execute(
        f"SELECT [ID], [File_Name], [Size_Bytes], [Uploaded_By], [Uploaded_DTTM] FROM [{DB}].dbo.[{T_ATTACHMENT}] "
        "WHERE [MOCK] = ? AND [Source] = ? AND [Agency] = ? AND [BU] = ? AND [Cert_Type] = ? AND [Cert_Key] = ? "
        "AND [Deleted] = 0 ORDER BY [ID]", (mock, source, agency, bu, cert_type, cert_key))
    items = [{"id": r[0], "file_name": r[1], "size": r[2], "uploaded_by": r[3], "uploaded_at": r[4]}
             for r in cur.fetchall()]
    return api_util.ok(headers, {"attachments": items})


def _attachment_row(cur, raw_id):
    try:
        att_id = int(raw_id)
    except (TypeError, ValueError):
        raise ApiError("id must be a number")
    cur.execute(
        f"SELECT [ID], [Source], [Agency], [BU], [File_Name], [S3_Key], [Uploaded_By] "
        f"FROM [{DB}].dbo.[{T_ATTACHMENT}] WHERE [ID] = ? AND [Deleted] = 0", (att_id,))
    row = cur.fetchone()
    if not row:
        raise ApiError("Attachment not found", 404)
    return row


def _download_url(cur, p, bucket, headers):
    access = _reader(p.get("email"), "downloading a certification document")
    row = _attachment_row(cur, p.get("id"))
    access.check(row[1], row[2], row[3])
    return api_util.ok(headers, {"id": row[0], "file_name": row[4],
                                 "url": api_util.presign_get(bucket, row[5], row[4])})


def _attachment_delete(conn, cur, data, headers):
    access = _certifier(data.get("actor"), "removing a certification document")
    row = _attachment_row(cur, data.get("id"))
    if access.role != authz.SUPER_USER and _s(row[6]).lower() != access.email.lower():
        raise ApiError("Only the person who uploaded a document, or a super user, can remove it", 403)
    cur.execute(f"UPDATE [{DB}].dbo.[{T_ATTACHMENT}] SET [Deleted] = 1 WHERE [ID] = ?", (row[0],))
    conn.commit()
    return api_util.ok(headers, {"id": row[0], "deleted": True})


def _status(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"), "viewing the certification status")
    warnings = []
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        return api_util.ok(headers, unavailable)
    snap = _snapshot(conn, cur, mock, location, access, warnings)
    return api_util.ok(headers, {"available": True, "mock": mock, "db": DB, "totals": snap["totals"],
                                 "parties": snap["parties"], "warnings": warnings})


def _status_report(conn, cur, data, bucket, headers):
    mock = _mock(data.get("mock"))
    access = _reader(data.get("actor"), "generating the certification status report")
    warnings = []
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        raise ApiError(unavailable["message"], 404)
    snap = _snapshot(conn, cur, mock, location, access, warnings)
    content = build_status_workbook(mock, snap, access.email)
    key, name = report_key(mock)
    import validation_report
    validation_report.write_report(bucket, key, content)
    return api_util.ok(headers, {"key": key, "name": name, "url": api_util.presign_get(bucket, key, name),
                                 "parties": snap["totals"]["parties"], "warnings": warnings})


def handle(action, event, bucket, headers, conn_str):
    def run():
        with pyodbc.connect(conn_str, autocommit=False) as conn:
            cur = conn.cursor()
            _ensure_tables(cur, conn)
            if action == "cert_expected":
                return _expected(conn, cur, api_util.params(event), headers)
            if action == "cert_validations":
                return _validations(conn, cur, api_util.params(event), headers)
            if action == "cert_attachments":
                return _attachments(cur, api_util.params(event), headers)
            if action == "cert_download_url":
                return _download_url(cur, api_util.params(event), bucket, headers)
            if action == "cert_status":
                return _status(conn, cur, api_util.params(event), headers)

            data = api_util.body(event)
            if action == "cert_certify_validation":
                return _certify_validation(conn, cur, data, headers)
            if action == "cert_certify_file":
                return _certify_file(conn, cur, data, headers)
            if action == "cert_upload_url":
                return _upload_url(conn, cur, data, bucket, headers)
            if action == "cert_attachment_add":
                return _attachment_add(conn, cur, data, bucket, headers)
            if action == "cert_attachment_delete":
                return _attachment_delete(conn, cur, data, headers)
            if action == "cert_status_report":
                return _status_report(conn, cur, data, bucket, headers)
            if action == "cert_revoke":
                return _revoke(conn, cur, data, headers)
            raise ApiError(f"Unknown action: {action}", 404)

    return api_util.guarded(run, headers)
