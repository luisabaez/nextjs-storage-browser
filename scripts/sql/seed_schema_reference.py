"""
seed_schema_reference.py
========================
Loads the 63 rows of Database_Schema_v9.xlsx → Schema Reference sheet into
the SCHEMA_REFERENCE table in Hacienda_ERP_Test.

This is the **one-time** seeder per the project decision:
  "One-time SQL seed from the spreadsheet (Recommended)"

Run once after applying phase1_migration.sql. Re-run only when the source
spreadsheet has a new spec version — the script wipes-and-reloads for that
specific Spec_Version row group.

Usage (from project root):
    set HACIENDA_SQL_CONN=Driver={ODBC Driver 17 for SQL Server};Server=...;...
    python scripts/sql/seed_schema_reference.py
        [--xlsx PATH_TO_DATABASE_SCHEMA_V9.XLSX]
        [--spec-version v9]
        [--dry-run]

Assumes the SCHEMA_REFERENCE table already exists (created by
phase1_migration.sql). Refuses to run if it doesn't.
"""

import argparse
import os
import sys

import pandas as pd

DEFAULT_XLSX = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "RefrenceFiles", "Database_Schema_v9.xlsx",
)
DEFAULT_SPEC_VERSION = "v9"


def load_reference_rows(xlsx_path: str) -> list[dict]:
    """Read the Schema Reference sheet and normalise into row dicts."""
    df = pd.read_excel(xlsx_path, sheet_name="Schema Reference")
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "Sheet":          _clean(r.iloc[0]),
            "Column_Field":   _clean(r.iloc[1]),
            "Data_Type":      _clean(r.iloc[2]),
            "Allowed_Values": _clean(r.iloc[3]),
            "Description":    _clean(r.iloc[4]),
            "Required":       _clean(r.iloc[5]),
        })
    return rows


def _clean(value) -> str | None:
    """Treat NaN / empty strings as NULL; trim whitespace."""
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() == "nan":
        return None
    return s


def seed(rows: list[dict], spec_version: str, conn_str: str, dry_run: bool) -> None:
    import pyodbc

    if dry_run:
        print(f"DRY-RUN: would load {len(rows)} rows at Spec_Version='{spec_version}'")
        for i, r in enumerate(rows[:5], 1):
            print(f"  [{i}] {r['Sheet']} :: {r['Column_Field']} :: {r['Data_Type']}")
        if len(rows) > 5:
            print(f"  ... and {len(rows) - 5} more")
        return

    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()

        # Guard: SCHEMA_REFERENCE must exist (created by phase1_migration.sql)
        cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = 'SCHEMA_REFERENCE'")
        if cur.fetchone()[0] == 0:
            print(
                "ERROR: SCHEMA_REFERENCE table does not exist. "
                "Run scripts/sql/phase1_migration.sql first.",
                file=sys.stderr,
            )
            sys.exit(2)

        # Wipe any existing rows for this spec version so re-runs are idempotent
        cur.execute("DELETE FROM SCHEMA_REFERENCE WHERE Spec_Version = ?", (spec_version,))
        deleted = cur.rowcount
        if deleted:
            print(f"Removed {deleted} existing rows at Spec_Version='{spec_version}'")

        # Insert the new rows
        insert_sql = (
            "INSERT INTO SCHEMA_REFERENCE "
            "(Sheet, Column_Field, Data_Type, Allowed_Values, Description, Required, Spec_Version) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        for r in rows:
            cur.execute(
                insert_sql,
                (
                    r["Sheet"],
                    r["Column_Field"],
                    r["Data_Type"],
                    r["Allowed_Values"],
                    r["Description"],
                    r["Required"],
                    spec_version,
                ),
            )

        conn.commit()
        print(f"Loaded {len(rows)} rows into SCHEMA_REFERENCE at Spec_Version='{spec_version}'")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--xlsx", default=DEFAULT_XLSX, help=f"Path to Database_Schema_v9.xlsx (default: {DEFAULT_XLSX})")
    ap.add_argument("--spec-version", default=DEFAULT_SPEC_VERSION, help=f"Spec version label (default: {DEFAULT_SPEC_VERSION})")
    ap.add_argument("--dry-run", action="store_true", help="Print what would happen without touching SQL Server")
    args = ap.parse_args()

    if not os.path.isfile(args.xlsx):
        print(f"ERROR: spreadsheet not found at {args.xlsx}", file=sys.stderr)
        sys.exit(1)

    conn_str = os.environ.get("HACIENDA_SQL_CONN", "")
    if not args.dry_run and not conn_str:
        print(
            "ERROR: set HACIENDA_SQL_CONN env var (pyodbc connection string) "
            "before running. Or pass --dry-run to preview the load.",
            file=sys.stderr,
        )
        sys.exit(1)

    rows = load_reference_rows(args.xlsx)
    seed(rows, args.spec_version, conn_str, args.dry_run)


if __name__ == "__main__":
    main()
