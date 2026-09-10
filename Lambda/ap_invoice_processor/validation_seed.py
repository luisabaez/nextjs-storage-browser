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

import pyodbc

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

class _Catalog:
    """Object names of the source database, loaded once per seeding pass."""

    def __init__(self, cur):
        self.cur = cur
        cur.execute(f"SELECT name, type FROM [{SOURCE_DB}].sys.objects WHERE type IN ('U','V','P','FN','IF','TF','TR')")
        self.types = {name.upper(): t.strip() for name, t in cur.fetchall()}
        self.callables = {n for n, t in self.types.items() if t in ("FN", "IF", "TF", "V", "P", "U")}

    def type_of(self, name):
        return self.types.get(name.upper())

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
        defs.append(f"[{col}] {t} {'NULL' if nullable == 'YES' else 'NOT NULL'}")
    return defs


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


def seed_for_run(conn_str, spec, source, mock):
    """Everything one program run needs in the test target. Returns the report."""
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        s = Seeder(conn)
        s.ensure_core()
        s.ensure_mock_tables(mock)
        for sp in [spec.get("setup_sp"), spec.get("sp"),
                   (spec.get("post_sp") or "").format(mock=mock) or None]:
            if sp:
                s.ensure(sp)
        s.ensure_views(spec.get("families", []), source, mock)
        return s.summary()


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
