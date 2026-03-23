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

# All columns from the reference table SETUP_CONVERSION_PLAN_MOCK12,
# plus additional tracking columns we add for version control.
SETUP_COLUMNS = [
    # ── Original reference columns (54) ──
    "Pillar",
    "Module",
    "Entity",
    "Data_Sources",
    "Table_Name",
    "LOAD_REQUIRED",
    "LOAD_ON_LAST_LOAD_TABLE",
    "RESPONSE",
    "Entity_Requested_to_Source",
    "On_Conversion_Plan",
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
    "POSTMOCK",
    "FileName",
    "File_Expected",
    "ExtracteFieldBU",
    "Validation_ViewPrefix",
    "CONVERSION_TABLE_DELTA01",
    "ExtractMethod",
    "ValidationSourceExist",
    "ValidationBeforeSendExist",
    "Validation_Program",
    "SplitReportsByBU",
    "DataRequest",
    "BU",
    "Validation_ViewPrefix_BefSend",
    "RequiredPhase2",
    # ── New tracking columns ──
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

    If a row with the same Table_Name already exists, update it with new
    version info. Otherwise insert a new row.

    Args:
        cursor: pyodbc cursor
        mock_number: e.g. 'MOCK12'
        parsed: dict from parse_filename()
        table_name: the SQL table name the file was loaded into
        row_count: number of rows loaded
        df: pandas DataFrame of the file data (for BU extraction)
        triggered_by: who triggered the load
        file_key: S3 source key
        file_size: file size in bytes
    """
    setup_table = _get_setup_table_name(mock_number)
    now = datetime.utcnow().isoformat()

    # Extract BU from file data if available
    bu_value = None
    if df is not None:
        bu_value = _extract_bu_from_dataframe(df)

    # Check if this table_name already has a row
    cursor.execute(
        f"SELECT [LoadedAt], [LoadVersion] FROM [{setup_table}] "
        f"WHERE [Table_Name] = ?",
        (table_name,)
    )
    existing = cursor.fetchone()

    entity_prefix = parsed.get("entity_prefix", "")
    source = parsed.get("source", "")
    module = parsed.get("module", "")
    entity_display = parsed.get("entity_display", "")
    file_timestamp = ""
    if parsed.get("date"):
        file_timestamp = parsed["date"]
        if parsed.get("time"):
            file_timestamp += f" {parsed['time']}"

    if existing:
        # Update existing row — increment version, preserve previous load time
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

        # Also update BU if we extracted one
        if bu_value:
            update_sql += ", [BU] = ?"
            params.append(bu_value)

        update_sql += " WHERE [Table_Name] = ?"
        params.append(table_name)

        cursor.execute(update_sql, params)
        cursor.connection.commit()
        print(f"  Updated {setup_table}: {table_name} (version {new_version})")

    else:
        # Insert new row
        values = {
            "Pillar": _get_pillar_from_module(module),
            "Module": module,
            "Entity": entity_display,
            "Data_Sources": source,
            "Table_Name": table_name,
            "LOAD_REQUIRED": "YES",
            "SubEntity": entity_prefix,
            "SOURCE": source,
            "FileName": parsed.get("filename", ""),
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

        # Build INSERT statement with only the columns we have values for
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
        print(f"  Inserted into {setup_table}: {table_name} (version 1)")


def track_file_load(connection_str, mock_number, parsed, table_name,
                    row_count, df=None, triggered_by="",
                    file_key="", file_size=0):
    """
    High-level function to track a file load in the conversion plan.

    Creates the SETUP_CONVERSION_PLAN_{MOCK} table if needed, then
    upserts the file's row.

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
    except Exception as e:
        # Don't fail the whole file load if tracking fails
        print(f"  WARNING: Failed to track file in conversion plan: {e}")
        import traceback
        traceback.print_exc()
