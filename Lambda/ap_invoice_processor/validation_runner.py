"""
validation_runner.py — run the SQL data validations from the app.

The validation logic itself lives in the conversion database as generated
views, one per rule x source x mock (FILEVAL_<family>_NN_<SOURCE>_<MOCK>_VW),
with the rule catalog in SETUP_ERROR_MESSAGES_SOURCE. Results are stored where
the existing validation programs already store theirs, so one review grid
covers every program:

  LOG_DATA_CLEANSE_RUNDTTM  one row per run (program, source, mock, when, who)
  LOG_DATA_CLEANSE          count per validation code (latest per code/mock/
                            source; an AFTER INSERT trigger keeps the history)
  LOG_DATA_CLEANSE_DETAIL   the failing rows (ERROR_MSG, Entity, File, ...,
                            Col1..Col30) — the same rows the Excel held

Two ways to run a program:
  mode "views": iterate the source's views here (what the box-side Python
      programs do) — Asset, Inventory, AP Invoice, AR Invoices, Customers,
      Supplier. Optional setup / post procedures mirror the box program.
  mode "sp":    call the team's own insert procedure, which discovers the
      views and fills LOG_DATA_CLEANSE_DETAIL itself — PO, Projects, Contracts,
      Requisition, GL, and the HCM / PAY / Benefits programs. Those procedures
      write only the detail rows, so the counts and the run stamp are added
      here afterwards.
Programs are keyed by the catalog's Validation_Program; `log_names` lists the
labels the log tables use for the same program (e.g. Contracts is logged as
BPA by the FSCM procedure).
"""
import re
from collections import Counter
from datetime import datetime

import pyodbc

DB = "Hacienda_ERP"
FSCM_SP = "SP_FSCM_INSERT_VALIDATION_ERRORS"
PREFIX_SP = "SP_INSERT_VALIDATION_ERRORS_V3"


def _views(families, setup_sp=None, post_sp=None):
    return {"mode": "views", "families": families, "setup_sp": setup_sp, "post_sp": post_sp}


def _sp(sp, label=None, families=(), log_names=()):
    return {"mode": "sp", "sp": sp, "label": label, "families": list(families), "log_names": list(log_names)}


PROGRAMS = {
    "Asset": _views(["FILEVAL_FIN_ASSETENTITY", "FILEVAL_FIN_ASSETS"], setup_sp="CreateAssetValidationSQLs"),
    "Inventory": _views(["FILEVAL_SCM_ITEMS_COUNT", "FILEVAL_SCM_ITEMS"], setup_sp="UpdateViewWithSource",
                        post_sp="UPDATE_{mock}_ITEMS_RECEIVED_ALL"),
    "AP Invoice": _views(["FILEVAL_FIN_AP_INVOICES"]),
    "AR Invoices": _views(["FILEVAL_FIN_AR_INVOICES"]),
    "Customers": _views(["FILEVAL_FIN_CUSTOMERS"]),
    "Supplier": _views(["FILEVAL_SCM_SUPPLIER"]),
    "PO": _sp(FSCM_SP, "PO", ["FILEVAL_SCM_PURCHASE_ORDER"]),
    "Projects": _sp(FSCM_SP, "Projects", ["FILEVAL_FIN_PG"], ["Projects POST", "Crosswalks"]),
    "Contracts": _sp(FSCM_SP, "BPA", ["FILEVAL_SCM_PROCUREMENT_CONTRACTS"], ["BPA"]),
    "Requisition": _sp(FSCM_SP, "REQ", ["FILEVAL_SCM_REQ"], ["REQ"]),
    "GL Balance": _sp(FSCM_SP, "GL Balances", ["FILEVAL_FIN_GL_BALANCES"], ["GL Balances"]),
    "GL Budget Balances": _sp(FSCM_SP, "GL Budget Balances", ["FILEVAL_FIN_GL_BUDGET"]),
}
for _p in ["HCM(01-50)", "HCM(51-100)", "HCM(101-150)", "HCM(151-200)", "HCM(201-250)",
           "HCM_ABS", "HCM_Entities", "PAY", "PAY(01-25)", "PAY(26-99)", "Benefits"]:
    PROGRAMS[_p] = _sp(PREFIX_SP, _p)

# View columns that map onto named LOG_DATA_CLEANSE_DETAIL columns; anything
# else lands in Col1..Col30 in view order.
_STANDARD = {
    "ERROR_MSG": "ERROR_MSG",
    "ENTITY": "Entity",
    "FILE": "File",
    "PROCESSED_DTTM": "File_PROCESSED_DTTM",
    "FILE_PROCESSED_DTTM": "File_PROCESSED_DTTM",
    "VALIDATION_TYPE": "VALIDATION_TYPE",
    "SOURCE": None,            # replaced by the run's source
    "VALIDATION_CODE": "Validation_Code",
    "BU": "BU",
    "PERSONNUMBER": "PersonNumber",
    "RECORD_COUNT": "RECORD_COUNT",
    "VALIDATION_PROGRAM": None,
}
_MAX_COLS = 30
_SAFE = re.compile(r"^[A-Za-z0-9_]+$")


def _check_ident(value, what):
    if not value or not _SAFE.match(value):
        raise ValueError(f"Invalid {what}: {value!r}")
    return value


def _log_names(program):
    spec = PROGRAMS.get(program, {})
    return [program] + [n for n in spec.get("log_names", []) if n != program]


def _in_clause(values):
    return "(" + ", ".join("?" for _ in values) + ")"


def _detail_lengths(cur):
    cur.execute(
        f"SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH FROM [{DB}].INFORMATION_SCHEMA.COLUMNS "
        f"WHERE TABLE_NAME = 'LOG_DATA_CLEANSE_DETAIL'"
    )
    return {r[0]: r[1] for r in cur.fetchall()}


def _clip(value, length):
    if value is None:
        return None
    s = str(value)
    if length and length > 0 and len(s) > length:
        return s[:length]
    return s


def _exec_sp(cur, conn, sql, params=()):
    cur.execute(sql, params)
    while cur.nextset():
        pass
    conn.commit()


def discover_views(cur, family, source, mock):
    """Views of one family for a source+mock, ordered by validation number."""
    cur.execute(
        f"SELECT name FROM [{DB}].sys.views WHERE name LIKE ?",
        (f"{family}_%_{source}_{mock}_VW",),
    )
    pat = re.compile(rf"^{re.escape(family)}_(\d+)_{re.escape(source)}_{re.escape(mock)}_VW$", re.I)
    found = []
    for (name,) in cur.fetchall():
        m = pat.match(name)
        if m:
            found.append((int(m.group(1)), name))
    return [n for _, n in sorted(found)]


def _sources_for(cur, program, spec, mock):
    """Sources the program can run for: those with views for this mock, plus
    those already logged (HCM/PAY sources only appear in the logs)."""
    sources = set()
    for family in spec.get("families", []):
        cur.execute(f"SELECT name FROM [{DB}].sys.views WHERE name LIKE ?", (f"{family}_%_{mock}_VW",))
        pat = re.compile(rf"^{re.escape(family)}_\d+_(.+)_{re.escape(mock)}_VW$", re.I)
        for (name,) in cur.fetchall():
            m = pat.match(name)
            # GL views carry a second number for 911 (FAMILY_911_NN_911_ / FAMILY_911_NN_),
            # which the pattern would read as a source — skip those artifacts.
            if m and not re.match(r"^\d{2}(_|$)", m.group(1)):
                sources.add(m.group(1))
    names = _log_names(program)
    for table, col in (("LOG_DATA_CLEANSE_RUNDTTM", "SOURCE"), ("LOG_DATA_CLEANSE", "SOURCE"),
                       ("LOG_DATA_CLEANSE_DETAIL", "Source")):
        cur.execute(
            f"SELECT DISTINCT [{col}] FROM [{DB}].dbo.{table} WHERE MOCK = ? AND Validation_Program IN {_in_clause(names)}",
            [mock] + names,
        )
        sources.update(r[0] for r in cur.fetchall() if r[0] and _SAFE.match(r[0]))
    return sorted(sources)


def list_programs(conn_str, mock="MOCK14"):
    mock = _check_ident(mock.upper(), "mock")
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT Validation_Program, COUNT(*) FROM [{DB}].dbo.SETUP_ERROR_MESSAGES_SOURCE "
            f"WHERE Validation_Program IS NOT NULL GROUP BY Validation_Program ORDER BY 1"
        )
        programs = []
        for prog, n in cur.fetchall():
            spec = PROGRAMS.get(prog)
            entry = {"program": prog, "rules": n, "runnable": spec is not None,
                     "mode": spec["mode"] if spec else None,
                     "runs_via": (spec.get("sp") if spec and spec["mode"] == "sp" else None),
                     "sources": _sources_for(cur, prog, spec, mock) if spec else []}
            programs.append(entry)
        return {"ok": True, "mock": mock, "programs": programs}


def run_program(conn_str, program, source, mock="MOCK14", actor="", dry_run=False,
                remaining_ms=None):
    """
    Run one program for one source. dry_run lists the views (and, in "views"
    mode, counts their rows) without writing anything. remaining_ms() (Lambda
    context) lets a long run stop cleanly and report the views it skipped.
    """
    spec = PROGRAMS.get(program)
    if not spec:
        return {"ok": False, "error": f"Program '{program}' is not runnable from the app"}
    source = _check_ident((source or "").strip().upper(), "source")
    mock = _check_ident((mock or "").strip().upper(), "mock")
    started = datetime.now()
    result = {
        "ok": True, "program": program, "source": source, "mock": mock, "mode": spec["mode"],
        "dry_run": bool(dry_run), "views": [], "warnings": [], "partial": False,
        "total_rows": 0, "started_at": started.isoformat(), "run_number": None, "codes": {},
    }
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        if spec["mode"] == "sp":
            _run_via_sp(cur, conn, spec, program, source, mock, actor, dry_run, result)
        else:
            _run_views(cur, conn, spec, program, source, mock, actor, dry_run, remaining_ms, result)
    result["elapsed_s"] = round((datetime.now() - started).total_seconds(), 1)
    return result


def _new_run(cur, conn, program, source, mock, actor, log_program):
    """Refresh + register a run: replace this program/source/mock's rows (the
    LOG trigger keeps the history), stamp LOG_DATA_CLEANSE_RUNDTTM, allocate
    the next RunNumber. Returns (run_number, run_dttm, bu)."""
    run_dttm = datetime.now().replace(microsecond=0)
    cur.execute(f"SELECT [{DB}].dbo.GetBUfromSource(?)", (source,))
    bu = cur.fetchone()[0]
    cur.execute(
        f"SELECT ISNULL(MAX(RunNumber), 0) FROM ("
        f"SELECT RunNumber FROM [{DB}].dbo.LOG_DATA_CLEANSE UNION ALL "
        f"SELECT RunNumber FROM [{DB}].dbo.LOG_DATA_CLEANSE_HISTORY) r"
    )
    run_number = int(cur.fetchone()[0] or 0) + 1
    cur.execute(
        f"DELETE FROM [{DB}].dbo.LOG_DATA_CLEANSE_DETAIL WHERE MOCK = ? AND [Source] = ? AND Validation_Program = ?",
        (mock, source, log_program),
    )
    cur.execute(
        f"DELETE FROM [{DB}].dbo.LOG_DATA_CLEANSE WHERE MOCK = ? AND [SOURCE] = ? AND Validation_Program = ?",
        (mock, source, log_program),
    )
    cur.execute(
        f"INSERT INTO [{DB}].dbo.LOG_DATA_CLEANSE_RUNDTTM (Validation_Program, SOURCE, MOCK, Validation_PROCESSED_DTTM, [User]) "
        f"VALUES (?, ?, ?, ?, ?)",
        (log_program, source, mock, run_dttm, (actor or "app")[:100]),
    )
    conn.commit()
    return run_number, run_dttm, bu


def _log_counts(cur, conn, codes, program, source, mock, bu, run_number, run_dttm, warnings):
    """One LOG_DATA_CLEANSE row per code (the INSTEAD OF trigger rejects codes
    missing from the catalog — logged as a warning, not a failure)."""
    for code, n in codes.items():
        try:
            cur.execute(
                f"INSERT INTO [{DB}].dbo.LOG_DATA_CLEANSE (Code, [Count], MOCK, [SOURCE], datetime_count, RunNumber, Validation_Program, BU) "
                f"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ((code or "")[:50], n, mock, source, run_dttm, run_number, program, bu),
            )
            conn.commit()
        except Exception as e:
            conn.rollback()
            warnings.append(f"count for '{code}' not logged: {str(e)[:160]}")


# ── mode "sp": the team's insert procedure ──────────────────────────────────

def _run_via_sp(cur, conn, spec, program, source, mock, actor, dry_run, result):
    label = spec["label"] or program
    views = []
    for family in spec["families"]:
        views.extend(discover_views(cur, family, source, mock))
    result["views"] = [{"view": v} for v in views]
    result["runs_via"] = spec["sp"]
    if dry_run:
        result["warnings"].append(
            f"Preview only lists the views; {spec['sp']} runs them all at once, so counts come from a real run"
        )
        return
    if spec["families"] and not views:
        result["ok"] = False
        result["error"] = f"No {program} validation views found for {source} / {mock}"
        return

    run_number, run_dttm, bu = _new_run(cur, conn, program, source, mock, actor, label)
    result["run_number"] = run_number
    result["run_dttm"] = run_dttm.isoformat()
    try:
        _exec_sp(cur, conn,
                 f"EXEC [{DB}].dbo.[{spec['sp']}] @REFRESH_TABLE = 1, @SOURCE = ?, @Validation_Program = ?, @MOCK = ?",
                 (source, label, mock))
    except Exception as e:
        conn.rollback()
        result["ok"] = False
        result["error"] = f"{spec['sp']} failed: {str(e)[:300]}"
        return
    # The procedure reports problems with PRINT, not errors: a run that inserted
    # nothing is surfaced as a warning so it isn't mistaken for a clean pass.
    cur.execute(
        f"SELECT Validation_Code, COUNT(*) FROM [{DB}].dbo.LOG_DATA_CLEANSE_DETAIL "
        f"WHERE MOCK = ? AND [Source] = ? AND Validation_Program = ? GROUP BY Validation_Code",
        (mock, source, label),
    )
    codes = Counter({(c or ""): int(n) for c, n in cur.fetchall()})
    result["codes"] = dict(codes)
    result["total_rows"] = sum(codes.values())
    if not codes:
        result["warnings"].append(
            f"{spec['sp']} stored no rows for {label} / {source} / {mock} — either no failures, or the "
            f"procedure rejected the source or program name (it reports that with PRINT, not an error)"
        )
    _log_counts(cur, conn, codes, label, source, mock, bu, run_number, run_dttm, result["warnings"])


# ── mode "views": iterate the views here ─────────────────────────────────────

def _run_views(cur, conn, spec, program, source, mock, actor, dry_run, remaining_ms, result):
    if spec["setup_sp"] and not dry_run:
        try:
            _exec_sp(cur, conn, f"EXEC [{DB}].dbo.[{spec['setup_sp']}] @SOURCE = ?, @Mock = ?", (source, mock))
        except Exception as e:
            conn.rollback()
            result["ok"] = False
            result["error"] = f"{spec['setup_sp']} failed: {str(e)[:300]}"
            return

    views = []
    for family in spec["families"]:
        views.extend(discover_views(cur, family, source, mock))
    if not views:
        result["ok"] = False
        result["error"] = f"No {program} validation views found for {source} / {mock}"
        return

    lengths = _detail_lengths(cur)
    run_number = run_dttm = bu = None
    if not dry_run:
        run_number, run_dttm, bu = _new_run(cur, conn, program, source, mock, actor, program)
        result["run_number"] = run_number
        result["run_dttm"] = run_dttm.isoformat()

    all_codes = Counter()
    for idx, view in enumerate(views):
        if remaining_ms and remaining_ms() < 60000:
            result["partial"] = True
            result["not_run"] = views[idx:]
            result["warnings"].append(
                f"Stopped before {len(views) - idx} view(s) to stay inside the Lambda time limit"
            )
            break
        entry = {"view": view, "rows": 0, "codes": {}}
        try:
            cur.execute(f"SELECT * FROM [{DB}].dbo.[{view}]")
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
        except Exception as e:
            entry["error"] = str(e)[:300]
            result["warnings"].append(f"{view}: {str(e)[:200]}")
            result["views"].append(entry)
            continue

        codes = Counter()
        code_idx = next((i for i, c in enumerate(cols) if c.upper().replace(" ", "_") == "VALIDATION_CODE"), None)
        msg_idx = next((i for i, c in enumerate(cols) if c.upper() == "ERROR_MSG"), None)
        for r in rows:
            code = None
            if code_idx is not None and r[code_idx]:
                code = str(r[code_idx]).strip()
            elif msg_idx is not None and r[msg_idx]:
                code = str(r[msg_idx]).split(":", 1)[0].strip()
            codes[code or ""] += 1
        entry["rows"] = len(rows)
        entry["codes"] = dict(codes)
        result["total_rows"] += len(rows)
        all_codes.update(codes)

        if not dry_run and rows:
            _store_rows(cur, conn, view, cols, rows, program, source, mock, bu, run_dttm, lengths, result["warnings"])
            _log_counts(cur, conn, codes, program, source, mock, bu, run_number, run_dttm, result["warnings"])
        result["views"].append(entry)
    result["codes"] = dict(all_codes)

    if spec["post_sp"] and not dry_run and not result["partial"]:
        sp = spec["post_sp"].format(mock=mock)
        try:
            _exec_sp(cur, conn, f"EXEC [{DB}].dbo.[{sp}]")
        except Exception as e:
            conn.rollback()
            result["warnings"].append(f"{sp} failed: {str(e)[:200]}")


def _store_rows(cur, conn, view, cols, rows, program, source, mock, bu, run_dttm, lengths, warnings):
    """Write one view's rows to LOG_DATA_CLEANSE_DETAIL."""
    targets = []
    used = set()
    extra = 0
    for c in cols:
        key = c.upper().replace(" ", "_")
        target = _STANDARD.get(key, "")
        if key in _STANDARD and target is None:
            targets.append(None)            # replaced by a run-level value below
        elif target and target not in used:
            targets.append(target)
            used.add(target)
        elif extra < _MAX_COLS:             # unmapped, or a second column for the same target
            extra += 1
            targets.append(f"Col{extra}")
        else:
            targets.append(None)
    keep = [i for i, t in enumerate(targets) if t]
    detail_cols = [targets[i] for i in keep]
    # Run-level values; a view's own BU wins over the source-derived one.
    fixed_cols = ["MOCK", "Validation_Program", "Validation_PROCESSED_DTTM", "Source"]
    has_bu = "BU" in used
    has_code = "Validation_Code" in used
    if not has_bu:
        fixed_cols.append("BU")
    if not has_code:
        fixed_cols.append("Validation_Code")
    all_cols = detail_cols + fixed_cols
    sql = (
        f"INSERT INTO [{DB}].dbo.LOG_DATA_CLEANSE_DETAIL ({', '.join(f'[{c}]' for c in all_cols)}) "
        f"VALUES ({', '.join('?' for _ in all_cols)})"
    )
    msg_idx = next((i for i, c in enumerate(cols) if c.upper() == "ERROR_MSG"), None)
    batch = []
    for r in rows:
        vals = [_clip(r[i], lengths.get(targets[i])) for i in keep]
        fixed = [mock, program, run_dttm, source]
        if not has_bu:
            fixed.append(bu)
        if not has_code:
            code = str(r[msg_idx]).split(":", 1)[0].strip() if msg_idx is not None and r[msg_idx] else None
            fixed.append(_clip(code, lengths.get("Validation_Code")))
        batch.append(tuple(vals + fixed))
    try:
        cur.fast_executemany = True
        for i in range(0, len(batch), 1000):
            cur.executemany(sql, batch[i:i + 1000])
        conn.commit()
    except Exception as e:
        conn.rollback()
        warnings.append(f"{view}: detail insert failed: {str(e)[:200]}")


# ── readers ──────────────────────────────────────────────────────────────────

def list_runs(conn_str, mock="MOCK14", program=None, limit=200):
    mock = _check_ident(mock.upper(), "mock")
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        sql = (
            f"SELECT TOP {int(limit)} Validation_Program, SOURCE, MOCK, Validation_PROCESSED_DTTM, [User] "
            f"FROM [{DB}].dbo.LOG_DATA_CLEANSE_RUNDTTM WHERE MOCK = ?"
        )
        params = [mock]
        if program:
            names = _log_names(program)
            sql += f" AND Validation_Program IN {_in_clause(names)}"
            params += names
        sql += " ORDER BY Validation_PROCESSED_DTTM DESC"
        cur.execute(sql, params)
        runs = [{"program": r[0], "source": r[1], "mock": r[2],
                 "at": r[3].isoformat() if r[3] else None, "user": r[4]} for r in cur.fetchall()]
    return {"ok": True, "runs": runs}


def summary(conn_str, mock, program, source=None):
    """Every catalog rule of a program with its latest count for the
    mock (and source, when given) — rules without a logged count show 0."""
    mock = _check_ident(mock.upper(), "mock")
    names = _log_names(program)
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT VALIDATION_CODE, ERROR_MESSAGE, ERROR_MESSAGE_SPA, ERROR_MESSAGE_LONG_DESCRIPTION, "
            f"ENTITY, VALIDATION_TYPE, Severity, Severity_Criteria, TransformationLogicApplied, "
            f"NotInScope, ValidationBeforeSend "
            f"FROM [{DB}].dbo.SETUP_ERROR_MESSAGES_SOURCE WHERE Validation_Program = ? ORDER BY VALIDATION_CODE",
            (program,),
        )
        rules = {}
        order = []
        for r in cur.fetchall():
            code = (r[0] or "").strip()
            order.append(code)
            rules[code] = {
                "code": code, "message": r[1], "message_spa": r[2], "long_description": r[3],
                "entity": r[4], "type": r[5], "severity": r[6], "severity_criteria": r[7],
                "transformation_logic": r[8], "not_in_scope": r[9], "before_send": r[10],
                "count": 0, "sources": {}, "last_run": None, "run_number": None,
            }
        sql = (
            f"SELECT Code, [Count], [SOURCE], datetime_count, RunNumber, BU "
            f"FROM [{DB}].dbo.LOG_DATA_CLEANSE WHERE MOCK = ? AND Validation_Program IN {_in_clause(names)}"
        )
        params = [mock] + names
        if source:
            sql += " AND [SOURCE] = ?"
            params.append(source)
        cur.execute(sql, params)
        unknown = []
        for code, n, src, at, run_no, bu in cur.fetchall():
            code = (code or "").strip()
            rule = rules.get(code)
            if not rule:
                unknown.append(code)
                continue
            rule["count"] += int(n or 0)
            rule["sources"][src] = int(n or 0)
            at_iso = at.isoformat() if at else None
            if not rule["last_run"] or (at_iso and at_iso > rule["last_run"]):
                rule["last_run"] = at_iso
                rule["run_number"] = run_no
        cur.execute(
            f"SELECT DISTINCT [SOURCE] FROM [{DB}].dbo.LOG_DATA_CLEANSE WHERE MOCK = ? AND Validation_Program IN {_in_clause(names)}",
            [mock] + names,
        )
        sources = sorted(r[0] for r in cur.fetchall() if r[0])
    return {"ok": True, "mock": mock, "program": program, "source": source,
            "rules": [rules[c] for c in order], "sources": sources,
            "unknown_codes": sorted(set(unknown))}


def detail(conn_str, mock, program, source=None, code=None, limit=200, offset=0):
    """Failing rows for a program (optionally one source / one code), paged."""
    mock = _check_ident(mock.upper(), "mock")
    names = _log_names(program)
    limit = max(1, min(int(limit or 200), 2000))
    offset = max(0, int(offset or 0))
    col_names = ["Col%d" % i for i in range(1, _MAX_COLS + 1)]
    base = ["ERROR_MSG", "Entity", "File", "File_PROCESSED_DTTM", "VALIDATION_TYPE", "Source",
            "Validation_Code", "BU", "Validation_PROCESSED_DTTM", "RECORD_COUNT"]
    where = f"WHERE MOCK = ? AND Validation_Program IN {_in_clause(names)}"
    params = [mock] + names
    if source:
        where += " AND [Source] = ?"
        params.append(source)
    if code:
        where += " AND Validation_Code = ?"
        params.append(code)
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) FROM [{DB}].dbo.LOG_DATA_CLEANSE_DETAIL {where}", params)
        total = cur.fetchone()[0]
        cur.execute(
            f"SELECT {', '.join(f'[{c}]' for c in base + col_names)} "
            f"FROM [{DB}].dbo.LOG_DATA_CLEANSE_DETAIL {where} "
            f"ORDER BY Validation_Code, ERROR_MSG OFFSET ? ROWS FETCH NEXT ? ROWS ONLY",
            params + [offset, limit],
        )
        rows = cur.fetchall()
    n_base = len(base)
    used = [i for i in range(_MAX_COLS) if any(r[n_base + i] not in (None, "") for r in rows)]
    out = []
    for r in rows:
        rec = {c: (r[i].isoformat() if hasattr(r[i], "isoformat") else r[i]) for i, c in enumerate(base)}
        rec["cols"] = [r[n_base + i] for i in used]
        out.append(rec)
    return {"ok": True, "total": total, "offset": offset, "limit": limit,
            "col_names": [col_names[i] for i in used], "rows": out}
