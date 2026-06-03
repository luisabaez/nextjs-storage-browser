"""
Data File Processor Lambda Function
====================================
Processes FIN, SCM, and HCM data files (CSV/XLSX) from S3, validates them,
and loads data into SQL Server staging tables (Hacienda_ERP_Test database).

Invoked via Lambda Function URL with query parameters:
    ?action=process  — Process all files in InputFiles/
    ?action=status   — Return current processing status
    ?action=history  — Return processing run history
    ?action=entities — Return entity registry for dashboard dropdowns

Optional filters:
    &module=FIN      — Only process files for a specific module
    &entity=GL_BALANCES — Only process files matching entity
    &mock=MOCK10     — Only process files with specific mock number

Environment:
    - S3 Bucket: hacienda-erp-dev
    - Database: Hacienda_ERP_Test (via Secrets Manager)
    - VPC: Same as TestFunction (for SQL Server access at 10.0.151.32)
"""

import json
import boto3
import pyodbc
import pandas as pd
import io
import traceback
from datetime import datetime

from file_validator import parse_filename, validate_source, validate_csv_headers
from entity_registry import (
    ENTITY_REGISTRY,
    get_entity_info,
    get_table_name as registry_get_table_name,
    get_all_entities_for_module,
    get_all_modules,
    sanitize_column_name,
)

# Legacy AP Invoice imports (backward compat)
from column_mappings import get_mapping as legacy_get_mapping
from column_mappings import get_table_name as legacy_get_table_name
from table_definitions import get_create_table_sql as legacy_get_create_table_sql

# New column registry for non-legacy entities
from column_registry import get_column_mapping

# Conversion plan tracking — auto-populates SETUP_CONVERSION_PLAN_{MOCK}
from conversion_plan_tracker import track_file_load

# Mock promotion — clones a Mock's schema/data into a new Mock (admin action)
from promote_mock import handle_promote_mock_request

# AWS_FILES event-log writer — tracks every S3 file transition through the
# pipeline. Imported as a module so per-call failures (caught inside each
# function via the _safe decorator) never abort the main file load.
import aws_files_writer

# ─── Configuration ────────────────────────────────────────────────────────────

DEFAULT_BUCKET = "hacienda-erp-dev"
INPUT_FOLDER = "InputFilesForProcessing/"
PROCESSED_FOLDER = "ProcessedFiles/"
FAILED_FOLDER = "FailedInvoices/"
FAILED_UNMATCHED_FOLDER = "FailedUnmatchedFilenames/"
STATUS_FILE_KEY = "InputFilesForProcessing/_processing_status.json"
HISTORY_FOLDER_KEY = "InputFilesForProcessing/_processing_history/"

# Chunked processing: files larger than this threshold are read in chunks
# to avoid excessive memory usage when building the pandas DataFrame.
CHUNK_THRESHOLD = 50 * 1024 * 1024   # 50 MB
CHUNK_ROWS = 50000                    # 50k rows per chunk

# Auto-continuation: when the Lambda is about to timeout with pending files,
# it self-invokes to continue processing.  Safety cap prevents infinite loops.
MAX_CONTINUATION_RUNS = 10
CONTINUATION_TIMEOUT_RESERVE_MS = 60000  # 1 min before timeout → trigger continuation

s3_client = boto3.client("s3")
lambda_client = boto3.client("lambda")


def get_connection_string():
    """Retrieve SQL Server connection string from Secrets Manager."""
    sm_client = boto3.client("secretsmanager", region_name="us-east-1")
    response = sm_client.get_secret_value(SecretId="Hacienda_ERP_Test_MSSQL_text")
    if "SecretString" in response:
        return response["SecretString"]
    return response["SecretBinary"].decode("utf-8")


# ─── S3 Helpers ───────────────────────────────────────────────────────────────

def list_input_files(bucket):
    """List all CSV/XLSX files in the input folder."""
    files = []
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=INPUT_FOLDER):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            name = key.split("/")[-1]
            # Skip folder markers, status files, hidden files
            if not name or name.startswith("_") or name.startswith(".") or key.endswith("/"):
                continue
            lower_name = name.lower()
            if lower_name.endswith(".csv") or lower_name.endswith(".xlsx"):
                files.append({
                    "key": key,
                    "name": name,
                    "size": obj["Size"],
                    "last_modified": obj["LastModified"].isoformat(),
                    # S3 returns ETag wrapped in double quotes — we strip in aws_files_writer
                    "etag": obj.get("ETag", ""),
                })
    return files


def move_file(bucket, source_key, dest_key):
    """Move a file within S3 (copy + delete)."""
    s3_client.copy_object(
        Bucket=bucket,
        CopySource={"Bucket": bucket, "Key": source_key},
        Key=dest_key,
    )
    s3_client.delete_object(Bucket=bucket, Key=source_key)


def write_status(bucket, status_data):
    """Write processing status to S3 for dashboard polling."""
    s3_client.put_object(
        Bucket=bucket,
        Key=STATUS_FILE_KEY,
        Body=json.dumps(status_data, default=str),
        ContentType="application/json",
    )


def write_history(bucket, status_data):
    """Archive the final processing status to history folder with timestamp key."""
    completed_at = status_data.get("completedAt", datetime.utcnow().isoformat())
    safe_timestamp = completed_at.replace(":", "-")
    if "." in safe_timestamp:
        safe_timestamp = safe_timestamp.split(".")[0]
    safe_timestamp += "Z"
    history_key = f"{HISTORY_FOLDER_KEY}{safe_timestamp}.json"

    history_data = dict(status_data)
    if status_data.get("startedAt") and status_data.get("completedAt"):
        try:
            start = datetime.fromisoformat(status_data["startedAt"])
            end = datetime.fromisoformat(status_data["completedAt"])
            history_data["durationSeconds"] = (end - start).total_seconds()
        except (ValueError, TypeError):
            pass

    s3_client.put_object(
        Bucket=bucket,
        Key=history_key,
        Body=json.dumps(history_data, default=str),
        ContentType="application/json",
    )
    print(f"  Archived processing history to: {history_key}")

    # Also write to SQL Server history table
    try:
        total_rows_uploaded = sum(
            f.get("rowCount", 0) for f in history_data.get("files", [])
            if f.get("status") == "success"
        )
        write_history_to_db(history_data, history_key, total_rows_uploaded)
    except Exception as db_err:
        print(f"  WARNING: Failed to write history to DB: {db_err}")


def write_history_to_db(status_data, s3_history_key, total_rows_uploaded):
    """Write a summary row to FileProcessingRuns table in SQL Server."""
    conn_str = get_connection_string()
    conn = pyodbc.connect(conn_str)
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO FileProcessingRuns
                (Status, StartedAt, CompletedAt, DurationSeconds, TriggeredBy,
                 TotalFiles, ProcessedFiles, SuccessCount, FailCount,
                 TotalRowsUploaded, ContinuationRuns, PendingFiles, S3HistoryKey)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            status_data.get("status", "unknown"),
            status_data.get("startedAt"),
            status_data.get("completedAt"),
            status_data.get("durationSeconds"),
            status_data.get("triggeredBy", ""),
            status_data.get("totalFiles", 0),
            status_data.get("processedFiles", 0),
            status_data.get("successCount", 0),
            status_data.get("failCount", 0),
            total_rows_uploaded,
            status_data.get("continuationRun", 0),
            status_data.get("pendingFiles", 0),
            s3_history_key,
        )
        conn.commit()
        print(f"  Wrote processing run to FileProcessingRuns table")
    finally:
        conn.close()


def write_error_file(bucket, file_key, error_message):
    """Write an error detail file next to the failed file."""
    error_key = file_key + "_error.txt"
    s3_client.put_object(
        Bucket=bucket,
        Key=error_key,
        Body=error_message,
        ContentType="text/plain",
    )


def self_invoke_continuation(context, bucket, filters, continuation_run, triggered_by=""):
    """
    Asynchronously invoke this Lambda again to continue processing
    remaining files.  Returns True if invocation succeeded.
    """
    if continuation_run >= MAX_CONTINUATION_RUNS:
        print(f"  Reached max continuation runs ({MAX_CONTINUATION_RUNS}), stopping.")
        return False

    # Get our own function name from the context
    function_name = getattr(context, "function_name", None)
    if not function_name:
        print("  Cannot self-invoke: no function_name in context")
        return False

    payload = {
        "_continuation": True,
        "_continuation_run": continuation_run + 1,
        "bucket": bucket,
        "module": filters.get("module", ""),
        "entity": filters.get("entity", ""),
        "source": filters.get("source", ""),
        "mock": filters.get("mock", ""),
        "triggeredBy": triggered_by,
    }

    print(f"  Self-invoking continuation run #{continuation_run + 1} "
          f"(function: {function_name})")

    try:
        lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="Event",  # Async — fire and forget
            Payload=json.dumps(payload),
        )
        return True
    except Exception as e:
        print(f"  Failed to self-invoke: {e}")
        return False


def _download_s3_content(bucket, key):
    """Download file bytes from S3."""
    response = s3_client.get_object(Bucket=bucket, Key=key)
    return response["Body"].read()


def read_file_from_s3(bucket, key, extension):
    """Read a CSV or XLSX file from S3 into a pandas DataFrame."""
    content = _download_s3_content(bucket, key)

    if extension == "xlsx":
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            raise ValueError("openpyxl is required for XLSX files but not installed")
        df = pd.read_excel(io.BytesIO(content), dtype=str, engine="openpyxl")
    else:
        # Try UTF-8 first, fall back to latin-1 for Spanish/accented characters
        try:
            df = pd.read_csv(io.BytesIO(content), dtype=str, encoding="utf-8")
        except UnicodeDecodeError:
            print("  UTF-8 failed, falling back to latin-1 encoding")
            df = pd.read_csv(io.BytesIO(content), dtype=str, encoding="latin-1")

    df = df.fillna("")
    return df


def read_file_from_s3_chunked(bucket, key, extension):
    """
    Read a large CSV from S3 in chunks.

    Returns (content_bytes, chunk_iterator) where chunk_iterator yields
    DataFrames of CHUNK_ROWS rows each.  For XLSX files, falls back to
    reading the whole file and returning it as a single-item list.

    The caller must keep ``content_bytes`` alive while iterating because
    the pandas TextFileReader holds a reference to the BytesIO wrapper.
    """
    content = _download_s3_content(bucket, key)

    if extension == "xlsx":
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            raise ValueError("openpyxl is required for XLSX files but not installed")
        df = pd.read_excel(io.BytesIO(content), dtype=str, engine="openpyxl")
        df = df.fillna("")
        return content, [df]

    # CSV chunked reading
    try:
        reader = pd.read_csv(
            io.BytesIO(content), dtype=str, encoding="utf-8",
            chunksize=CHUNK_ROWS,
        )
    except UnicodeDecodeError:
        print("  UTF-8 failed, falling back to latin-1 encoding")
        reader = pd.read_csv(
            io.BytesIO(content), dtype=str, encoding="latin-1",
            chunksize=CHUNK_ROWS,
        )

    return content, reader


# ─── Table Management ─────────────────────────────────────────────────────────

def ensure_table_exists_legacy(cursor, table_name, file_type, source):
    """Check if legacy AP Invoice table exists; create if not."""
    cursor.execute(
        "SELECT COUNT(*) FROM sys.tables WHERE name = ?",
        (table_name,)
    )
    exists = cursor.fetchone()[0] > 0

    if exists:
        print(f"  Table {table_name} exists")
        return False

    create_sql = legacy_get_create_table_sql(table_name, file_type, source)
    if not create_sql:
        raise ValueError(
            f"Cannot auto-create table {table_name}: "
            f"no definition for type={file_type}, source={source}"
        )

    print(f"  Creating table {table_name}...")
    cursor.execute(create_sql)
    cursor.connection.commit()
    print(f"  Table {table_name} created successfully")
    return True


def ensure_table_exists_dynamic(cursor, table_name, sql_columns):
    """
    Check if a table exists; create it dynamically from SQL column names.
    All columns are NVARCHAR(500) to match the existing pattern.
    If the table exists but has a different schema, drop and recreate it.
    """
    cursor.execute(
        "SELECT COUNT(*) FROM sys.tables WHERE name = ?",
        (table_name,)
    )
    exists = cursor.fetchone()[0] > 0

    if exists:
        # Verify schema matches — get existing column names
        cursor.execute(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (table_name,)
        )
        existing_cols = {row[0].upper() for row in cursor.fetchall()}
        expected_cols = {col.upper() for col in sql_columns}

        if expected_cols.issubset(existing_cols):
            print(f"  Table {table_name} exists (schema compatible)")
            return False

        # Schema mismatch — drop and recreate
        print(f"  Table {table_name} exists but schema differs, recreating...")
        cursor.execute(f"DROP TABLE [{table_name}]")
        cursor.connection.commit()

    # Build CREATE TABLE with all NVARCHAR(500) columns
    col_defs = ",\n    ".join(f"[{col}] NVARCHAR(500)" for col in sql_columns)
    create_sql = f"CREATE TABLE [{table_name}] (\n    {col_defs}\n)"

    print(f"  Creating table {table_name}...")
    cursor.execute(create_sql)
    cursor.connection.commit()
    print(f"  Table {table_name} created successfully")
    return True


# ─── Processing Logic ─────────────────────────────────────────────────────────

def process_single_file(bucket, file_info, connection_str, context=None, triggered_by=""):
    """
    Process a single data file (CSV or XLSX).

    Returns:
        dict with keys: filename, status, rowCount, error, source, module,
                        entity, entityDisplay, mockNumber
    """
    filename = file_info["name"]
    file_key = file_info["key"]
    result = {
        "filename": filename,
        "source": "",
        "module": "",
        "entity": "",
        "entityDisplay": "",
        "type": "",  # backward compat
        "mockNumber": "",
        "status": "processing",
        "rowCount": 0,
        "error": None,
        "startedAt": datetime.utcnow().isoformat(),
        "completedAt": None,
    }

    # eTag captured up front so AWS_FILES rows can be written/updated
    # regardless of which branch of the pipeline this file takes.
    file_etag = file_info.get("etag", "")
    result["etag"] = file_etag

    try:
        file_size = file_info.get("size", 0)
        is_large_file = file_size > CHUNK_THRESHOLD

        # Step 1: Parse filename
        parsed = parse_filename(filename)

        # ── AWS_FILES: write seq 1 'Received' row ──
        # Always write a row, even when parsing fails — the dashboard needs
        # visibility into bad files too. If parse succeeded, the row gets the
        # full FK metadata (validation_group_id, WBS_ID, etc.).
        aws_files_writer.write_received_row(
            connection_str=connection_str,
            bucket=bucket,
            file_key=file_key,
            etag=file_etag,
            file_size_bytes=file_size,
            parsed=parsed if parsed["valid"] else None,
            triggered_by=triggered_by,
        )

        if not parsed["valid"]:
            aws_files_writer.mark_gate_check_failure(
                connection_str, file_etag,
                "Check_File_Name", parsed["error"],
            )
            raise ValueError(f"Invalid filename: {parsed['error']}")

        # Gate 1 passed
        aws_files_writer.update_gate_check(
            connection_str, file_etag, "Check_File_Name", aws_files_writer.CHECK_PASS,
        )

        if parsed["is_excluded"]:
            aws_files_writer.mark_gate_check_failure(
                connection_str, file_etag,
                "Check_File_Expected", "Entity is excluded from this Mock",
            )
            raise ValueError(f"File belongs to an excluded entity: {filename}")

        result["source"] = parsed["source"]
        result["module"] = parsed["module"]
        result["entity"] = parsed["entity_prefix"]
        result["entityDisplay"] = parsed["entity_display"]
        result["mockNumber"] = parsed["mock_number"]
        # Backward compat
        result["type"] = parsed.get("file_type", parsed["entity_prefix"])

        entity_prefix = parsed["entity_prefix"]
        source = parsed["source"]
        mock_number = parsed["mock_number"]
        extension = parsed["extension"]
        is_legacy = parsed["is_legacy"]

        print(f"Processing: {filename} | Module={parsed['module']} Entity={entity_prefix} "
              f"Source={source} Mock={mock_number}")

        # Step 2: Validate source
        if not validate_source(source):
            print(f"  WARNING: Unknown source agency '{source}', proceeding anyway")

        # Gate 2: File_Expected check
        # Query SETUP_CONVERSION_PLAN_{MOCK} for File_Expected on this entity.
        # If 'N' the file should not have been uploaded — reject before reading.
        # When the entity row isn't in the plan yet (first time we see it), we
        # treat that as Expected=Y so onboarding doesn't break.
        file_expected_ok = True
        file_expected_msg = ""
        try:
            with pyodbc.connect(connection_str) as fe_conn:
                fe_cur = fe_conn.cursor()
                setup_table = f"SETUP_CONVERSION_PLAN_{mock_number}"
                fe_cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (setup_table,))
                if fe_cur.fetchone()[0] > 0:
                    fe_cur.execute(
                        f"SELECT TOP 1 [File_Expected] FROM [{setup_table}] "
                        f"WHERE LTRIM(RTRIM(ISNULL([Entity], ''))) = ? "
                        f"AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?",
                        (parsed.get("entity_display") or entity_prefix, source),
                    )
                    fe_row = fe_cur.fetchone()
                    if fe_row and (fe_row[0] or "").strip().upper() == "N":
                        file_expected_ok = False
                        file_expected_msg = (
                            f"Entity {entity_prefix}/{source} has File_Expected=N in {setup_table}"
                        )
        except Exception as fe_err:
            # Don't block processing if the lookup itself blows up
            print(f"  WARNING: File_Expected lookup failed: {fe_err}")

        if not file_expected_ok:
            aws_files_writer.mark_gate_check_failure(
                connection_str, file_etag,
                "Check_File_Expected", file_expected_msg,
            )
            raise ValueError(f"File Not Expected: {file_expected_msg}")
        aws_files_writer.update_gate_check(
            connection_str, file_etag, "Check_File_Expected", aws_files_writer.CHECK_PASS,
        )

        # Step 3: Read file from S3
        file_size_mb = file_size / (1024 * 1024)
        print(f"  Reading {extension.upper()} from S3: {file_key} ({file_size_mb:.1f} MB)")

        if is_large_file:
            print(f"  Large file — using chunked processing "
                  f"(threshold={CHUNK_THRESHOLD / (1024*1024):.0f} MB)")
            content_bytes, chunk_iter = read_file_from_s3_chunked(
                bucket, file_key, extension
            )
            first_chunk = next(chunk_iter)
            first_chunk = first_chunk.fillna("")
            print(f"  First chunk loaded: {len(first_chunk)} rows, "
                  f"{len(first_chunk.columns)} columns")
            if len(first_chunk) == 0:
                raise ValueError("File is empty (header only, no data rows)")
            # Use first chunk for header validation; chunk_iter has remaining
            df = first_chunk
        else:
            df = read_file_from_s3(bucket, file_key, extension)
            print(f"  File loaded: {len(df)} rows, {len(df.columns)} columns")
            if len(df) == 0:
                raise ValueError("File is empty (header only, no data rows)")
            chunk_iter = None
            content_bytes = None

        # Step 4: Route to legacy or new processing path
        if is_legacy and parsed.get("file_type"):
            # Legacy AP Invoice path
            file_type = parsed["file_type"]
            mapping = legacy_get_mapping(file_type, source)
            if not mapping:
                raise ValueError(
                    f"No column mapping found for legacy type={file_type}, source={source}"
                )

            # Validate CSV headers (gate 3)
            actual_headers = list(df.columns)
            is_valid, header_error = validate_csv_headers(actual_headers, mapping["csv_columns"])
            if not is_valid:
                aws_files_writer.mark_gate_check_failure(
                    connection_str, file_etag,
                    "Check_Column_Headers", header_error,
                )
                raise ValueError(f"Header validation failed: {header_error}")
            aws_files_writer.update_gate_check(
                connection_str, file_etag, "Check_Column_Headers", aws_files_writer.CHECK_PASS,
            )

            table_name = legacy_get_table_name(file_type, mock_number, source)
            sql_columns = mapping["sql_columns"]
            csv_columns = mapping["csv_columns"]

            print(f"  Target table (legacy): {table_name}")

            with pyodbc.connect(connection_str) as conn:
                cursor = conn.cursor()
                was_created = ensure_table_exists_legacy(cursor, table_name, file_type, source)

                if not was_created:
                    print(f"  Truncating table: {table_name}")
                    cursor.execute(f"DELETE FROM [{table_name}]")
                    conn.commit()

                if is_large_file:
                    result["rowCount"] = _insert_chunks(
                        df, chunk_iter, csv_columns, sql_columns,
                        table_name, cursor, conn, context,
                    )
                else:
                    rows = _build_rows(df, csv_columns)
                    _batch_insert(cursor, conn, table_name, sql_columns, rows)
                    result["rowCount"] = len(rows)

        else:
            # New multi-module processing path
            mapping = get_column_mapping(entity_prefix, source)
            use_mapped = False

            if mapping:
                # Mapping found — validate headers
                csv_columns = mapping["csv_columns"]
                sql_columns = mapping["sql_columns"]

                actual_headers = list(df.columns)
                is_valid, header_error = validate_csv_headers(actual_headers, csv_columns)
                if is_valid:
                    use_mapped = True
                else:
                    print(f"  WARNING: Header mismatch ({header_error}), "
                          f"falling back to dynamic processing")

            if not use_mapped:
                # No mapping or header mismatch — dynamic fallback
                if not mapping:
                    print(f"  WARNING: No column mapping for {entity_prefix}/{source}, "
                          f"using dynamic fallback")
                actual_headers = list(df.columns)
                sql_columns = [sanitize_column_name(h) for h in actual_headers]
                csv_columns = actual_headers

            # Gate 3 (Check_Column_Headers): file gets loaded either via the
            # mapped schema OR the dynamic fallback — both are valid Pass
            # outcomes from the gate-check perspective. Hard failure only
            # raises when the file can't be processed at all (handled below
            # in the outer except as TSQL_Load_Error).
            aws_files_writer.update_gate_check(
                connection_str, file_etag, "Check_Column_Headers", aws_files_writer.CHECK_PASS,
            )

            table_name = registry_get_table_name(entity_prefix, mock_number, source)
            print(f"  Target table ({'mapped' if use_mapped else 'dynamic'}): {table_name}")

            with pyodbc.connect(connection_str) as conn:
                cursor = conn.cursor()
                was_created = ensure_table_exists_dynamic(cursor, table_name, sql_columns)

                if not was_created:
                    print(f"  Truncating table: {table_name}")
                    cursor.execute(f"DELETE FROM [{table_name}]")
                    conn.commit()

                if is_large_file:
                    result["rowCount"] = _insert_chunks(
                        df, chunk_iter, csv_columns, sql_columns,
                        table_name, cursor, conn, context,
                    )
                else:
                    rows = _build_rows(df, csv_columns)
                    _batch_insert(cursor, conn, table_name, sql_columns, rows)
                    result["rowCount"] = len(rows)

        # Gates 4 & 5 pass + record final state on the seq 1 row
        aws_files_writer.mark_load_success(
            connection_str, file_etag, table_name, result["rowCount"],
        )
        # Capture Business_Unit (denorm'd onto AWS_FILES for filter/permissions)
        try:
            from conversion_plan_tracker import _extract_bu_from_dataframe
            bu_value = _extract_bu_from_dataframe(df)
            if bu_value:
                aws_files_writer.update_business_unit(connection_str, file_etag, bu_value)
        except Exception as bu_err:
            print(f"  WARNING: BU extraction failed: {bu_err}")

        # Step 5: Move to processed folder (organized by MODULE/MOCK/SOURCE/ENTITY)
        dest_key = f"{PROCESSED_FOLDER}{parsed['module']}/{mock_number}/{source}/{entity_prefix}/{filename}"
        move_file(bucket, file_key, dest_key)
        print(f"  Moved to: {dest_key}")

        # Seq 2 AWS_FILES row at the new S3 location
        aws_files_writer.write_seq2_move_row(connection_str, file_etag, bucket, dest_key)

        # Step 6: Track file in SETUP_CONVERSION_PLAN_{MOCK}
        # Pass dest_key so the table stores where the file lives now
        track_file_load(
            connection_str, mock_number, parsed, table_name,
            row_count=result["rowCount"], df=df,
            triggered_by=triggered_by,
            file_key=dest_key,
            file_size=file_info.get("size", 0),
        )

        result["status"] = "success"
        result["completedAt"] = datetime.utcnow().isoformat()

    except Exception as e:
        error_msg = str(e)
        tb = traceback.format_exc()
        print(f"  ERROR processing {filename}: {error_msg}")
        print(f"  Traceback: {tb}")

        result["status"] = "failed"
        result["error"] = error_msg
        result["completedAt"] = datetime.utcnow().isoformat()

        # If the failure happened past the gate-check stage (i.e. during the
        # actual TSQL load), record it as Check_TSQL_Load = Fail. Earlier gate
        # failures already wrote their own AWS_FILES row update before raising
        # — mark_gate_check_failure is idempotent-ish for the eTag so re-marking
        # a later gate doesn't undo the earlier one (it only writes if the
        # column isn't already Fail).
        try:
            err_text = (error_msg or "").lower()
            already_marked = any(
                m in err_text for m in (
                    "invalid filename:", "file belongs to an excluded entity",
                    "file not expected:", "header validation failed:",
                )
            )
            if not already_marked:
                aws_files_writer.mark_gate_check_failure(
                    connection_str, file_etag,
                    "Check_TSQL_Load", error_msg[:500],
                )
        except Exception as gate_err:
            print(f"  WARNING: aws_files_writer gate marker failed: {gate_err}")

        # Move to failed folder
        try:
            mock = result.get("mockNumber", "unknown")
            src = result.get("source", "unknown")
            mod = result.get("module", "")
            entity = result.get("entity", "")
            if mock and src and mock != "" and src != "" and mod and entity:
                dest_key = f"{FAILED_FOLDER}{mod}/{mock}/{src}/{entity}/{filename}"
            elif mock and src and mock != "" and src != "":
                dest_key = f"{FAILED_FOLDER}{filename}"
            else:
                dest_key = f"{FAILED_UNMATCHED_FOLDER}{filename}"
            move_file(bucket, file_key, dest_key)
            write_error_file(bucket, dest_key, f"{error_msg}\n\n{tb}")
            print(f"  Moved to: {dest_key}")
            # Record where the failed file ended up on the seq 1 row
            aws_files_writer.mark_moved_to_errors(connection_str, file_etag, dest_key)
        except Exception as move_err:
            print(f"  ERROR moving failed file: {move_err}")

    return result


def _build_rows(df, csv_columns):
    """Build list of tuples from DataFrame for SQL insert."""
    rows = []
    for _, row in df.iterrows():
        values = []
        for csv_col in csv_columns:
            val = str(row.get(csv_col, "")).strip()
            values.append(val if val else None)
        rows.append(tuple(values))
    return rows


def _batch_insert(cursor, conn, table_name, sql_columns, rows):
    """Insert rows in batches of 1000."""
    placeholders = ", ".join(["?"] * len(sql_columns))
    col_list = ", ".join(f"[{c}]" for c in sql_columns)
    insert_sql = f"INSERT INTO [{table_name}] ({col_list}) VALUES ({placeholders})"
    print(f"  Inserting {len(rows)} rows...")

    batch_size = 1000
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        cursor.executemany(insert_sql, batch)
        conn.commit()

    print(f"  Successfully inserted {len(rows)} rows into {table_name}")


def _insert_chunks(first_chunk_df, chunk_iter, csv_columns, sql_columns,
                   table_name, cursor, conn, context=None):
    """
    Insert the first chunk then iterate remaining chunks with timeout awareness.

    ``first_chunk_df`` is the already-loaded first DataFrame chunk (used for
    header validation above).  ``chunk_iter`` yields the remaining chunks.
    Returns total row count inserted across all chunks.
    """
    TIME_RESERVE_CHUNK_MS = 120000  # 2 min reserve — must leave enough time
    # for: file move in S3 (slow for large files), status writes, and
    # self-invocation for continuation runs.

    # Insert first chunk
    rows = _build_rows(first_chunk_df, csv_columns)
    _batch_insert(cursor, conn, table_name, sql_columns, rows)
    total_rows = len(rows)
    chunk_idx = 0

    # Process remaining chunks
    for chunk_df in chunk_iter:
        chunk_idx += 1

        # Check Lambda timeout between chunks
        if context and hasattr(context, "get_remaining_time_in_millis"):
            remaining = context.get_remaining_time_in_millis()
            if remaining < TIME_RESERVE_CHUNK_MS:
                print(f"  Timeout approaching at chunk {chunk_idx}: "
                      f"{remaining}ms left, {total_rows} rows inserted so far")
                break

        chunk_df = chunk_df.fillna("")
        rows = _build_rows(chunk_df, csv_columns)
        _batch_insert(cursor, conn, table_name, sql_columns, rows)
        total_rows += len(rows)
        print(f"  Chunk {chunk_idx}: +{len(rows)} rows (total: {total_rows})")

    print(f"  Chunked insert complete: {total_rows} rows "
          f"across {chunk_idx + 1} chunk(s)")
    return total_rows


# ─── Lambda Handler ───────────────────────────────────────────────────────────

def lambda_handler(event, context):
    """
    Main Lambda handler.

    Supports actions:
        ?action=process   — Process all files in input folder
        ?action=continue  — Continue processing remaining files (self-invoked)
        ?action=status    — Return current processing status
        ?action=history   — Return processing run history
        ?action=entities  — Return entity registry for dashboard
    """
    # ── Ignore S3 event triggers ──
    # If this Lambda is accidentally configured with an S3 event notification,
    # the event will contain "Records" with "s3" data.  Silently ignore these
    # to prevent dozens of concurrent processing runs when files are uploaded.
    if "Records" in event and any(
        r.get("eventSource") == "aws:s3" for r in event.get("Records", [])
    ):
        print("Ignoring S3 event trigger — processing must be started manually")
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"status": "ignored", "reason": "S3 event trigger"}),
        }

    # Parse query params
    params = {}
    if "queryStringParameters" in event and event["queryStringParameters"]:
        params = event["queryStringParameters"]
    elif "rawQueryString" in event and event["rawQueryString"]:
        for param in event["rawQueryString"].split("&"):
            if "=" in param:
                k, v = param.split("=", 1)
                params[k] = v

    action = params.get("action", "process")
    filter_module = params.get("module", "").upper()
    filter_entity = params.get("entity", "").upper()
    filter_source = params.get("source", "").upper()
    filter_mock = params.get("mock", "").upper()

    # Auto-continuation: when invoked via Lambda.invoke() (not Function URL),
    # the event IS the JSON payload directly — no body wrapper.
    continuation_run = 0
    if event.get("_continuation"):
        action = "continue"
        continuation_run = event.get("_continuation_run", 1)
        filter_module = event.get("module", "").upper()
        filter_entity = event.get("entity", "").upper()
        filter_source = event.get("source", "").upper()
        filter_mock = event.get("mock", "").upper()
        bucket = event.get("bucket", DEFAULT_BUCKET)

    # Parse bucket and triggeredBy from body or use defaults
    triggered_by = ""
    if not event.get("_continuation"):
        bucket = DEFAULT_BUCKET
        if "body" in event and event["body"]:
            try:
                body = json.loads(event["body"])
                bucket = body.get("bucket", DEFAULT_BUCKET)
                triggered_by = body.get("triggeredBy", "")
            except (json.JSONDecodeError, TypeError):
                pass
    else:
        triggered_by = event.get("triggeredBy", "")

    print(f"Data File Processor: action={action}, bucket={bucket}, "
          f"module={filter_module}, entity={filter_entity}, "
          f"source={filter_source}, mock={filter_mock}")

    # Response headers — CORS is handled by Lambda Function URL config,
    # so we only set Content-Type here. Adding duplicate CORS headers
    # causes browsers to reject the response.
    headers = {
        "Content-Type": "application/json",
    }

    # Handle OPTIONS (CORS preflight) — handled by Function URL, but keep as fallback
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {"statusCode": 200, "headers": headers, "body": ""}

    # ── ENTITIES ACTION ──
    if action == "entities":
        try:
            modules = get_all_modules()
            entities_by_module = {}
            for mod in modules:
                entities_by_module[mod] = [
                    {"prefix": prefix, "displayName": info["display_name"], "legacy": info["legacy"]}
                    for prefix, info in get_all_entities_for_module(mod)
                ]
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({
                    "modules": modules,
                    "entities": entities_by_module,
                }),
            }
        except Exception as e:
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e)}),
            }

    # ── PROMOTE MOCK ACTION ──
    # Admin-only. Clones a source Mock's structural data into a new target Mock.
    # Two-phase UX in the dashboard: first call with dry_run=true to render the
    # preview, then call with dry_run=false to execute. Audit row always written
    # to MOCK_PROMOTIONS regardless of outcome.
    if action == "promote_mock":
        try:
            params = event.get("queryStringParameters") or {}
            source = params.get("source", "")
            target = params.get("target", "")
            actor = params.get("actor", "")
            dry_run = str(params.get("dry_run", "true")).lower() in ("true", "1", "yes")

            conn_str = get_connection_string()
            result = handle_promote_mock_request(
                connection_str=conn_str,
                source=source,
                target=target,
                actor=actor,
                dry_run=dry_run,
            )
            status_code = 200 if result.get("ok") else 400
            return {
                "statusCode": status_code,
                "headers": headers,
                "body": json.dumps(result, default=str),
            }
        except Exception as e:
            traceback.print_exc()
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"ok": False, "error": str(e)}),
            }

    # ── CONVERSION PLAN ACTION ──
    if action == "conversionplan":
        try:
            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cursor = conn.cursor()

                # Discover all SETUP_CONVERSION_PLAN_MOCK* tables
                cursor.execute(
                    "SELECT name FROM sys.tables "
                    "WHERE name LIKE 'SETUP_CONVERSION_PLAN_MOCK%' "
                    "ORDER BY name"
                )
                table_names = [row[0] for row in cursor.fetchall()]

                select_cols = [
                    "Pillar", "Module", "Entity", "SubEntity", "Data_Sources",
                    "Table_Name", "SOURCE", "FileName", "BU", "LoadedAt",
                    "LoadedBy", "FileTimestamp", "RowCount", "LoadVersion",
                    "PreviousLoadedAt", "S3SourceKey", "FileSize",
                    "LOAD_REQUIRED", "CONVERSION_TABLE_BU",
                ]
                col_list = ", ".join(f"[{c}]" for c in select_cols)

                entries = []
                mock_tables = []

                for tbl in table_names:
                    # Extract mock number from table name
                    mock = tbl.replace("SETUP_CONVERSION_PLAN_", "")
                    mock_tables.append(mock)

                    if filter_mock and filter_mock != mock.upper():
                        continue  # Skip this table entirely if mock filter doesn't match

                    # Check which of our desired columns actually exist in this table
                    cursor.execute(
                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                        "WHERE TABLE_NAME = ?",
                        (tbl,)
                    )
                    existing_cols = {row[0].upper(): row[0] for row in cursor.fetchall()}

                    # Only query columns that exist — skip tables without LoadedAt
                    if "LOADEDAT" not in existing_cols:
                        continue

                    available_cols = [c for c in select_cols if c.upper() in existing_cols]
                    avail_col_list = ", ".join(f"[{c}]" for c in available_cols)

                    # Apply optional server-side filters
                    where_clauses = ["[LoadedAt] IS NOT NULL", "[LoadedAt] != ''"]
                    params = []

                    if filter_module and "MODULE" in existing_cols:
                        where_clauses.append("[Module] = ?")
                        params.append(filter_module)
                    if filter_entity and "SUBENTITY" in existing_cols:
                        where_clauses.append("[SubEntity] = ?")
                        params.append(filter_entity)
                    if filter_source and "SOURCE" in existing_cols:
                        where_clauses.append("[SOURCE] = ?")
                        params.append(filter_source)

                    where_sql = " AND ".join(where_clauses)
                    query = f"SELECT {avail_col_list} FROM [{tbl}] WHERE {where_sql}"
                    cursor.execute(query, params)

                    for row in cursor.fetchall():
                        entry = {}
                        for i, col in enumerate(available_cols):
                            entry[col] = row[i] if row[i] is not None else ""
                        # Fill missing columns with empty string
                        for col in select_cols:
                            if col not in entry:
                                entry[col] = ""
                        entry["MockNumber"] = mock
                        entries.append(entry)

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({
                    "entries": entries,
                    "mockTables": mock_tables,
                }, default=str),
            }
        except Exception as e:
            tb = traceback.format_exc()
            print(f"ERROR in conversionplan action: {e}\n{tb}")
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e)}),
            }

    # ── HIERARCHY ACTION ──
    # Returns ALL rows (loaded + expected-not-loaded) for the hierarchy view
    if action == "hierarchy":
        try:
            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cursor = conn.cursor()

                cursor.execute(
                    "SELECT name FROM sys.tables "
                    "WHERE name LIKE 'SETUP_CONVERSION_PLAN_MOCK%' "
                    "ORDER BY name"
                )
                table_names = [row[0] for row in cursor.fetchall()]

                select_cols = [
                    "Pillar", "Module", "Entity", "SubEntity", "Data_Sources",
                    "Table_Name", "SOURCE", "FileName", "BU", "LoadedAt",
                    "LoadedBy", "FileTimestamp", "RowCount", "LoadVersion",
                    "S3SourceKey", "FileSize", "LOAD_REQUIRED",
                    "CONVERSION_TABLE_BU", "File_Expected",
                ]

                entries = []
                mock_tables = []

                for tbl in table_names:
                    mock = tbl.replace("SETUP_CONVERSION_PLAN_", "")
                    mock_tables.append(mock)

                    if filter_mock and filter_mock != mock.upper():
                        continue

                    # Check which columns exist in this table
                    cursor.execute(
                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                        "WHERE TABLE_NAME = ?",
                        (tbl,)
                    )
                    existing_cols = {row[0].upper(): row[0] for row in cursor.fetchall()}

                    available_cols = [c for c in select_cols if c.upper() in existing_cols]
                    avail_col_list = ", ".join(f"[{c}]" for c in available_cols)

                    # Return ALL rows — loaded files OR expected files
                    where_clauses = []
                    params = []

                    # Include rows that are expected OR have been loaded
                    has_file_expected = "FILE_EXPECTED" in existing_cols
                    has_loaded_at = "LOADEDAT" in existing_cols

                    if has_file_expected and has_loaded_at:
                        where_clauses.append(
                            "([File_Expected] IN ('Yes', 'Y', 'YES') "
                            "OR ([LoadedAt] IS NOT NULL AND [LoadedAt] != ''))"
                        )
                    elif has_file_expected:
                        where_clauses.append("[File_Expected] IN ('Yes', 'Y', 'YES')")
                    elif has_loaded_at:
                        where_clauses.append(
                            "[LoadedAt] IS NOT NULL AND [LoadedAt] != ''"
                        )
                    else:
                        # Table has neither column — include all rows
                        pass

                    if filter_module and "MODULE" in existing_cols:
                        where_clauses.append("[Module] = ?")
                        params.append(filter_module)
                    if filter_source and "SOURCE" in existing_cols:
                        where_clauses.append("[SOURCE] = ?")
                        params.append(filter_source)

                    where_sql = (" AND ".join(where_clauses)) if where_clauses else "1=1"
                    query = f"SELECT {avail_col_list} FROM [{tbl}] WHERE {where_sql}"
                    cursor.execute(query, params)

                    for row in cursor.fetchall():
                        entry = {}
                        for i, col in enumerate(available_cols):
                            entry[col] = row[i] if row[i] is not None else ""
                        for col in select_cols:
                            if col not in entry:
                                entry[col] = ""
                        entry["MockNumber"] = mock
                        entries.append(entry)

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({
                    "entries": entries,
                    "mockTables": mock_tables,
                }, default=str),
            }
        except Exception as e:
            tb = traceback.format_exc()
            print(f"ERROR in hierarchy action: {e}\n{tb}")
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e)}),
            }

    # ── STATUS ACTION ──
    if action == "status":
        try:
            response = s3_client.get_object(Bucket=bucket, Key=STATUS_FILE_KEY)
            status_data = json.loads(response["Body"].read().decode("utf-8"))
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps(status_data, default=str),
            }
        except s3_client.exceptions.NoSuchKey:
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({"status": "idle", "files": []}),
            }
        except Exception as e:
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e)}),
            }

    # ── HISTORY ACTION ──
    if action == "history":
        try:
            history_files = []
            paginator = s3_client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=HISTORY_FOLDER_KEY):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    name = key.split("/")[-1]
                    if not name or not name.endswith(".json"):
                        continue
                    history_files.append(key)

            history_files.sort(reverse=True)
            history_files = history_files[:50]

            runs = []
            for hf_key in history_files:
                try:
                    resp = s3_client.get_object(Bucket=bucket, Key=hf_key)
                    data = json.loads(resp["Body"].read().decode("utf-8"))
                    runs.append(data)
                except Exception:
                    continue

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({"runs": runs}, default=str),
            }
        except Exception as e:
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e)}),
            }

    # ── PROCESS / CONTINUE ACTION ──
    if action in ("process", "continue"):
        try:
            is_continuation = (action == "continue")

            # ── Concurrency guard: prevent parallel processing runs ──
            if not is_continuation:
                try:
                    resp = s3_client.get_object(Bucket=bucket, Key=STATUS_FILE_KEY)
                    current_status = json.loads(resp["Body"].read().decode("utf-8"))
                    if current_status.get("status") == "processing":
                        print("Processing already in progress — aborting duplicate run")
                        return {
                            "statusCode": 409,
                            "headers": headers,
                            "body": json.dumps({
                                "status": "already_processing",
                                "message": "A processing run is already in progress",
                                "startedAt": current_status.get("startedAt"),
                                "triggeredBy": current_status.get("triggeredBy", ""),
                            }),
                        }
                except s3_client.exceptions.NoSuchKey:
                    pass  # No status file yet — OK to proceed

            print(f"{'Continuation' if is_continuation else 'Initial'} run "
                  f"#{continuation_run}" if is_continuation else "")

            input_files = list_input_files(bucket)

            # Apply filters
            if filter_module or filter_entity or filter_source or filter_mock:
                filtered = []
                for f in input_files:
                    parsed = parse_filename(f["name"])
                    if filter_module and (parsed.get("module") or "").upper() != filter_module:
                        continue
                    if filter_entity and (parsed.get("entity_prefix") or "").upper() != filter_entity:
                        continue
                    if filter_source and (parsed.get("source") or "").upper() != filter_source:
                        continue
                    if filter_mock and (parsed.get("mock_number") or "").upper() != filter_mock:
                        continue
                    filtered.append(f)
                input_files = filtered

            if not input_files:
                if is_continuation:
                    # All files have been processed in previous runs — finalize
                    try:
                        resp = s3_client.get_object(Bucket=bucket, Key=STATUS_FILE_KEY)
                        status = json.loads(resp["Body"].read().decode("utf-8"))
                    except Exception:
                        status = {}
                    status["status"] = "complete"
                    status["completedAt"] = datetime.utcnow().isoformat()
                    status.pop("timedOut", None)
                    status.pop("continuing", None)
                    status["pendingFiles"] = 0
                    write_status(bucket, status)
                    write_history(bucket, status)
                    print("Continuation: no remaining files — all done!")
                    return {
                        "statusCode": 200, "headers": headers,
                        "body": json.dumps(status, default=str),
                    }

                return {
                    "statusCode": 200,
                    "headers": headers,
                    "body": json.dumps({
                        "status": "complete",
                        "message": "No files found matching criteria",
                        "totalFiles": 0,
                        "processedFiles": 0,
                        "successCount": 0,
                        "failCount": 0,
                        "files": [],
                    }),
                }

            # Sort smallest files first so we maximize throughput per run.
            # Large files that would timeout are pushed to the end.
            input_files.sort(key=lambda f: f.get("size", 0))

            print(f"Found {len(input_files)} file(s) to process "
                  f"(sorted by size: {input_files[0]['size']/(1024*1024):.1f} MB "
                  f"to {input_files[-1]['size']/(1024*1024):.1f} MB)")

            # ── Build or update status ──
            if is_continuation:
                # Read existing status from S3 — preserves history of already-
                # processed files from previous runs in this batch.
                try:
                    resp = s3_client.get_object(Bucket=bucket, Key=STATUS_FILE_KEY)
                    status = json.loads(resp["Body"].read().decode("utf-8"))
                except Exception:
                    status = {
                        "status": "processing",
                        "startedAt": datetime.utcnow().isoformat(),
                        "completedAt": None,
                        "totalFiles": 0,
                        "processedFiles": 0,
                        "successCount": 0,
                        "failCount": 0,
                        "files": [],
                    }

                # Reset any leftover "pending" entries for files that were
                # already moved out of InputFiles in a previous run
                remaining_names = {f["name"] for f in input_files}
                status["files"] = [
                    sf for sf in status.get("files", [])
                    if sf["status"] != "pending" or sf["filename"] in remaining_names
                ]

                # Add entries for newly-found files not yet in status
                existing_names = {sf["filename"] for sf in status["files"]}
                for f in input_files:
                    if f["name"] not in existing_names:
                        parsed = parse_filename(f["name"])
                        status["files"].append({
                            "filename": f["name"],
                            "source": parsed.get("source", ""),
                            "module": parsed.get("module", ""),
                            "entity": parsed.get("entity_prefix", ""),
                            "entityDisplay": parsed.get("entity_display", ""),
                            "type": parsed.get("file_type", parsed.get("entity_prefix", "")),
                            "mockNumber": parsed.get("mock_number", ""),
                            "status": "pending",
                            "rowCount": 0,
                            "error": None,
                            "startedAt": None,
                            "completedAt": None,
                        })

                # Update counts and mark as processing again
                status["status"] = "processing"
                status["completedAt"] = None
                status["totalFiles"] = len(status["files"])
                status["processedFiles"] = sum(
                    1 for sf in status["files"] if sf["status"] in ("success", "failed")
                )
                status.pop("timedOut", None)
                status.pop("continuing", None)
                status["continuationRun"] = continuation_run
            else:
                # Fresh run — initialize status
                status = {
                    "status": "processing",
                    "startedAt": datetime.utcnow().isoformat(),
                    "completedAt": None,
                    "totalFiles": len(input_files),
                    "processedFiles": 0,
                    "successCount": 0,
                    "failCount": 0,
                    "triggeredBy": triggered_by,
                    "files": [],
                }

                for f in input_files:
                    parsed = parse_filename(f["name"])
                    status["files"].append({
                        "filename": f["name"],
                        "source": parsed.get("source", ""),
                        "module": parsed.get("module", ""),
                        "entity": parsed.get("entity_prefix", ""),
                        "entityDisplay": parsed.get("entity_display", ""),
                        "type": parsed.get("file_type", parsed.get("entity_prefix", "")),
                        "mockNumber": parsed.get("mock_number", ""),
                        "status": "pending",
                        "rowCount": 0,
                        "error": None,
                        "startedAt": None,
                        "completedAt": None,
                    })

            write_status(bucket, status)

            # Get SQL connection string
            connection_str = get_connection_string()

            # Process each file (with timeout awareness)
            TIME_RESERVE_MS = 120000        # 2 min reserved for cleanup / status write
            FILE_TIME_PER_MB_MS = 2500      # ~2.5 s/MB for small files
            FILE_TIME_PER_MB_CHUNKED_MS = 200  # ~0.2 s/MB for large files (S3 download only)
            MIN_FILE_TIME_MS = 15000        # Minimum 15 s per file
            MIN_FILE_TIME_CHUNKED_MS = 60000  # Minimum 60 s for a chunked file start
            timed_out = False

            # Build index mapping from input_files to their status["files"] entries
            status_index = {}
            for idx, sf in enumerate(status["files"]):
                if sf["status"] == "pending":
                    status_index[sf["filename"]] = idx

            try:
                for file_info in input_files:
                    si = status_index.get(file_info["name"])
                    if si is None:
                        continue  # Already processed in a previous run

                    # Check remaining Lambda execution time
                    if context and hasattr(context, "get_remaining_time_in_millis"):
                        remaining_ms = context.get_remaining_time_in_millis()

                        file_size = file_info.get("size", 0)
                        file_size_mb = file_size / (1024 * 1024)
                        is_chunked = file_size > CHUNK_THRESHOLD

                        if is_chunked:
                            estimated_ms = max(
                                MIN_FILE_TIME_CHUNKED_MS,
                                int(file_size_mb * FILE_TIME_PER_MB_CHUNKED_MS)
                            )
                        else:
                            estimated_ms = max(
                                MIN_FILE_TIME_MS,
                                int(file_size_mb * FILE_TIME_PER_MB_MS)
                            )
                        needed_ms = estimated_ms + TIME_RESERVE_MS

                        if remaining_ms < needed_ms:
                            print(
                                f"  Timeout approaching: {remaining_ms}ms left, "
                                f"file needs ~{estimated_ms}ms "
                                f"({file_size_mb:.1f} MB, "
                                f"{'chunked' if is_chunked else 'full'}) "
                                f"+ {TIME_RESERVE_MS}ms reserve. "
                                f"Stopping."
                            )
                            timed_out = True
                            break

                    status["files"][si]["status"] = "processing"
                    status["files"][si]["startedAt"] = datetime.utcnow().isoformat()
                    write_status(bucket, status)

                    result = process_single_file(bucket, file_info, connection_str, context, triggered_by=triggered_by)

                    status["files"][si] = result
                    status["processedFiles"] = sum(
                        1 for sf in status["files"] if sf["status"] in ("success", "failed")
                    )

                    if result["status"] == "success":
                        status["successCount"] = sum(
                            1 for sf in status["files"] if sf["status"] == "success"
                        )
                    else:
                        status["failCount"] = sum(
                            1 for sf in status["files"] if sf["status"] == "failed"
                        )

                    write_status(bucket, status)

            except Exception as loop_err:
                # Catch errors mid-loop so we can still finalize status
                tb_inner = traceback.format_exc()
                print(f"  ERROR in processing loop: {loop_err}\n{tb_inner}")
                for fi in status["files"]:
                    if fi["status"] == "processing":
                        fi["status"] = "failed"
                        fi["error"] = f"Lambda error: {loop_err}"
                        fi["completedAt"] = datetime.utcnow().isoformat()
                        status["failCount"] = sum(
                            1 for sf in status["files"] if sf["status"] == "failed"
                        )
                        status["processedFiles"] = sum(
                            1 for sf in status["files"]
                            if sf["status"] in ("success", "failed")
                        )

            finally:
                pending_count = sum(
                    1 for f in status["files"] if f["status"] == "pending"
                )

                # ── Auto-continuation: self-invoke if timed out with pending files ──
                continuing = False
                if (timed_out or pending_count > 0) and pending_count > 0:
                    filters = {
                        "module": filter_module,
                        "entity": filter_entity,
                        "source": filter_source,
                        "mock": filter_mock,
                    }
                    continuing = self_invoke_continuation(
                        context, bucket, filters, continuation_run, triggered_by
                    )

                if continuing:
                    # Mark status so dashboard knows another run is coming
                    status["status"] = "processing"
                    status["timedOut"] = True
                    status["continuing"] = True
                    status["pendingFiles"] = pending_count
                    status["continuationRun"] = continuation_run
                    print(f"  Continuing: {pending_count} files pending, "
                          f"next run #{continuation_run + 1}")
                else:
                    # Final run — mark as complete
                    status["status"] = "complete"
                    status["completedAt"] = datetime.utcnow().isoformat()
                    status.pop("continuing", None)
                    if timed_out or pending_count > 0:
                        status["timedOut"] = True
                        status["pendingFiles"] = pending_count
                        print(f"  Finalized with {pending_count} files still pending")

                write_status(bucket, status)
                # Only write history on the final run (not mid-continuation)
                if not continuing:
                    write_history(bucket, status)

            print(f"Processing {'continuing' if continuing else 'complete'}: "
                  f"{status.get('successCount', 0)} success, "
                  f"{status.get('failCount', 0)} failed, "
                  f"{pending_count} pending")

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps(status, default=str),
            }

        except Exception as e:
            tb = traceback.format_exc()
            print(f"FATAL ERROR: {e}\n{tb}")

            try:
                error_status = {
                    "status": "error",
                    "error": str(e),
                    "completedAt": datetime.utcnow().isoformat(),
                }
                write_status(bucket, error_status)
            except Exception:
                pass

            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e), "traceback": tb}),
            }

    # Unknown action
    return {
        "statusCode": 400,
        "headers": headers,
        "body": json.dumps({
            "error": f"Unknown action: {action}. "
                     f"Use 'process', 'status', 'history', or 'entities'."
        }),
    }
