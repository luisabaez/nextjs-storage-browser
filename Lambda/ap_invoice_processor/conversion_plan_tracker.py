"""
Conversion Plan Tracker
========================
Auto-populates SETUP_CONVERSION_PLAN_{MOCK} tables in Hacienda_ERP_Test
when files are loaded via the Lambda processor.

Reference table: Hacienda_ERP.dbo.SETUP_CONVERSION_PLAN_MOCK12

Key behaviors:
  - Creates SETUP_CONVERSION_PLAN_{MOCK} if it doesn't exist
  - Upserts a row per loaded file (keyed on Table_Name)
  - Tracks load timestamps and version info
  - Extracts BU from file data with flexible formatting (strips leading zeros)
  - Sets CONVERSION_TABLE_BU for parent/child entity relationships
"""

import re
from datetime import datetime

# All 92 columns from the Database_Schema_v9.xlsx Conversion Plan sheet,
# plus 8 per-file-load tracking columns. Used when Lambda auto-creates a new
# SETUP_CONVERSION_PLAN_MOCK{N} table (Phase 1 migration handles MOCK13
# explicitly; this list governs MOCK14+ creation).
SETUP_COLUMNS = [
    # ── Core Identity & WBS (spec cols 1-6, 5 new) ──
    "Pillar",
    "ID",                                  # WBS ID string e.g. 1.1.1.1.5.1
    "WBS_level",
    "Validation_Group_ID",
    "Predecessor_Validation_Group_ID",
    "Successors_for_Initial_Validation",

    # ── Entity Classification (spec cols 7-15) ──
    "Module",
    "Entity",
    "Data_Sources",
    "Table_Name",
    "LOAD_REQUIRED",
    "LOAD_ON_LAST_LOAD_TABLE",
    "RESPONSE",
    "Entity_Requested_to_Source",
    "On_Conversion_Plan",

    # ── Source & Enrichment (spec cols 16-28) ──
    "REQ_TO_BEGIN_MOCK",
    "Added_To_Conversion_Plan",
    "alternate_table_name",
    "Descr",
    "ASSET_BOOK",
    "ExcludedFromMock",
    "SubEntity",
    "CREATE_EXTRACTED_FILE",
    "EntityOnFileStructure",
    "SOURCE",
    "COMPANY",
    "ENRICHMENT_SYSTEM",
    "SourceOnlyFlag_Extracted",

    # ── Conversion Mapping (spec cols 29-43) ──
    "RECON_VIEW_NAME",
    "CONVERSION_TABLE",
    "CONVERSION_TABLE_SourceField",
    "CONVERSION_TABLE_Criteria",
    "CONVERSION_TABLE_BU_Field",
    "CONVERSION_TABLE_SourceFieldValue",
    "ConversionFileSubmitted",
    "ValidationEntity",
    "ValidationProgram",
    "InventoryOrganization",
    "CONVERSION_ENTITY_FLAG",
    "RequiredFSCM",
    "BackpTableOnDelivery",
    "CONVERSION_TABLE_BU",
    "PostMockTable",

    # ── Validation & Recon (spec cols 44-50) ──
    "POSTMOCK",
    "FileName",
    "File_Expected",
    "ExtracteFieldBU",
    "Validation_ViewPrefix",
    "CONVERSION_TABLE_DELTA01",
    "ExtractMethod",

    # ── Extract & File (spec cols 51-58) ──
    "ValidationSourceExist",
    "ValidationBeforeSendExist",
    "Validation_Program",
    "SplitReportsByBU",
    "DataRequest",
    "BU",
    "Validation_ViewPrefix_BefSend",
    "RequiredPhase2",

    # ── WBS Breakdown (spec cols 59-64, 6 new) ──
    "WBS_L1_Mock",
    "WBS_L2_Pillar",
    "WBS_L3_Module",
    "WBS_L4_Entity",
    "WBS_L5_Source",
    "WBS_L6_Table",

    # ── Mock / Phase (spec cols 65-66, 2 new) ──
    "Mock_Number",
    "Phase",

    # ── Scheduling & Ownership (spec cols 67-73, 7 new) ──
    "Expected_File_Receipt_Date",
    "Actual_File_Receipt_Date",
    "Target_Conversion_Complete",
    "Target_Oracle_Load_Date",
    "Responsible_Team",
    "Owner_Contact",
    "Priority",

    # ── Current Status (spec cols 74-85, 12 new) — drives the Gantt View ──
    "Current_Process_Stage",
    "Latest_File_ID",                 # eTag pointer into AWS_FILES
    "Latest_File_Upload_Date",
    "Total_Upload_Attempts",
    "Latest_Validation_Status",
    "Latest_Approval_Status",
    "Latest_Approver",
    "Latest_Approval_Date",
    "Pre_Load_Validation_Status",
    "Pre_Load_Recon_Status",
    "Oracle_Load_Status",
    "Oracle_Load_Date",

    # ── Blockers & Issues (spec cols 86-89, 4 new) ──
    "Blocker_Flag",
    "Blocker_Description",
    "Issue_Opened_Date",
    "Issue_Resolved_Date",

    # ── Audit (spec cols 90-92, 3 new) ──
    "Last_Updated_By",
    "Last_Updated_Date",
    "Notes",

    # ── Our per-file-load tracking columns (separate from spec Audit) ──
    "LoadedAt",            # Timestamp of when the file was loaded
    "LoadedBy",            # Who triggered the load
    "FileTimestamp",       # Date/time extracted from the filename
    "RowCount",            # Number of rows loaded
    "LoadVersion",         # Incremented each time the same file is re-loaded
    "PreviousLoadedAt",    # When the previous version was loaded
    "S3SourceKey",         # Original S3 key of the file
    "FileSize",            # File size in bytes
]

# Columns from the reference table that have spaces — we use underscores in our table
# This maps our column name back to the reference column for lookups
REFERENCE_COLUMN_MAP = {
    "Entity_Requested_to_Source": "Entity Requested to Source",
    "On_Conversion_Plan": "On Conversion Plan",
}


def _get_setup_table_name(mock_number):
    """Get the SETUP_CONVERSION_PLAN table name for a given mock number."""
    return f"SETUP_CONVERSION_PLAN_{mock_number}"


def _normalize_bu(bu_value):
    """
    Normalize BU value by stripping leading zeros.
    Handles formats like '0000014', '014', '14' -> '14'
    Returns None if empty or not a number.
    """
    if not bu_value or not bu_value.strip():
        return None
    bu_str = bu_value.strip()
    # Strip leading zeros but keep at least one digit
    normalized = bu_str.lstrip("0") or "0"
    return normalized


def _extract_bu_from_dataframe(df):
    """
    Extract unique BU values from a DataFrame.
    Looks for columns named 'BU', 'BUSINESS_UNIT', or similar.
    Returns a comma-separated string of normalized BU values, or None.
    """
    bu_columns = []
    for col in df.columns:
        col_upper = col.upper().strip()
        if col_upper in ("BU", "BUSINESS_UNIT", "BUSINESS_UNIT_NUMBER",
                         "BUSINESS_UNIT_AS_BUSINESS_UNIT", "BU_NUMBER"):
            bu_columns.append(col)

    if not bu_columns:
        return None

    # Use the first matching column
    bu_col = bu_columns[0]
    unique_bus = set()
    for val in df[bu_col].dropna().unique():
        normalized = _normalize_bu(str(val))
        if normalized:
            unique_bus.add(normalized)

    if not unique_bus:
        return None

    return ",".join(sorted(unique_bus))


def _get_pillar_from_module(module):
    """Map module to pillar grouping."""
    pillar_map = {
        "FIN": "Finance",
        "SCM": "Supply Chain",
        "HCM": "Human Capital",
    }
    return pillar_map.get(module, module)


def ensure_setup_table_exists(cursor, mock_number):
    """
    Create the SETUP_CONVERSION_PLAN_{MOCK} table if it doesn't exist.
    Uses the same column structure as the reference table plus tracking columns.
    """
    table_name = _get_setup_table_name(mock_number)

    cursor.execute(
        "SELECT COUNT(*) FROM sys.tables WHERE name = ?",
        (table_name,)
    )
    exists = cursor.fetchone()[0] > 0

    if exists:
        # Check if tracking columns exist, add them if missing
        cursor.execute(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_NAME = ?",
            (table_name,)
        )
        existing_cols = {row[0].upper() for row in cursor.fetchall()}

        tracking_cols = [
            "LoadedAt", "LoadedBy", "FileTimestamp", "RowCount",
            "LoadVersion", "PreviousLoadedAt", "S3SourceKey", "FileSize",
        ]
        for col in tracking_cols:
            if col.upper() not in existing_cols:
                alter_sql = (
                    f"ALTER TABLE [{table_name}] "
                    f"ADD [{col}] NVARCHAR(500) NULL"
                )
                cursor.execute(alter_sql)
                cursor.connection.commit()
                print(f"  Added tracking column [{col}] to {table_name}")

        print(f"  Setup table {table_name} exists")
        return False

    # Create the table with all columns as NVARCHAR to match reference pattern
    col_defs = ",\n    ".join(f"[{col}] NVARCHAR(500) NULL" for col in SETUP_COLUMNS)
    create_sql = f"CREATE TABLE [{table_name}] (\n    {col_defs}\n)"

    print(f"  Creating setup table {table_name}...")
    cursor.execute(create_sql)
    cursor.connection.commit()
    print(f"  Setup table {table_name} created successfully")
    return True


def upsert_conversion_plan_row(cursor, mock_number, parsed, table_name,
                                row_count, df=None, triggered_by="",
                                file_key="", file_size=0):
    """
    Insert or update a row in SETUP_CONVERSION_PLAN_{MOCK} for a loaded file.

    Keyed on FileName so each distinct file version (original, _V2, _V3)
    gets its own row.  If the exact same filename is uploaded again
    (duplicate upload), the existing row is updated instead of duplicated.

    Args:
        cursor: pyodbc cursor
        mock_number: e.g. 'MOCK12'
        parsed: dict from parse_filename()
        table_name: the SQL table name the file was loaded into
        row_count: number of rows loaded
        df: pandas DataFrame of the file data (for BU extraction)
        triggered_by: who triggered the load
        file_key: S3 destination key (processed folder)
        file_size: file size in bytes
    """
    setup_table = _get_setup_table_name(mock_number)
    now = datetime.utcnow().isoformat()
    original_filename = parsed.get("filename", "")

    # Extract BU from file data if available
    bu_value = None
    if df is not None:
        bu_value = _extract_bu_from_dataframe(df)

    entity_prefix = parsed.get("entity_prefix", "")
    source = parsed.get("source", "")
    module = parsed.get("module", "")
    entity_display = parsed.get("entity_display", "")
    file_version = parsed.get("file_version", 1)
    file_timestamp = ""
    if parsed.get("date"):
        file_timestamp = parsed["date"]
        if parsed.get("time"):
            file_timestamp += f" {parsed['time']}"

    # Check if this exact filename already has a row (duplicate upload detection)
    cursor.execute(
        f"SELECT [LoadedAt], [LoadVersion] FROM [{setup_table}] "
        f"WHERE [FileName] = ?",
        (original_filename,)
    )
    existing = cursor.fetchone()

    if existing:
        # Same file uploaded again — update in place, increment LoadVersion
        previous_loaded_at = existing[0] or ""
        current_version = int(existing[1] or "0")
        new_version = current_version + 1

        update_sql = (
            f"UPDATE [{setup_table}] SET "
            f"[LoadedAt] = ?, "
            f"[LoadedBy] = ?, "
            f"[FileTimestamp] = ?, "
            f"[RowCount] = ?, "
            f"[LoadVersion] = ?, "
            f"[PreviousLoadedAt] = ?, "
            f"[S3SourceKey] = ?, "
            f"[FileSize] = ?"
        )
        params = [
            now, triggered_by, file_timestamp,
            str(row_count), str(new_version), previous_loaded_at,
            file_key, str(file_size),
        ]

        if bu_value:
            update_sql += ", [BU] = ?"
            params.append(bu_value)

        update_sql += " WHERE [FileName] = ?"
        params.append(original_filename)

        cursor.execute(update_sql, params)
        cursor.connection.commit()
        print(f"  Updated {setup_table}: {original_filename} (re-upload #{new_version})")

    else:
        # New file (or new version like _V2, _V3) — insert a new row
        values = {
            "Pillar": _get_pillar_from_module(module),
            "Module": module,
            "Entity": entity_display,
            "Data_Sources": source,
            "Table_Name": table_name,
            "LOAD_REQUIRED": "YES",
            "SubEntity": entity_prefix,
            "SOURCE": source,
            "FileName": original_filename,
            "BU": bu_value or "",
            "LoadedAt": now,
            "LoadedBy": triggered_by,
            "FileTimestamp": file_timestamp,
            "RowCount": str(row_count),
            "LoadVersion": "1",
            "PreviousLoadedAt": "",
            "S3SourceKey": file_key,
            "FileSize": str(file_size),
        }

        cols = list(values.keys())
        col_list = ", ".join(f"[{c}]" for c in cols)
        placeholders = ", ".join(["?"] * len(cols))
        vals = [values[c] for c in cols]

        insert_sql = (
            f"INSERT INTO [{setup_table}] ({col_list}) "
            f"VALUES ({placeholders})"
        )
        cursor.execute(insert_sql, vals)
        cursor.connection.commit()
        print(f"  Inserted into {setup_table}: {original_filename} "
              f"(file version {file_version}, table: {table_name})")


def _flip_file_expected_after_load(cursor, mock_number, parsed, etag=None):
    """
    Per spec: File_Expected is automatically set to N after a successful
    Table Load, on every row matching this Entity + Source. To re-upload,
    an authorized user must flip it back to Y via the admin tool (see
    handle_reset_file_expected).

    Also rolls up Phase-1 status columns on the row(s):
      Current_Process_Stage, Latest_File_ID, Latest_File_Upload_Date,
      Total_Upload_Attempts, Last_Updated_By, Last_Updated_Date.

    Skips gracefully if the columns don't exist yet (older Mock tables that
    haven't been promoted to the 100-col shape).
    """
    setup_table = _get_setup_table_name(mock_number)
    entity_display = parsed.get("entity_display") or ""
    entity_prefix = parsed.get("entity_prefix") or ""
    source = parsed.get("source") or ""
    now = datetime.utcnow()

    # Which new-spec columns are present on this table? If the table predates
    # the Phase 1 migration we just skip those clauses.
    cursor.execute(
        "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)",
        (setup_table,),
    )
    existing_cols = {row[0] for row in cursor.fetchall()}

    set_clauses = ["[File_Expected] = 'N'"]
    params = []
    if "Current_Process_Stage" in existing_cols:
        set_clauses.append("[Current_Process_Stage] = ?")
        params.append("Table Load Success")
    if etag and "Latest_File_ID" in existing_cols:
        set_clauses.append("[Latest_File_ID] = ?")
        params.append(etag)
    if "Latest_File_Upload_Date" in existing_cols:
        set_clauses.append("[Latest_File_Upload_Date] = ?")
        params.append(now)
    if "Total_Upload_Attempts" in existing_cols:
        set_clauses.append("[Total_Upload_Attempts] = COALESCE([Total_Upload_Attempts], 0) + 1")
    if "Last_Updated_By" in existing_cols:
        set_clauses.append("[Last_Updated_By] = ?")
        params.append("ap-invoice-processor-lambda")
    if "Last_Updated_Date" in existing_cols:
        set_clauses.append("[Last_Updated_Date] = ?")
        params.append(now)

    update_sql = (
        f"UPDATE [{setup_table}] SET {', '.join(set_clauses)} "
        f"WHERE (LTRIM(RTRIM(ISNULL([Entity], ''))) = ? "
        f"       AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?) "
        f"   OR (LTRIM(RTRIM(ISNULL([SubEntity], ''))) = ? "
        f"       AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?)"
    )
    cursor.execute(update_sql, (*params, entity_display, source, entity_prefix, source))
    flipped = cursor.rowcount
    cursor.connection.commit()
    if flipped:
        print(f"  File_Expected flipped to N on {flipped} {setup_table} row(s) "
              f"for {entity_prefix or entity_display}/{source}")


def track_file_load(connection_str, mock_number, parsed, table_name,
                    row_count, df=None, triggered_by="",
                    file_key="", file_size=0, etag=None):
    """
    High-level function to track a file load in the conversion plan.

    Creates the SETUP_CONVERSION_PLAN_{MOCK} table if needed, then
    upserts the file's row, then flips File_Expected to N + updates
    rollup status columns per Phase 3 spec.

    This is the main entry point called from lambda_function.py after
    a file is successfully loaded.
    """
    import pyodbc

    try:
        with pyodbc.connect(connection_str) as conn:
            cursor = conn.cursor()
            ensure_setup_table_exists(cursor, mock_number)
            upsert_conversion_plan_row(
                cursor, mock_number, parsed, table_name,
                row_count, df=df, triggered_by=triggered_by,
                file_key=file_key, file_size=file_size,
            )
            # Phase 3: post-load housekeeping
            _flip_file_expected_after_load(cursor, mock_number, parsed, etag=etag)
    except Exception as e:
        # Don't fail the whole file load if tracking fails
        print(f"  WARNING: Failed to track file in conversion plan: {e}")
        import traceback
        traceback.print_exc()


# ─────────────────────────────────────────────────────────────────────────────
# Reset File_Expected — admin-only path used when a re-upload is required
# ─────────────────────────────────────────────────────────────────────────────
def handle_reset_file_expected(connection_str, mock_number, entity=None,
                                source=None, validation_group_id=None,
                                reason=None, actor=""):
    """
    Flips File_Expected back to 'Y' for the matching row(s) in
    SETUP_CONVERSION_PLAN_{MOCK}. Returns a dict ready for JSON response.

    Match precedence (most specific first):
      1. validation_group_id + source (if both supplied)
      2. entity + source
      3. entity alone (rare — affects all sources for an entity)

    `reason` is appended to Notes for audit.
    Always returns {"ok": bool, ...}; never raises (caller renders ok=False).
    """
    import pyodbc

    try:
        if not mock_number:
            return {"ok": False, "error": "mock_number required"}
        if not (entity or validation_group_id):
            return {"ok": False, "error": "entity or validation_group_id required"}

        setup_table = _get_setup_table_name(mock_number)
        now = datetime.utcnow()

        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()

            # Guard: table must exist + must have File_Expected column
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (setup_table,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error": f"{setup_table} does not exist"}

            cur.execute(
                "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)",
                (setup_table,),
            )
            existing_cols = {row[0] for row in cur.fetchall()}

            set_clauses = ["[File_Expected] = 'Y'"]
            params = []
            if "Last_Updated_By" in existing_cols and actor:
                set_clauses.append("[Last_Updated_By] = ?")
                params.append(actor)
            if "Last_Updated_Date" in existing_cols:
                set_clauses.append("[Last_Updated_Date] = ?")
                params.append(now)
            if "Notes" in existing_cols and reason:
                set_clauses.append(
                    "[Notes] = COALESCE([Notes] + CHAR(10), '') + ?"
                )
                params.append(
                    f"[{now.isoformat()}] File_Expected reset to Y by {actor}: {reason}"
                )

            # Build the WHERE clause based on match precedence
            where_parts = []
            where_params = []
            if validation_group_id and source and "Validation_Group_ID" in existing_cols:
                where_parts.append(
                    "LTRIM(RTRIM(ISNULL([Validation_Group_ID], ''))) = ? "
                    "AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?"
                )
                where_params.extend([validation_group_id, source])
            if entity and source:
                where_parts.append(
                    "(LTRIM(RTRIM(ISNULL([Entity], ''))) = ? "
                    " OR LTRIM(RTRIM(ISNULL([SubEntity], ''))) = ?) "
                    "AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?"
                )
                where_params.extend([entity, entity, source])
            if entity and not source and not where_parts:
                where_parts.append(
                    "(LTRIM(RTRIM(ISNULL([Entity], ''))) = ? "
                    " OR LTRIM(RTRIM(ISNULL([SubEntity], ''))) = ?)"
                )
                where_params.extend([entity, entity])

            if not where_parts:
                return {"ok": False, "error": "No usable match criteria"}

            where_clause = " OR ".join(f"({p})" for p in where_parts)
            update_sql = (
                f"UPDATE [{setup_table}] SET {', '.join(set_clauses)} "
                f"WHERE {where_clause}"
            )
            cur.execute(update_sql, (*params, *where_params))
            affected = cur.rowcount
            conn.commit()

            return {
                "ok": True,
                "mock_number": mock_number,
                "rows_updated": affected,
                "entity": entity,
                "source": source,
                "validation_group_id": validation_group_id,
                "reason": reason,
                "actor": actor,
            }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}
