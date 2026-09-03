"""
validation_runner.py — run the SQL data validations from the app.

The validation logic itself lives in the conversion database as generated
views, one per rule x source x mock (FILEVAL_<family>_NN_<SOURCE>_<MOCK>_VW),
with the rule catalog in SETUP_ERROR_MESSAGES_SOURCE. The box-side Python
programs only iterate those views and dump Excel. This module does the same
iteration from the Lambda and stores results where the other validation
programs already store theirs, so one review grid covers every program:

  LOG_DATA_CLEANSE_RUNDTTM  one row per run (program, source, mock, when, who)
  LOG_DATA_CLEANSE          count per validation code (latest per code/mock/
                            source; an AFTER INSERT trigger keeps the history)
  LOG_DATA_CLEANSE_DETAIL   the failing rows (ERROR_MSG, Entity, File, ...,
                            Col1..Col30) — the same rows the Excel held

Only programs whose views the app can enumerate are runnable here; the
summary / detail readers work for every program in the catalog.
"""
import re
import traceback
from collections import Counter
from datetime import datetime

import pyodbc

DB = "Hacienda_ERP"

# Runnable programs: view families (in run order) + the setup procedure the
# box program executes first (it (re)generates the source's views). Names
# match Validation_Program in SETUP_ERROR_MESSAGES_SOURCE / LOG_DATA_CLEANSE.
PROGRAMS = {
    "Asset": {
        "families": ["FILEVAL_FIN_ASSETENTITY", "FILEVAL_FIN_ASSETS"],
        "setup_sp": "CreateAssetValidationSQLs",
        "post_sp": None,
    },
    "Inventory": {
        "families": ["FILEVAL_SCM_ITEMS_COUNT", "FILEVAL_SCM_ITEMS"],
        "setup_sp": "UpdateViewWithSource",
        "post_sp": "UPDATE_{mock}_ITEMS_RECEIVED_ALL",
    },
}

# View columns that map onto named LOG_DATA_CLEANSE_DETAIL columns; anything
# else lands in Col1..Col30 in view order.
_STANDARD = {
    "ERROR_MSG": "ERROR_MSG",
    "ENTITY": "Entity",
    "FILE": "File",
    "PROCESSED_DTTM": "File_PROCESSED_DTTM",
    "FILE_PROCESSED_DTTM": "File_PROCESSED_DTTM",
    "VALIDATION_TYPE": "VALIDATION_TYPE",
    "SOURCE": "Source",
    "VALIDATION_CODE": "Validation_Code",
    "BU": "BU",
    "PERSONNUMBER": "PersonNumber",
    "RECORD_COUNT": "RECORD_COUNT",
}
_MAX_COLS = 30
_SAFE = re.compile(r"^[A-Za-z0-9_]+$")


def _check_ident(value, what):
    if not value or not _SAFE.match(value):
        raise ValueError(f"Invalid {what}: {value!r}")
    return value


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


def list_programs(conn_str, mock="MOCK14"):
    """Every catalog program, with the sources the app can run (from the
    views that exist for this mock) for the runnable ones."""
    mock = _check_ident(mock.upper(), "mock")
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT Validation_Program, COUNT(*) FROM [{DB}].dbo.SETUP_ERROR_MESSAGES_SOURCE "
            f"WHERE Validation_Program IS NOT NULL GROUP BY Validation_Program ORDER BY 1"
        )
        programs = []
        for prog, n in cur.fetchall():
            entry = {"program": prog, "rules": n, "runnable": prog in PROGRAMS, "sources": []}
            if prog in PROGRAMS:
                family = PROGRAMS[prog]["families"][-1]
                cur.execute(
                    f"SELECT name FROM [{DB}].sys.views WHERE name LIKE ?",
                    (f"{family}_%_{mock}_VW",),
                )
                pat = re.compile(rf"^{re.escape(family)}_\d+_(.+)_{re.escape(mock)}_VW$", re.I)
                sources = set()
                for (name,) in cur.fetchall():
                    m = pat.match(name)
                    if m:
                        sources.add(m.group(1))
                entry["sources"] = sorted(sources)
            programs.append(entry)
        # Sources with staging data but no views yet (a new office) can still be
        # run: the setup procedure generates the views from the staging table.
        return {"ok": True, "mock": mock, "programs": programs}


def run_program(conn_str, program, source, mock="MOCK14", actor="", dry_run=False,
                remaining_ms=None):
    """
    Run one program for one source. dry_run iterates the views and returns the
    counts without touching the log tables. remaining_ms() (Lambda context)
    lets a long run stop cleanly and report which views it did not reach.
    """
    if program not in PROGRAMS:
        return {"ok": False, "error": f"Program '{program}' is not runnable from the app"}
    spec = PROGRAMS[program]
    source = _check_ident((source or "").strip().upper(), "source")
    mock = _check_ident((mock or "").strip().upper(), "mock")
    started = datetime.now()
    result = {
        "ok": True, "program": program, "source": source, "mock": mock,
        "dry_run": bool(dry_run), "views": [], "warnings": [], "partial": False,
        "total_rows": 0, "started_at": started.isoformat(),
    }

    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()

        # 1. Setup procedure — (re)generates this source's views from its
        #    staging table, exactly as the box program does before iterating.
        if spec["setup_sp"] and not dry_run:
            try:
                cur.execute(f"EXEC [{DB}].dbo.[{spec['setup_sp']}] @SOURCE = ?, @Mock = ?", (source, mock))
                while cur.nextset():
                    pass
                conn.commit()
            except Exception as e:
                conn.rollback()
                return {"ok": False, "error": f"{spec['setup_sp']} failed: {e}"}

        views = []
        for family in spec["families"]:
            views.extend(discover_views(cur, family, source, mock))
        if not views:
            return {"ok": False, "error": f"No {program} validation views found for {source} / {mock}"}

        lengths = _detail_lengths(cur)
        run_dttm = datetime.now().replace(microsecond=0)
        run_number = None
        bu = None

        if not dry_run:
            cur.execute(f"SELECT [{DB}].dbo.GetBUfromSource(?)", (source,))
            bu = cur.fetchone()[0]
            cur.execute(
                f"SELECT ISNULL(MAX(RunNumber), 0) FROM ("
                f"SELECT RunNumber FROM [{DB}].dbo.LOG_DATA_CLEANSE UNION ALL "
                f"SELECT RunNumber FROM [{DB}].dbo.LOG_DATA_CLEANSE_HISTORY) r"
            )
            run_number = int(cur.fetchone()[0] or 0) + 1
            # Refresh semantics (same as the shared insert procedures): replace
            # this program+source+mock's rows; the LOG trigger keeps history.
            cur.execute(
                f"DELETE FROM [{DB}].dbo.LOG_DATA_CLEANSE_DETAIL WHERE MOCK = ? AND [Source] = ? AND Validation_Program = ?",
                (mock, source, program),
            )
            cur.execute(
                f"DELETE FROM [{DB}].dbo.LOG_DATA_CLEANSE WHERE MOCK = ? AND [SOURCE] = ? AND Validation_Program = ?",
                (mock, source, program),
            )
            cur.execute(
                f"INSERT INTO [{DB}].dbo.LOG_DATA_CLEANSE_RUNDTTM (Validation_Program, SOURCE, MOCK, Validation_PROCESSED_DTTM, [User]) "
                f"VALUES (?, ?, ?, ?, ?)",
                (program, source, mock, run_dttm, (actor or "app")[:100]),
            )
            conn.commit()
        result["run_number"] = run_number
        result["run_dttm"] = run_dttm.isoformat()

        # 2. Iterate the views.
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

            if not dry_run and rows:
                _store_view(cur, conn, view, cols, rows, codes, program, source, mock,
                            bu, run_number, run_dttm, lengths, result["warnings"])
            result["views"].append(entry)

        # 3. Post step (Inventory rebuilds the consolidated ITEMS_RECEIVED_ALL).
        if spec["post_sp"] and not dry_run and not result["partial"]:
            sp = spec["post_sp"].format(mock=mock)
            try:
                cur.execute(f"EXEC [{DB}].dbo.[{sp}]")
                while cur.nextset():
                    pass
                conn.commit()
            except Exception as e:
                conn.rollback()
                result["warnings"].append(f"{sp} failed: {str(e)[:200]}")

    result["elapsed_s"] = round((datetime.now() - started).total_seconds(), 1)
    result["codes"] = dict(sum((Counter(v["codes"]) for v in result["views"]), Counter()))
    return result


def _store_view(cur, conn, view, cols, rows, codes, program, source, mock, bu,
                run_number, run_dttm, lengths, warnings):
    """Write one view's rows to LOG_DATA_CLEANSE_DETAIL and its counts to
    LOG_DATA_CLEANSE."""
    # Column map: view column -> detail column
    targets = []
    extra = 0
    for c in cols:
        key = c.upper().replace(" ", "_")
        if key in _STANDARD:
            targets.append(_STANDARD[key])
        elif extra < _MAX_COLS:
            extra += 1
            targets.append(f"Col{extra}")
        else:
            targets.append(None)
    has_code = "Validation_Code" in targets
    keep = [i for i, t in enumerate(targets) if t]
    detail_cols = [targets[i] for i in keep]
    fixed_cols = ["MOCK", "Validation_Program", "Validation_PROCESSED_DTTM", "BU", "SourceValidations"]
    if not has_code:
        fixed_cols.append("Validation_Code")
    if "Source" not in detail_cols:
        fixed_cols.append("Source")
    all_cols = detail_cols + fixed_cols
    sql = (
        f"INSERT INTO [{DB}].dbo.LOG_DATA_CLEANSE_DETAIL ({', '.join(f'[{c}]' for c in all_cols)}) "
        f"VALUES ({', '.join('?' for _ in all_cols)})"
    )
    msg_idx = next((i for i, c in enumerate(cols) if c.upper() == "ERROR_MSG"), None)
    batch = []
    for r in rows:
        vals = [_clip(r[i], lengths.get(targets[i])) for i in keep]
        fixed = [mock, program, run_dttm, bu, None]
        if not has_code:
            code = str(r[msg_idx]).split(":", 1)[0].strip() if msg_idx is not None and r[msg_idx] else None
            fixed.append(_clip(code, lengths.get("Validation_Code")))
        if "Source" not in detail_cols:
            fixed.append(source)
        batch.append(tuple(vals + fixed))
    try:
        cur.fast_executemany = True
        for i in range(0, len(batch), 1000):
            cur.executemany(sql, batch[i:i + 1000])
        conn.commit()
    except Exception as e:
        conn.rollback()
        warnings.append(f"{view}: detail insert failed: {str(e)[:200]}")
        return

    # Counts (one row per code; the INSTEAD OF trigger rejects unknown codes).
    for code, n in codes.items():
        try:
            cur.execute(
                f"INSERT INTO [{DB}].dbo.LOG_DATA_CLEANSE (Code, [Count], MOCK, [SOURCE], datetime_count, RunNumber, Validation_Program, BU) "
                f"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (code[:50], n, mock, source, run_dttm, run_number, program, bu),
            )
            conn.commit()
        except Exception as e:
            conn.rollback()
            warnings.append(f"{view}: count for '{code}' not logged: {str(e)[:160]}")


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
            sql += " AND Validation_Program = ?"
            params.append(program)
        sql += " ORDER BY Validation_PROCESSED_DTTM DESC"
        cur.execute(sql, params)
        runs = [{"program": r[0], "source": r[1], "mock": r[2],
                 "at": r[3].isoformat() if r[3] else None, "user": r[4]} for r in cur.fetchall()]
    return {"ok": True, "runs": runs}


def summary(conn_str, mock, program, source=None):
    """Every catalog rule of a program with its latest count for the
    mock (and source, when given) — rules without a logged count show 0."""
    mock = _check_ident(mock.upper(), "mock")
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
            f"FROM [{DB}].dbo.LOG_DATA_CLEANSE WHERE MOCK = ? AND Validation_Program = ?"
        )
        params = [mock, program]
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
        # Sources that have any result for this program/mock (for the filter).
        cur.execute(
            f"SELECT DISTINCT [SOURCE] FROM [{DB}].dbo.LOG_DATA_CLEANSE WHERE MOCK = ? AND Validation_Program = ?",
            (mock, program),
        )
        sources = sorted(r[0] for r in cur.fetchall() if r[0])
    return {"ok": True, "mock": mock, "program": program, "source": source,
            "rules": [rules[c] for c in order], "sources": sources,
            "unknown_codes": sorted(set(unknown))}


def detail(conn_str, mock, program, source=None, code=None, limit=200, offset=0):
    """Failing rows for a program (optionally one source / one code), paged."""
    mock = _check_ident(mock.upper(), "mock")
    limit = max(1, min(int(limit or 200), 2000))
    offset = max(0, int(offset or 0))
    col_names = ["Col%d" % i for i in range(1, _MAX_COLS + 1)]
    base = ["ERROR_MSG", "Entity", "File", "File_PROCESSED_DTTM", "VALIDATION_TYPE", "Source",
            "Validation_Code", "BU", "Validation_PROCESSED_DTTM", "RECORD_COUNT"]
    where = "WHERE MOCK = ? AND Validation_Program = ?"
    params = [mock, program]
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
    # Drop Col columns that are empty across the page so the grid stays tight.
    n_base = len(base)
    used = [i for i in range(_MAX_COLS) if any(r[n_base + i] not in (None, "") for r in rows)]
    out = []
    for r in rows:
        rec = {c: (r[i].isoformat() if hasattr(r[i], "isoformat") else r[i]) for i, c in enumerate(base)}
        rec["cols"] = [r[n_base + i] for i in used]
        out.append(rec)
    return {"ok": True, "total": total, "offset": offset, "limit": limit,
            "col_names": [col_names[i] for i in used], "rows": out}
