"""
validation_seed.py — provision a test database for the validation program.

The definitions of record live in Hacienda_ERP (SOURCE_DB): the rule catalog,
the FILEVAL views, the setup / insert procedures and the functions they use.
When validation is pointed at another database for testing (VALIDATION_DB),
that database starts without any of it. This module creates what a run needs,
on demand and idempotently, by cloning from the source database:

  tables      schema cloned; rows copied only for configuration tables
              (SETUP_*, STAGE, SETUP_ERROR_MESSAGES_SOURCE) — never for data
  modules     views / functions / procedures / triggers re-created from their
              definition, after whatever they reference has been created
  mock tables every table the mock's conversion plan lists, created empty,
              so procedures that walk the plan don't stop on a missing table

Nothing here runs when VALIDATION_DB is the source database itself.
"""
import os
import re
import time

import pyodbc

import api_util

SOURCE_DB = "Hacienda_ERP"
TARGET_DB = os.environ.get("VALIDATION_DB", SOURCE_DB)

RESULT_TABLES = ["LOG_DATA_CLEANSE", "LOG_DATA_CLEANSE_HISTORY", "LOG_DATA_CLEANSE_DETAIL",
                 "LOG_DATA_CLEANSE_RUNDTTM", "LAST_LOAD_BY_TABLE"]
CONFIG_TABLES = ["SETUP_ERROR_MESSAGES_SOURCE", "STAGE", "SETUP_BUSINESS_UNIT_MOCK9"]
CORE_FUNCTIONS = ["GetBUfromSource"]
_CREATE = re.compile(r"\bCREATE\s+(OR\s+ALTER\s+)?(PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER)\b", re.I)


def is_test_target():
    return TARGET_DB.upper() != SOURCE_DB.upper()


def _comment_spans(text):
    spans = []
    for m in re.finditer(r"/\*.*?\*/|--[^\r\n]*", text, re.S):
        spans.append((m.start(), m.end()))
    return spans


def _as_create_or_alter(definition):
    """Turn the module's real CREATE statement into CREATE OR ALTER — the
    first CREATE keyword that is not inside a comment (definitions often
    start with commented history that mentions 'create procedure')."""
    spans = _comment_spans(definition)
    for m in _CREATE.finditer(definition):
        if any(s <= m.start() < e for s, e in spans):
            continue
        return definition[:m.start()] + f"CREATE OR ALTER {m.group(2).upper()}" + definition[m.end():]
    return definition


# ── catalog lookups (source database) ────────────────────────────────────────

_TYPES_CACHE = None   # source object names, kept for the life of the container
_LEDGER_OK = False


class _Catalog:
    """Object names of the source database. Loaded once per container; the
    ~163,000 generated FILEVAL views are left out of the eager load (they are
    looked up individually when asked for) — loading them per call cost
    about 40 seconds."""

    def __init__(self, cur):
        global _TYPES_CACHE
        self.cur = cur
        if _TYPES_CACHE is None:
            cur.execute(
                f"SELECT name, type FROM [{SOURCE_DB}].sys.objects "
                f"WHERE type IN ('U','V','P','FN','IF','TF','TR') AND name NOT LIKE 'FILEVAL%'")
            _TYPES_CACHE = {name.upper(): t.strip() for name, t in cur.fetchall()}
        self.types = _TYPES_CACHE

    def type_of(self, name):
        key = name.upper()
        if key in self.types:
            return self.types[key]
        if key.startswith("FILEVAL"):
            self.cur.execute(f"SELECT type FROM [{SOURCE_DB}].sys.objects WHERE name = ?", (name,))
            r = self.cur.fetchone()
            if r:
                self.types[key] = r[0].strip()
                return self.types[key]
        return None

    def definition(self, name):
        self.cur.execute(
            f"SELECT m.definition FROM [{SOURCE_DB}].sys.objects o "
            f"JOIN [{SOURCE_DB}].sys.sql_modules m ON m.object_id = o.object_id WHERE o.name = ?", (name,))
        r = self.cur.fetchone()
        return r[0] if r else None

    def references(self, name, definition):
        """Objects a module depends on: the tracked dependencies plus any
        source-database object named in its text (dynamic SQL isn't tracked)."""
        found = set()
        self.cur.execute(
            f"SELECT referenced_entity_name FROM [{SOURCE_DB}].sys.sql_expression_dependencies "
            f"WHERE referencing_id = OBJECT_ID('{SOURCE_DB}.dbo.[{name}]') AND referenced_entity_name IS NOT NULL")
        found.update(r[0].upper() for r in self.cur.fetchall())
        for tok in set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", definition or "")):
            if tok.upper() in self.types:
                found.add(tok.upper())
        found.discard(name.upper())
        return found


# ── target-side helpers ──────────────────────────────────────────────────────

def _exists(cur, name):
    cur.execute("SELECT COUNT(*) FROM sys.objects WHERE name = ?", (name,))
    return cur.fetchone()[0] > 0


def _column_defs(cur, table):
    cur.execute(
        f"SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE "
        f"FROM [{SOURCE_DB}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? ORDER BY ORDINAL_POSITION", (table,))
    defs = []
    for col, dtype, clen, prec, scale, nullable in cur.fetchall():
        t = dtype.upper()
        if t in ("VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "VARBINARY", "BINARY"):
            t += "(MAX)" if clen == -1 else f"({clen})"
        elif t in ("DECIMAL", "NUMERIC"):
            t += f"({prec},{scale})"
        # Every column nullable: the clones are empty staging tables the app
        # fills (blanks become NULL) or configuration copies the app's own
        # trackers add rows to with only the columns they know.
        defs.append(f"[{col}] {t} NULL")
    return defs


def _relax_not_null(cur, conn, table):
    """Make every column of an existing target table nullable (see above)."""
    cur.execute(
        "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE "
        "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND IS_NULLABLE = 'NO'", (table,))
    for col, dtype, clen, prec, scale in cur.fetchall():
        t = dtype.upper()
        if t in ("VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "VARBINARY", "BINARY"):
            t += "(MAX)" if clen == -1 else f"({clen})"
        elif t in ("DECIMAL", "NUMERIC"):
            t += f"({prec},{scale})"
        cur.execute(f"ALTER TABLE [dbo].[{table}] ALTER COLUMN [{col}] {t} NULL")
    conn.commit()


def ensure_ledger(cursor):
    """The load ledger must exist in the target before a load writes to it.
    Checked once per container; nothing to do against the source database."""
    global _LEDGER_OK
    if _LEDGER_OK or not is_test_target():
        return
    if not _exists(cursor, "LAST_LOAD_BY_TABLE"):
        clone_table(cursor, cursor.connection, "LAST_LOAD_BY_TABLE")
    _LEDGER_OK = True


def clone_table(cur, conn, table, with_rows=False):
    """Create `table` in the target from the source's column definitions.
    Returns 'created', 'copied' (created + rows) or 'exists'."""
    if _exists(cur, table):
        return "exists"
    defs = _column_defs(cur, table)
    if not defs:
        raise ValueError(f"{table} does not exist in {SOURCE_DB}")
    cur.execute(f"CREATE TABLE [dbo].[{table}] (\n  " + ",\n  ".join(defs) + "\n)")
    conn.commit()
    if not with_rows:
        return "created"
    cur.execute(f"SELECT COLUMN_NAME FROM [{SOURCE_DB}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? ORDER BY ORDINAL_POSITION", (table,))
    cols = ", ".join(f"[{r[0]}]" for r in cur.fetchall())
    cur.execute(f"SELECT COUNT(*) FROM [{SOURCE_DB}].sys.identity_columns WHERE object_id = OBJECT_ID('{SOURCE_DB}.dbo.[{table}]')")
    has_identity = cur.fetchone()[0] > 0
    if has_identity:
        cur.execute(f"SET IDENTITY_INSERT [dbo].[{table}] ON")
    cur.execute(f"INSERT INTO [dbo].[{table}] ({cols}) SELECT {cols} FROM [{SOURCE_DB}].dbo.[{table}]")
    if has_identity:
        cur.execute(f"SET IDENTITY_INSERT [dbo].[{table}] OFF")
    conn.commit()
    return "copied"


def _is_config_table(name):
    u = name.upper()
    return u.startswith("SETUP_") or u in ("STAGE",)


class Seeder:
    """Creates objects in the target database from the source database."""

    def __init__(self, conn):
        self.conn = conn
        self.cur = conn.cursor()
        # Objects are created unqualified, i.e. in the connection's database:
        # refuse to seed unless that is the configured target.
        self.cur.execute("SELECT DB_NAME()")
        connected = self.cur.fetchone()[0]
        if connected.upper() != TARGET_DB.upper():
            raise ValueError(f"VALIDATION_DB is {TARGET_DB} but the connection is on {connected}")
        if not is_test_target():
            raise ValueError("Refusing to seed the source database")
        self.catalog = _Catalog(self.cur)
        self.done = set()
        self.report = {"created": [], "copied": [], "skipped": [], "failed": []}

    def ensure(self, name):
        """Create `name` (table, view, function, procedure) and what it
        references, once. Unknown names are ignored (they are tokens, not
        objects)."""
        key = name.upper()
        if key in self.done:
            return
        self.done.add(key)
        kind = self.catalog.type_of(name)
        if not kind:
            return
        try:
            if kind == "U":
                status = clone_table(self.cur, self.conn, name, with_rows=_is_config_table(name))
                self._note(status, name)
                return
            definition = self.catalog.definition(name)
            if not definition:
                return
            for ref in sorted(self.catalog.references(name, definition)):
                self.ensure(ref)
            if _exists(self.cur, name) and kind not in ("P",):
                # Views and functions are re-created only when absent; procedures
                # are always refreshed so fixes in the source flow through.
                self._note("exists", name)
                return
            if kind == "P" and _exists(self.cur, name):
                # ...but only when the source changed it: re-creating a procedure
                # another run is executing stops that run (error 2801).
                self.cur.execute("SELECT OBJECT_DEFINITION(OBJECT_ID(?))", (f"dbo.[{name}]",))
                if _definition_key(self.cur.fetchone()[0]) == _definition_key(definition):
                    self._note("exists", name)
                    return
            self.cur.execute(_as_create_or_alter(definition))
            self.conn.commit()
            self._note("created", name)
        except Exception as e:
            self.conn.rollback()
            self.report["failed"].append(f"{name}: {str(e)[:200]}")

    def ensure_trigger(self, table):
        self.cur.execute(
            f"SELECT t.name, m.definition FROM [{SOURCE_DB}].sys.triggers t "
            f"JOIN [{SOURCE_DB}].sys.sql_modules m ON m.object_id = t.object_id "
            f"WHERE t.parent_id = OBJECT_ID('{SOURCE_DB}.dbo.[{table}]')")
        for name, definition in self.cur.fetchall():
            if _exists(self.cur, name):
                continue
            try:
                self.cur.execute(_as_create_or_alter(definition))
                self.conn.commit()
                self._note("created", name)
            except Exception as e:
                self.conn.rollback()
                self.report["failed"].append(f"{name}: {str(e)[:200]}")

    def ensure_core(self):
        for t in CONFIG_TABLES + RESULT_TABLES:
            self.ensure(t)
        for f in CORE_FUNCTIONS:
            self.ensure(f)
        self.ensure_trigger("LOG_DATA_CLEANSE")
        self.ensure("LAST_LOAD_BY_TABLE_VW")

    def ensure_mock_tables(self, mock):
        """The mock's conversion plan and every table it lists, empty."""
        plan = f"SETUP_CONVERSION_PLAN_{mock}"
        self.ensure(plan)
        if not _exists(self.cur, plan):
            return
        # The app's own plan tracker inserts rows into this same table with
        # only the columns it knows; the source copy carried NOT NULL columns.
        _relax_not_null(self.cur, self.conn, plan)
        self.cur.execute(f"SELECT DISTINCT LTRIM(RTRIM(Table_Name)) FROM [dbo].[{plan}] WHERE Table_Name IS NOT NULL")
        for (name,) in self.cur.fetchall():
            if name and re.match(r"^[A-Za-z0-9_]+$", name) and self.catalog.type_of(name) == "U":
                self.ensure(name)
        # The setup procedures call the mock's helper procedures by a name built
        # at run time (EXEC 'UPDATE_' + @Mock + '_ASSET_RECEIVED_ALL'), which the
        # dependency scan cannot see — copy every UPDATE_<mock>_* procedure.
        for name in sorted(n for n, t in self.catalog.types.items()
                           if t == "P" and n.startswith(f"UPDATE_{mock.upper()}_")):
            self.ensure(name)

    def ensure_views(self, families, source, mock):
        """Copy the source's FILEVAL views for these families."""
        for family in families:
            self.cur.execute(f"SELECT name FROM [{SOURCE_DB}].sys.views WHERE name LIKE ?", (f"{family}_%_{source}_{mock}_VW",))
            for (name,) in self.cur.fetchall():
                self.ensure(name)

    def _note(self, status, name):
        if status == "exists":
            self.report["skipped"].append(name)
        else:
            self.report[status].append(name)

    def summary(self):
        return {k: (len(v) if k != "failed" else v) for k, v in self.report.items()} | {
            "created_names": self.report["created"][:60], "copied_names": self.report["copied"]}


def seed_for_run(conn_str, spec, source, mock, program=None):
    """Everything one program run needs in the test target. Returns the report."""
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        s = Seeder(conn)
        s.ensure_core()
        s.ensure_mock_tables(mock)
        for sp in [spec.get("setup_sp"), spec.get("sp"),
                   (spec.get("post_sp") or "").format(mock=mock) or None]:
            if sp:
                s.ensure(sp)
        if spec.get("families"):
            s.ensure_views(spec["families"], source, mock)
        elif program:
            # Catalog-driven programs (HCM / PAY / Benefits): the views are
            # named by the catalog, not by a family + source pattern.
            import validation_runner
            for view in validation_runner.catalog_views(s.cur, program, mock, db=SOURCE_DB):
                s.ensure(view)
        return s.summary()


def object_definition(conn_str, name):
    """Definition text of a source-database module and the objects it
    references (read-only)."""
    if not re.match(r"^[A-Za-z0-9_]+$", name or ""):
        return {"ok": False, "error": "invalid name"}
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cat = _Catalog(cur)
        kind = cat.type_of(name)
        if not kind:
            return {"ok": False, "error": f"{name} not found in {SOURCE_DB}"}
        definition = cat.definition(name) if kind != "U" else None
        refs = sorted(cat.references(name, definition)) if definition else []
        return {"ok": True, "name": name, "type": kind, "definition": definition,
                "references": [{"name": r, "type": cat.type_of(r)} for r in refs]}


def list_objects(conn_str, like, db=None):
    """Names and types of objects matching a LIKE pattern (read-only metadata),
    plus what the connected login may do to each table or view."""
    db = db or SOURCE_DB
    if not re.match(r"^[A-Za-z0-9_]+$", db) or not re.match(r"^[A-Za-z0-9_%\[\]\-]+$", like or ""):
        return {"ok": False, "error": "invalid pattern or database"}
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT TOP 400 name, type FROM [{db}].sys.objects "
            f"WHERE type IN ('U','V','P','FN','IF','TF') AND name LIKE ? ORDER BY name", (like,))
        rows = [(n, t.strip()) for n, t in cur.fetchall()]
        out = []
        for name, kind in rows:
            entry = {"name": name, "type": kind}
            if kind in ("U", "V") and len(rows) <= 40:
                for perm in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    cur.execute("SELECT HAS_PERMS_BY_NAME(?, 'OBJECT', ?)", (f"{db}.dbo.{name}", perm))
                    entry[perm.lower()] = cur.fetchone()[0]
            out.append(entry)
        return {"ok": True, "db": db, "objects": out}


def plan_gate_check(conn_str, mock, pairs):
    """What the file-expected gate will decide for (entity display, entity
    prefix, source) pairs, read from the target database's plan the same way
    process_single_file reads it (read-only)."""
    mock = re.sub(r"[^A-Za-z0-9_]", "", mock or "")
    plan = f"SETUP_CONVERSION_PLAN_{mock}"
    out = {"ok": True, "db": TARGET_DB, "plan": plan, "rows": []}
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) FROM [{TARGET_DB}].sys.tables WHERE name = ?", (plan,))
        out["plan_exists"] = cur.fetchone()[0] > 0
        for display, prefix, source in pairs:
            entry = {"entity": display, "prefix": prefix, "source": source, "matches": []}
            if out["plan_exists"]:
                cur.execute(
                    f"SELECT [Entity], [SubEntity], [Table_Name], [File_Expected], [ExcludedFromMock], "
                    f"[FileName], [LoadedAt], [LoadVersion], [ASSET_BOOK] "
                    f"FROM [{TARGET_DB}].dbo.[{plan}] "
                    f"WHERE LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ? AND ("
                    f"LTRIM(RTRIM(ISNULL([Entity], ''))) = ? OR LTRIM(RTRIM(ISNULL([SubEntity], ''))) = ? "
                    f"OR [Table_Name] LIKE ?)",
                    (source, display, prefix, f"{prefix}%_{mock}_{source}"),
                )
                for r in cur.fetchall():
                    entry["matches"].append({"entity": r[0], "sub_entity": r[1], "table": r[2],
                                             "file_expected": r[3], "excluded": r[4],
                                             "file_name": r[5], "loaded_at": r[6],
                                             "load_version": r[7], "asset_book": r[8]})
            # The gate's own rule: TOP 1 by Entity display + SOURCE; 'N' rejects.
            gate = [m for m in entry["matches"] if (m["entity"] or "").strip() == display]
            entry["gate"] = ("REJECT" if gate and (gate[0]["file_expected"] or "").strip().upper() == "N"
                             else "PASS")
            out["rows"].append(entry)
    return out


LOG_TABLES = ("LOG_DATA_CLEANSE_DETAIL", "LOG_DATA_CLEANSE")


def copy_log_rows(conn_str, mock, dry_run=False, source=None):
    """Copy one cycle's validation results from the source database into the
    test database so its screens show real data: the two log tables are
    created when missing, the cycle's rows in the target are replaced (only
    one source's rows when `source` is given). Rows never leave the server;
    only counts come back."""
    mock = re.sub(r"[^A-Za-z0-9_]", "", mock or "").upper()
    if not mock:
        raise ValueError("mock is required")
    if not is_test_target():
        raise ValueError("Validation points at the source database; nothing to copy")
    source = re.sub(r"[^A-Za-z0-9_]", "", source or "").upper() or None
    where, args = ("[MOCK] = ? AND [Source] = ?", (mock, source)) if source else ("[MOCK] = ?", (mock,))
    out = {"ok": True, "mock": mock, "source": source, "source_db": SOURCE_DB, "target_db": TARGET_DB,
           "dry_run": dry_run, "tables": {}}
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        seeder = None if dry_run else Seeder(conn)
        for table in LOG_TABLES:
            cur.execute(f"SELECT COUNT(*) FROM [{SOURCE_DB}].dbo.[{table}] WHERE {where}", args)
            entry = {"source_rows": cur.fetchone()[0], "target_rows": 0, "copied": 0}
            out["tables"][table] = entry
            if _exists(cur, table):
                cur.execute(f"SELECT COUNT(*) FROM [{TARGET_DB}].dbo.[{table}] WHERE {where}", args)
                entry["target_rows"] = cur.fetchone()[0]
            if dry_run:
                continue
            seeder.ensure(table)
            if table == "LOG_DATA_CLEANSE":
                seeder.ensure_trigger(table)
            cols = []
            for db in (SOURCE_DB, TARGET_DB):
                cur.execute(
                    f"SELECT c.name FROM [{db}].sys.columns c WHERE c.object_id = OBJECT_ID('{db}.dbo.[{table}]') "
                    f"AND c.is_identity = 0 AND c.is_computed = 0 ORDER BY c.column_id")
                cols.append({r[0].upper(): r[0] for r in cur.fetchall()})
            shared = ", ".join(f"[{cols[0][c]}]" for c in cols[0] if c in cols[1])
            cur.execute(f"DELETE FROM [{TARGET_DB}].dbo.[{table}] WHERE {where}", args)
            entry["removed"] = cur.rowcount
            if entry["source_rows"] == 0:
                # The team's INSTEAD OF trigger raises on an empty insert.
                conn.commit()
                continue
            cur.execute(f"INSERT INTO [{TARGET_DB}].dbo.[{table}] ({shared}) "
                        f"SELECT {shared} FROM [{SOURCE_DB}].dbo.[{table}] WHERE {where}", args)
            entry["copied"] = cur.rowcount
            conn.commit()
        if seeder:
            out["seeding"] = seeder.report
    return out


def _data_tables(cur, mock, programs):
    """User tables a mock's validation reads: everything the programs' views
    and procedure reach through other views and functions, less the
    configuration and result tables (seeding handles those)."""
    import validation_runner
    cat = _Catalog(cur)
    seen, tables = set(), set()

    def walk(name):
        key = name.upper()
        if key in seen:
            return
        seen.add(key)
        kind = cat.type_of(name)
        if kind == "U":
            tables.add(key)
        elif kind in ("V", "P", "FN", "IF", "TF"):
            for ref in cat.references(name, cat.definition(name)):
                walk(ref)

    for program in programs:
        walk(validation_runner.PROGRAMS[program].get("sp") or "")
        for view in validation_runner.catalog_views(cur, program, mock, db=SOURCE_DB):
            walk(view)
    skip = {t.upper() for t in CONFIG_TABLES + RESULT_TABLES}
    return sorted(t for t in tables if t not in skip and not _is_config_table(t))


def _sizes(cur, db, names):
    """{name: (rows, MB)} of the tables of `db` among names."""
    out = {}
    for i in range(0, len(names), 200):
        chunk = names[i:i + 200]
        marks = ", ".join("?" for _ in chunk)
        cur.execute(
            f"SELECT UPPER(o.name), SUM(p.rows) FROM [{db}].sys.objects o JOIN [{db}].sys.partitions p "
            f"ON p.object_id = o.object_id AND p.index_id IN (0, 1) WHERE o.type = 'U' AND o.name IN ({marks}) "
            f"GROUP BY o.name", chunk)
        rows = dict(cur.fetchall())
        cur.execute(
            f"SELECT UPPER(o.name), SUM(a.total_pages) * 8 / 1024.0 FROM [{db}].sys.objects o "
            f"JOIN [{db}].sys.partitions p ON p.object_id = o.object_id "
            f"JOIN [{db}].sys.allocation_units a ON a.container_id = p.partition_id "
            f"WHERE o.type = 'U' AND o.name IN ({marks}) GROUP BY o.name", chunk)
        for name, mb in cur.fetchall():
            out[name] = (rows.get(name, 0), round(float(mb or 0), 1))
    return out


def data_plan(conn_str, mock, programs=None):
    """What copying a mock's validation data into the test database means:
    every table its programs read, with rows and size in each database
    (metadata only, nothing is read from the tables)."""
    import validation_runner
    mock = re.sub(r"[^A-Za-z0-9_]", "", mock or "").upper()
    if not mock:
        raise ValueError("mock is required")
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        if not programs:
            phase_col = "Phase2" if api_util.is_hcm_mock(mock) else "Phase1"
            cur.execute(f"SELECT DISTINCT Validation_Program FROM [{SOURCE_DB}].dbo.SETUP_ERROR_MESSAGES_SOURCE "
                        f"WHERE {phase_col} = 'Yes'")
            programs = sorted(r[0] for r in cur.fetchall()
                              if r[0] in validation_runner.PROGRAMS
                              and validation_runner.PROGRAMS[r[0]].get("sp") == validation_runner.PREFIX_SP)
        tables = _data_tables(cur, mock, programs)
        source, target = _sizes(cur, SOURCE_DB, tables), _sizes(cur, TARGET_DB, tables)
        rows = [{"table": t, "source_rows": source.get(t, (None, None))[0], "source_mb": source.get(t, (None, None))[1],
                 "in_target": t in target, "target_rows": target.get(t, (None, None))[0]} for t in tables]
        return {"ok": True, "mock": mock, "programs": programs, "tables": rows,
                "total_rows": sum(r["source_rows"] or 0 for r in rows),
                "total_mb": round(sum(r["source_mb"] or 0 for r in rows), 1)}


# ── a cycle's real data in the test database ─────────────────────────────────
#
# For end-to-end testing the test database can hold a copy of one cycle's data
# for chosen sources: the tables its validations read (data_plan), copied rows
# and all inside the server, so nothing leaves it. Every step refuses to run
# unless validation points at a test database.

SETUP_REFRESH = ("SETUP_DATA_CLEANSE_FILE_LOCATION_{mock}", "SETUP_DATA_CLEANSE_FILE_DISTRIBUTION_{mock}",
                 "SETUP_ERROR_MESSAGES_SOURCE")


def _need_test_target():
    if not is_test_target():
        raise ValueError("Validation points at the source database; this only runs against a test database")


def _clean_mock(mock):
    mock = re.sub(r"[^A-Za-z0-9_]", "", mock or "").upper()
    if not mock:
        raise ValueError("mock is required")
    return mock


def _copy_rows(cur, conn, table):
    """Replace the target's rows of `table` with the source's, in the columns
    both have. Returns the number of rows copied."""
    cols = []
    for db in (SOURCE_DB, TARGET_DB):
        cur.execute(f"SELECT c.name, c.is_identity FROM [{db}].sys.columns c "
                    f"WHERE c.object_id = OBJECT_ID('{db}.dbo.[{table}]') AND c.is_computed = 0 ORDER BY c.column_id")
        cols.append({r[0].upper(): (r[0], bool(r[1])) for r in cur.fetchall()})
    shared = [cols[1][c] for c in cols[0] if c in cols[1]]
    names = ", ".join(f"[{name}]" for name, _ in shared)
    identity = any(is_identity for _, is_identity in shared)
    try:
        cur.execute(f"TRUNCATE TABLE [dbo].[{table}]")
    except pyodbc.Error:
        conn.rollback()
        cur.execute(f"DELETE FROM [dbo].[{table}]")
    if identity:
        cur.execute(f"SET IDENTITY_INSERT [dbo].[{table}] ON")
    cur.execute(f"INSERT INTO [dbo].[{table}] WITH (TABLOCK) ({names}) SELECT {names} FROM [{SOURCE_DB}].dbo.[{table}]")
    copied = cur.rowcount
    if identity:
        cur.execute(f"SET IDENTITY_INSERT [dbo].[{table}] OFF")
    conn.commit()
    return copied


def _known_sources(cur, mock, programs):
    """Every source the cycle knows: its file locations and its programs' sources."""
    import validation_runner
    found = set()
    cur.execute(f"SELECT name FROM [{SOURCE_DB}].sys.tables WHERE name = ?", (f"SETUP_DATA_CLEANSE_FILE_LOCATION_{mock}",))
    if cur.fetchone():
        cur.execute(f"SELECT DISTINCT UPPER(LTRIM(RTRIM([Source]))) FROM [{SOURCE_DB}].dbo.[SETUP_DATA_CLEANSE_FILE_LOCATION_{mock}]")
        found.update(r[0] for r in cur.fetchall() if r[0])
    for program in programs:
        found.update(s.upper() for s in validation_runner._sources_for(cur, program, validation_runner.PROGRAMS[program], mock))
    return {s for s in found if re.match(r"^[A-Z0-9_]+$", s)}


def table_sources(table, known):
    """The sources a table name belongs to (HCM_SALARY_MOCK13_RHUM -> {RHUM});
    empty for a table every source shares. A source inside a longer one that
    also matches (RHUM in DESTAQUE_RHUM) does not count."""
    name = table.upper()
    hits = {s for s in known if name.endswith("_" + s) or f"_{s}_" in name}
    return {s for s in hits if not any(s != o and s in o for o in hits)}


def _hcm_programs(cur, mock):
    import validation_runner
    phase_col = "Phase2" if api_util.is_hcm_mock(mock) else "Phase1"
    cur.execute(f"SELECT DISTINCT Validation_Program FROM [{SOURCE_DB}].dbo.SETUP_ERROR_MESSAGES_SOURCE WHERE {phase_col} = 'Yes'")
    return sorted(r[0] for r in cur.fetchall() if r[0] in validation_runner.PROGRAMS
                  and validation_runner.PROGRAMS[r[0]].get("sp") == validation_runner.PREFIX_SP)


def _tables_for(cur, mock, wanted):
    """The cycle's validation tables that are shared or belong to the wanted sources."""
    programs = _hcm_programs(cur, mock)
    known = _known_sources(cur, mock, programs) | wanted
    return [t for t in _data_tables(cur, mock, programs)
            if not table_sources(t, known) or table_sources(t, known) & wanted]


def _index_ddl(cur, table):
    """[(name, CREATE INDEX statement)] of the source table's row-store
    indexes, clustered first (primary keys and unique constraints become
    unique indexes)."""
    obj = f"OBJECT_ID('{SOURCE_DB}.dbo.[{table}]')"
    cur.execute(f"SELECT index_id, name, type, is_unique, has_filter, filter_definition FROM [{SOURCE_DB}].sys.indexes "
                f"WHERE object_id = {obj} AND type IN (1, 2) AND is_hypothetical = 0 AND is_disabled = 0 "
                f"ORDER BY type, index_id")
    out = []
    for index_id, name, kind, unique, has_filter, condition in cur.fetchall():
        cur.execute(f"SELECT c.name, ic.is_descending_key, ic.is_included_column FROM [{SOURCE_DB}].sys.index_columns ic "
                    f"JOIN [{SOURCE_DB}].sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                    f"WHERE ic.object_id = {obj} AND ic.index_id = ? "
                    f"ORDER BY ic.is_included_column, ic.key_ordinal, ic.index_column_id", (index_id,))
        cols = cur.fetchall()
        keys = ", ".join(f"[{c}]{' DESC' if desc else ''}" for c, desc, included in cols if not included)
        extra = ", ".join(f"[{c}]" for c, _, included in cols if included)
        if not keys:
            continue
        out.append((name, f"CREATE {'UNIQUE ' if unique else ''}{'CLUSTERED' if kind == 1 else 'NONCLUSTERED'} "
                          f"INDEX [{name}] ON [dbo].[{table}] ({keys})"
                          + (f" INCLUDE ({extra})" if extra and kind == 2 else "")
                          + (f" WHERE {condition}" if has_filter else "")))
    return out


def copy_indexes(conn_str, mock, sources, dry_run=False, remaining_ms=None):
    """Give the test copies of a cycle's tables the source's indexes (the
    clones start as bare heaps, which leaves the validation views scanning
    millions of rows). Resumable like copy_data: indexes already there are
    skipped."""
    _need_test_target()
    mock = _clean_mock(mock)
    wanted = {s.strip().upper() for s in sources or [] if s and s.strip()}
    if not wanted:
        raise ValueError("Choose at least one source")
    out = {"ok": True, "mock": mock, "dry_run": dry_run, "created": [], "failed": [], "pending": 0}
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        tables = _tables_for(cur, mock, wanted)
        sizes = _sizes(cur, SOURCE_DB, tables)
        tables.sort(key=lambda t: sizes.get(t, (0, 0))[1])
        todo = []
        for table in tables:
            if not _exists(cur, table):
                continue
            cur.execute("SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID(?) AND name IS NOT NULL", (f"dbo.[{table}]",))
            have = {r[0].upper() for r in cur.fetchall()}
            todo += [(table, name, ddl) for name, ddl in _index_ddl(cur, table) if name.upper() not in have]
        out["tables"] = len(tables)
        out["pending"] = len(todo)
        out["tables_with_indexes"] = len({t for t, _, _ in todo})
        if dry_run:
            out["sample"] = [ddl for _, _, ddl in todo[-10:]]
            return out
        for table, name, ddl in todo:
            if remaining_ms and remaining_ms() < 180_000:
                break
            try:
                cur.execute(ddl)
                conn.commit()
                out["created"].append(f"{table}.{name}")
            except Exception as e:  # noqa: BLE001 - report it and go on
                conn.rollback()
                out["failed"].append(f"{table}.{name}: {str(e)[:200]}")
        out["remaining"] = len(todo) - len(out["created"]) - len(out["failed"])
        out["done"] = out["remaining"] == 0
    return out


def copy_data(conn_str, mock, sources, refresh_setup=False, dry_run=False, remaining_ms=None):
    """Copy a cycle's validation data for some sources into the test database:
    the shared tables plus those of the sources. Resumable: a table whose row
    count already matches the source is skipped, and the call stops before
    the Lambda's time runs out (call again to continue). refresh_setup first
    re-copies the cycle's setup tables, keeping a dated copy of the old ones."""
    _need_test_target()
    mock = _clean_mock(mock)
    wanted = {s.strip().upper() for s in sources or [] if s and s.strip()}
    if not wanted:
        raise ValueError("Choose at least one source")
    out = {"ok": True, "mock": mock, "sources": sorted(wanted), "dry_run": dry_run, "setup": [], "copied": [],
           "failed": []}
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        tables = _tables_for(cur, mock, wanted)
        source_sizes = _sizes(cur, SOURCE_DB, tables)
        tables.sort(key=lambda t: source_sizes.get(t, (0, 0))[1])   # small first: progress shows early
        seeder = None if dry_run else Seeder(conn)
        stamp = time.strftime("%Y%m%d")
        if refresh_setup:
            for table in (t.format(mock=mock) for t in SETUP_REFRESH):
                entry = {"table": table}
                out["setup"].append(entry)
                cur.execute(f"SELECT COUNT(*) FROM [{SOURCE_DB}].dbo.[{table}]")
                entry["source_rows"] = cur.fetchone()[0]
                if dry_run:
                    continue
                if _exists(cur, table):
                    backup = f"{table}_BAK_{stamp}"
                    if not _exists(cur, backup):
                        cur.execute(f"SELECT * INTO [dbo].[{backup}] FROM [dbo].[{table}]")
                        conn.commit()
                        entry["backup"] = backup
                else:
                    seeder.ensure(table)
                entry["copied"] = _copy_rows(cur, conn, table)
        target_sizes = _sizes(cur, TARGET_DB, tables)
        pending = []
        for table in tables:
            rows = source_sizes.get(table, (0, 0))[0]
            if rows and target_sizes.get(table, (None, 0))[0] != rows:
                pending.append(table)
        out["tables"] = len(tables)
        out["rows"] = sum(source_sizes.get(t, (0, 0))[0] for t in tables)
        out["mb"] = round(sum(source_sizes.get(t, (0, 0))[1] for t in tables), 1)
        out["to_copy"] = len(pending)
        if dry_run:
            out["pending"] = [{"table": t, "rows": source_sizes[t][0], "mb": source_sizes[t][1]} for t in pending]
            return out
        for table in tables:
            seeder.ensure(table)
        for table in pending:
            if remaining_ms and remaining_ms() < 240_000:
                break
            try:
                out["copied"].append({"table": table, "rows": _copy_rows(cur, conn, table)})
            except Exception as e:  # noqa: BLE001 - report the table and go on with the next
                conn.rollback()
                out["failed"].append(f"{table}: {str(e)[:200]}")
        out["remaining"] = len(pending) - len(out["copied"]) - len(out["failed"])
        out["done"] = out["remaining"] == 0
        if seeder.report["failed"]:
            out["seeding_failed"] = seeder.report["failed"][:20]
    return out


def _definition_key(text):
    """A module definition compared on its words: whitespace and CREATE/ALTER aside."""
    body = _as_create_or_alter(text or "")
    return " ".join(body.split()).upper()


def sync_views(conn_str, mock, dry_run=False):
    """Bring the test database's copies of a cycle's validation views, and the
    views and functions they use, up to the source's definitions. Seeding
    creates a module only when it is missing, so an older copy stays behind
    when the team changes a rule."""
    import validation_runner
    _need_test_target()
    mock = _clean_mock(mock)
    out = {"ok": True, "mock": mock, "dry_run": dry_run, "same": 0, "missing": [], "different": [], "updated": [],
           "failed": []}
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        cat = _Catalog(cur)
        names, seen = [], set()

        def walk(name):
            key = name.upper()
            if key in seen:
                return
            seen.add(key)
            if cat.type_of(name) in ("V", "FN", "IF", "TF"):
                definition = cat.definition(name)
                for ref in cat.references(name, definition):
                    walk(ref)
                names.append((name, definition))

        for program in _hcm_programs(cur, mock):
            for view in validation_runner.catalog_views(cur, program, mock, db=SOURCE_DB):
                walk(view)
        for name, definition in names:
            cur.execute("SELECT OBJECT_DEFINITION(OBJECT_ID(?))", (f"dbo.[{name}]",))
            row = cur.fetchone()
            current = row[0] if row else None
            if current is None:
                out["missing"].append(name)
            elif _definition_key(current) != _definition_key(definition):
                out["different"].append(name)
            else:
                out["same"] += 1
                continue
            if dry_run or current is None:   # missing ones are created by the next run's seeding
                continue
            try:
                cur.execute(_as_create_or_alter(definition))
                conn.commit()
                out["updated"].append(name)
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                out["failed"].append(f"{name}: {str(e)[:200]}")
    return out


def compare_log(conn_str, mock, program, source):
    """Failing-row counts per validation code of one program run, in the test
    database and in the source database's log (counts only)."""
    import validation_runner
    mock = _clean_mock(mock)
    names = validation_runner._log_names(program)
    marks = ", ".join("?" for _ in names)
    counts = {}
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        for side, db in (("test", TARGET_DB), ("source", SOURCE_DB)):
            cur.execute(f"SELECT [Validation_Code], COUNT(*) FROM [{db}].dbo.[LOG_DATA_CLEANSE_DETAIL] WHERE [MOCK] = ? "
                        f"AND [Source] = ? AND [Validation_Program] IN ({marks}) GROUP BY [Validation_Code]",
                        [mock, source] + names)
            for code, n in cur.fetchall():
                counts.setdefault(code or "", {"test": 0, "source": 0})[side] = n
        # When each side last ran it, and which of the source's tables were
        # loaded after the source's run (its results describe older data).
        runs = {}
        for side, db in (("test", TARGET_DB), ("source", SOURCE_DB)):
            cur.execute(f"SELECT MAX(Validation_PROCESSED_DTTM) FROM [{db}].dbo.LOG_DATA_CLEANSE_RUNDTTM "
                        f"WHERE MOCK = ? AND SOURCE = ? AND Validation_Program IN ({marks})", [mock, source] + names)
            runs[side] = cur.fetchone()[0]
        loaded_after = []
        if runs["source"]:
            cur.execute(f"SELECT TOP 30 Table_Name, MAX(LAST_LOAD_DTTM) FROM [{SOURCE_DB}].dbo.LAST_LOAD_BY_TABLE_VW "
                        f"WHERE (Table_Name LIKE ? OR Table_Name LIKE ?) GROUP BY Table_Name "
                        f"HAVING MAX(LAST_LOAD_DTTM) > ? ORDER BY MAX(LAST_LOAD_DTTM) DESC",
                        (f"%[_]{source}", f"%{mock}%", runs["source"]))
            loaded_after = [{"table": t, "at": at} for t, at in cur.fetchall()]
    rows = [{"code": c, **v} for c, v in sorted(counts.items())]
    return {"ok": True, "mock": mock, "program": program, "source": source, "codes": rows,
            "test_total": sum(r["test"] for r in rows), "source_total": sum(r["source"] for r in rows),
            "different": [r["code"] for r in rows if r["test"] != r["source"]],
            "test_run_at": runs["test"], "source_run_at": runs["source"], "loaded_after_source_run": loaded_after}


# What a cycle's portal testing leaves behind: tables keyed by MOCK (form rows
# follow their form) and S3 folders keyed by the cycle. Templates and user
# guides are the team's set-up and stay.
PORTAL_TABLES = ("DATA_CLEANSE_CERT_VALIDATION", "DATA_CLEANSE_CERT_FILE", "DATA_CLEANSE_CERT_ISSUE",
                 "DATA_CLEANSE_CERT_SIGNOFF", "DATA_CLEANSE_CERT_ATTACHMENT", "DATA_CLEANSE_CERT_FORM",
                 "DATA_CLEANSE_PUBLISHED_FILE")
PORTAL_FOLDERS = ("Certifications", "Published", "PublishInbox", "Reports", "CertForms/{mock}/out")


def reset_cycle(conn_str, bucket, mock, dry_run=False):
    """Clear a cycle's portal activity from the test database and its bucket
    so a test starts clean. Nothing is destroyed: the rows go to
    <table>_ARCHIVE_<stamp> tables and the files under SymphonyPrivate/_Archive/<stamp>/."""
    import boto3
    _need_test_target()
    mock = _clean_mock(mock)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = {"ok": True, "mock": mock, "dry_run": dry_run, "tables": {}, "files": {}}
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        for table in PORTAL_TABLES + ("DATA_CLEANSE_CERT_FORM_ROW",):
            if not _exists(cur, table):
                continue
            where = ("[Form_ID] IN (SELECT [ID] FROM [dbo].[DATA_CLEANSE_CERT_FORM] WHERE [MOCK] = ?)"
                     if table == "DATA_CLEANSE_CERT_FORM_ROW" else "[MOCK] = ?")
            cur.execute(f"SELECT COUNT(*) FROM [dbo].[{table}] WHERE {where}", (mock,))
            out["tables"][table] = cur.fetchone()[0]
        if not dry_run:
            # Form rows first: they find their forms through DATA_CLEANSE_CERT_FORM.
            for table in ("DATA_CLEANSE_CERT_FORM_ROW",) + PORTAL_TABLES:
                if not out["tables"].get(table):
                    continue
                where = ("[Form_ID] IN (SELECT [ID] FROM [dbo].[DATA_CLEANSE_CERT_FORM] WHERE [MOCK] = ?)"
                         if table == "DATA_CLEANSE_CERT_FORM_ROW" else "[MOCK] = ?")
                archive = f"{table}_ARCHIVE_{stamp.replace('-', '_')}"
                cur.execute(f"SELECT * INTO [dbo].[{archive}] FROM [dbo].[{table}] WHERE {where}", (mock,))
                cur.execute(f"DELETE FROM [dbo].[{table}] WHERE {where}", (mock,))
            conn.commit()
    s3 = boto3.client("s3")
    for folder in PORTAL_FOLDERS:
        prefix = f"{api_util.PRIVATE_ROOT}/" + (folder.format(mock=mock) if "{mock}" in folder else f"{folder}/{mock}") + "/"
        keys = [o["Key"] for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix)
                for o in page.get("Contents", [])]
        out["files"][prefix] = len(keys)
        if dry_run:
            continue
        for key in keys:
            s3.copy_object(Bucket=bucket, Key=f"{api_util.PRIVATE_ROOT}/_Archive/{stamp}/{key}",
                           CopySource={"Bucket": bucket, "Key": key})
            s3.delete_object(Bucket=bucket, Key=key)
    if not dry_run:
        out["archived_to"] = f"{api_util.PRIVATE_ROOT}/_Archive/{stamp}/"
    return out


def status(conn_str):
    """Where validation points, and what the target already has."""
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute("SELECT DB_NAME()")
        connected = cur.fetchone()[0]
        out = {"ok": True, "target_db": TARGET_DB, "source_db": SOURCE_DB,
               "connected_db": connected, "is_test": is_test_target(), "present": {}, "perms": {}}
        if is_test_target():
            for name in CONFIG_TABLES + RESULT_TABLES + CORE_FUNCTIONS + ["SETUP_CONVERSION_PLAN_MOCK14"]:
                out["present"][name] = _exists(cur, name)
            for perm in ("CREATE TABLE", "CREATE VIEW", "CREATE PROCEDURE", "CREATE FUNCTION", "EXECUTE"):
                cur.execute(f"SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', '{perm}')")
                out["perms"][perm] = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM sys.views WHERE name LIKE 'FILEVAL%'")
            out["fileval_views"] = cur.fetchone()[0]
        return out
