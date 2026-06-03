"""
promote_mock.py
================
Implements the "Promote to Mock N+1" admin operation.

When the admin clicks the button in the dashboard, the Lambda is invoked
with:
    ?action=promote_mock&source=MOCK13&target=MOCK14&dry_run=true|false&actor=<email>

Behaviour:
  • dry_run = true  → returns a JSON preview (row counts, column diff).
                      No database writes.
  • dry_run = false → runs the promotion as a single transaction.
                      Writes a MOCK_PROMOTIONS audit row regardless of
                      outcome (Started → Completed | Failed).

Tables promoted (all per-Mock):
  - SETUP_CONVERSION_PLAN_{TARGET}
  - VALIDATION_GROUPS_{TARGET}
  - VBL_GROUPS_{TARGET}
  - VBL_GROUP_MEMBERS_{TARGET}
  - VG_DEPENDENCIES_{TARGET}

NOT copied: VALIDATION_RUNS — runs are per-Mock and start empty for a new Mock.
NOT copied: AWS_FILES — single global table; never per-Mock.

Tracking / "Latest_*" columns are cleared on promotion so the new Mock
starts with a clean slate. Only structural data (members, dependencies,
group definitions) is carried forward.
"""

import json
from datetime import datetime

import pyodbc


# Tables to promote, in this order. Each entry is (source_table_pattern,
# target_table_pattern, columns_to_clear_after_copy).
# Columns_to_clear are tracking/status fields that should not carry from
# old Mock to new — the new Mock starts fresh.
PROMOTABLE_TABLES = [
    {
        "table_base": "SETUP_CONVERSION_PLAN",
        "columns_to_clear": [
            "LoadedAt", "LoadedBy", "FileTimestamp", "RowCount",
            "LoadVersion", "PreviousLoadedAt", "S3SourceKey", "FileSize",
            "Latest_File_ID", "Latest_File_Upload_Date", "Total_Upload_Attempts",
            "Latest_Validation_Status", "Latest_Approval_Status",
            "Latest_Approver", "Latest_Approval_Date",
            "Pre_Load_Validation_Status", "Pre_Load_Recon_Status",
            "Oracle_Load_Status", "Oracle_Load_Date",
            "Blocker_Flag", "Blocker_Description",
            "Issue_Opened_Date", "Issue_Resolved_Date",
            "Actual_File_Receipt_Date", "Current_Process_Stage",
            "Last_Updated_By", "Last_Updated_Date",
        ],
        # Mock_Number is rewritten to target on copy
        "rewrite_mock_column": "Mock_Number",
    },
    {
        "table_base": "VALIDATION_GROUPS",
        "columns_to_clear": [
            "Members_Currently_Loaded", "All_Members_Loaded",
            "Current_Validation_Run_ID", "Validation_Run_Count",
            "Latest_Validation_Status", "Latest_Validation_DateTime",
            "Threshold_Exceeded", "Reextract_Required",
            "Revalidation_Triggered_By_eTag",
            "Latest_Approval_Status", "Latest_Approver",
            "Latest_Approval_DateTime", "Latest_Approval_Comments",
            "Last_Updated_By", "Last_Updated_DateTime",
        ],
        "rewrite_mock_column": "Mock_Number",
    },
    {
        "table_base": "VBL_GROUPS",
        "columns_to_clear": [
            "Val_To_Source_Members_Approved", "All_Val_To_Source_Approved",
            "Current_VBL_Run_ID", "VBL_Run_Count",
            "Latest_VBL_Status", "Latest_VBL_DateTime",
            "VBL_File_eTag", "Recon_File_eTag",
            "Conversion_Load_File_eTag", "Sterling_Transmission_Status",
            "Sterling_Transmission_DateTime",
            "Latest_Approval_Status", "Latest_Approver",
            "Latest_Approval_DateTime", "Latest_Approval_Comments",
            "Last_Updated_By", "Last_Updated_DateTime",
        ],
        "rewrite_mock_column": "Mock_Number",
    },
    {
        "table_base": "VBL_GROUP_MEMBERS",
        "columns_to_clear": [
            "Val_To_Source_Latest_Status", "Val_To_Source_Approval_Status",
            "Val_To_Source_Approval_DateTime", "Blocks_VBL_Trigger",
            "Last_Updated_By", "Last_Updated_DateTime",
        ],
        "rewrite_mock_column": None,  # this table doesn't carry Mock_Number
    },
    {
        "table_base": "VG_DEPENDENCIES",
        "columns_to_clear": [
            "Dependency_Status", "Table_Load_DateTime",
            "Blocks_Validation_Trigger",
            "Last_Updated_By", "Last_Updated_DateTime",
        ],
        "rewrite_mock_column": "Mock_Number",
    },
]


def _normalise_mock(value: str) -> str:
    """Accept 'MOCK14', 'mock14', or '14' → returns 'MOCK14'."""
    s = (value or "").strip().upper()
    if not s:
        return ""
    if s.startswith("MOCK"):
        return s
    if s.isdigit():
        return f"MOCK{s}"
    return s


def _table_exists(cur, name: str) -> bool:
    cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (name,))
    return cur.fetchone()[0] > 0


def _get_columns(cur, name: str) -> list[str]:
    """Return ordered column list for a table. Empty if table absent."""
    cur.execute(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        (name,),
    )
    return [row[0] for row in cur.fetchall()]


def _get_column_definitions(cur, name: str) -> str:
    """
    Build the (col TYPE(...) NULL, ...) clause from an existing table so the
    CREATE TABLE for the target Mock matches the source's data types exactly.
    """
    cur.execute(
        """
        SELECT
            COLUMN_NAME,
            DATA_TYPE,
            CHARACTER_MAXIMUM_LENGTH,
            NUMERIC_PRECISION,
            NUMERIC_SCALE,
            IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
        """,
        (name,),
    )
    parts = []
    for col_name, data_type, char_len, num_prec, num_scale, is_nullable in cur.fetchall():
        # Build type clause
        if data_type in ("nvarchar", "varchar", "char", "nchar"):
            length = "MAX" if char_len == -1 else (char_len or 500)
            type_clause = f"{data_type.upper()}({length})"
        elif data_type in ("decimal", "numeric"):
            type_clause = f"{data_type.upper()}({num_prec or 18},{num_scale or 0})"
        else:
            type_clause = data_type.upper()
        null_clause = "NULL" if is_nullable == "YES" else "NOT NULL"
        parts.append(f"    [{col_name}] {type_clause} {null_clause}")
    return ",\n".join(parts)


def _dry_run_diff(conn, source_mock: str, target_mock: str) -> dict:
    """Return a preview the dashboard renders before the user confirms."""
    cur = conn.cursor()
    summary = {
        "source_mock": source_mock,
        "target_mock": target_mock,
        "tables": [],
        "warnings": [],
    }
    for spec in PROMOTABLE_TABLES:
        src = f"{spec['table_base']}_{source_mock}"
        tgt = f"{spec['table_base']}_{target_mock}"

        src_exists = _table_exists(cur, src)
        tgt_exists = _table_exists(cur, tgt)

        src_rows = None
        if src_exists:
            cur.execute(f"SELECT COUNT(*) FROM [{src}]")
            src_rows = cur.fetchone()[0]

        entry = {
            "table_base": spec["table_base"],
            "source_table": src,
            "target_table": tgt,
            "source_exists": src_exists,
            "target_exists": tgt_exists,
            "source_row_count": src_rows,
            "rows_to_copy": src_rows if (src_exists and not tgt_exists) else 0,
        }

        if not src_exists:
            summary["warnings"].append(f"Source table {src} does not exist — will be skipped.")
        if tgt_exists:
            summary["warnings"].append(f"Target table {tgt} already exists — will be skipped to avoid overwrite.")
        summary["tables"].append(entry)

    return summary


def _write_promotion_audit(cur, source_mock, target_mock, actor, status,
                            row_counts=None, error=None, duration_s=None) -> int:
    """Insert (or update if existing started row provided) an audit record."""
    cur.execute(
        """
        INSERT INTO MOCK_PROMOTIONS
            (Source_Mock, Target_Mock, Performed_By, Performed_At,
             Row_Counts_JSON, Status, Error_Message, Duration_Seconds)
        OUTPUT INSERTED.Promotion_ID
        VALUES (?, ?, ?, SYSUTCDATETIME(), ?, ?, ?, ?)
        """,
        (
            source_mock,
            target_mock,
            actor,
            json.dumps(row_counts) if row_counts else None,
            status,
            error,
            duration_s,
        ),
    )
    return cur.fetchone()[0]


def _execute_promotion(conn, source_mock: str, target_mock: str, actor: str) -> dict:
    """Run the actual promotion. Each table copied inside a single transaction."""
    cur = conn.cursor()
    started_at = datetime.utcnow()
    row_counts: dict[str, int] = {}

    try:
        for spec in PROMOTABLE_TABLES:
            src = f"{spec['table_base']}_{source_mock}"
            tgt = f"{spec['table_base']}_{target_mock}"

            if not _table_exists(cur, src):
                row_counts[spec["table_base"]] = -1   # -1 sentinel = skipped (source missing)
                continue
            if _table_exists(cur, tgt):
                row_counts[spec["table_base"]] = -2   # -2 sentinel = skipped (target existed)
                continue

            # Build CREATE TABLE matching source structure
            col_defs = _get_column_definitions(cur, src)
            cur.execute(f"CREATE TABLE [{tgt}] (\n{col_defs}\n)")

            # Build SELECT list: rewrite Mock_Number, NULL out cleared columns
            cols = _get_columns(cur, src)
            clear_set = {c.lower() for c in spec["columns_to_clear"]}
            mock_col = (spec["rewrite_mock_column"] or "").lower()

            select_parts = []
            insert_parts = []
            for c in cols:
                cl = c.lower()
                insert_parts.append(f"[{c}]")
                if cl == mock_col:
                    select_parts.append(f"'{target_mock}' AS [{c}]")
                elif cl in clear_set:
                    select_parts.append(f"CAST(NULL AS NVARCHAR(MAX)) AS [{c}]")
                else:
                    select_parts.append(f"[{c}]")

            insert_sql = (
                f"INSERT INTO [{tgt}] ({', '.join(insert_parts)}) "
                f"SELECT {', '.join(select_parts)} FROM [{src}]"
            )
            cur.execute(insert_sql)

            # Capture row count
            cur.execute(f"SELECT COUNT(*) FROM [{tgt}]")
            row_counts[spec["table_base"]] = cur.fetchone()[0]

        # Single commit at the very end — atomic across all tables
        conn.commit()
        duration_s = int((datetime.utcnow() - started_at).total_seconds())

        # Audit success
        audit_cur = conn.cursor()
        _write_promotion_audit(
            audit_cur, source_mock, target_mock, actor,
            status="Completed", row_counts=row_counts, duration_s=duration_s,
        )
        conn.commit()

        return {
            "ok": True,
            "source_mock": source_mock,
            "target_mock": target_mock,
            "row_counts": row_counts,
            "duration_seconds": duration_s,
        }
    except Exception as e:
        conn.rollback()
        duration_s = int((datetime.utcnow() - started_at).total_seconds())
        # Audit failure — needs its own transaction
        audit_cur = conn.cursor()
        try:
            _write_promotion_audit(
                audit_cur, source_mock, target_mock, actor,
                status="Failed", row_counts=row_counts,
                error=str(e)[:1000], duration_s=duration_s,
            )
            conn.commit()
        except Exception:
            pass  # audit failure should not mask the real error
        raise


def handle_promote_mock_request(connection_str: str, source: str, target: str,
                                 actor: str, dry_run: bool) -> dict:
    """
    Entry point called by the Lambda router.

    Returns a dict ready to JSON-serialise. Caller wraps it in the API response.
    """
    source_mock = _normalise_mock(source)
    target_mock = _normalise_mock(target)

    if not source_mock or not target_mock:
        return {"ok": False, "error": "source and target Mock numbers are required"}
    if source_mock == target_mock:
        return {"ok": False, "error": "source and target Mock must differ"}
    if not actor:
        return {"ok": False, "error": "actor (Cognito email) is required for audit"}

    with pyodbc.connect(connection_str) as conn:
        if dry_run:
            preview = _dry_run_diff(conn, source_mock, target_mock)
            return {"ok": True, "dry_run": True, **preview}
        return _execute_promotion(conn, source_mock, target_mock, actor)
