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
import re
import time
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
from conversion_plan_tracker import track_file_load, handle_reset_file_expected

# Mock promotion — clones a Mock's schema/data into a new Mock (admin action)
from promote_mock import handle_promote_mock_request

# AWS_FILES event-log writer — tracks every S3 file transition through the
# pipeline. Imported as a module so per-call failures (caught inside each
# function via the _safe decorator) never abort the main file load.
import aws_files_writer

# Phase 4: Validation Group + cross-VG dependency tracking
from validation_group_tracker import (
    on_table_load_success as vg_on_table_load_success,
    handle_list_runs as vg_handle_list_runs,
    handle_run_complete as vg_handle_run_complete,
    handle_run_decision as vg_handle_run_decision,
    list_group_members as vg_list_group_members,
)
from vg_dependencies_check import evaluate_dependencies as vg_evaluate_dependencies

# Phase 5: VBL Group lifecycle + Sterling status + Distribution
from vbl_group_tracker import (
    on_validation_group_approved as vbl_on_vg_approved,
    handle_list_vbl_groups,
    handle_vbl_run_complete,
    handle_vbl_run_decision,
    handle_mark_sterling_sent,
    handle_create_vbl_group,
    handle_update_vbl_members,
    handle_update_vbl_group,
    handle_delete_vbl_group,
)

# Phase 6.2: File configuration admin (replaces uploading an Excel)
import file_config_admin

# Phase 7: Server-side zip builder for multi-file / folder downloads
# (browsers block rapid-fire pop-ups; folders can't be downloaded as a
# unit any other way without zipping).
from zip_builder import build_download_zip

# Interim record sampling for the conversion validation effort (Validations page).
import sampling

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
ssm_client = boto3.client("ssm", region_name="us-east-1")

# ─── Sample-file publishing to the SQL Server box ─────────────────────────────
# Every sampling run drops one copy of the client workbook into a watched folder
# on the SQL Server EC2 instance. The browser can't reach the box, so the Lambda
# hands the box a short-lived presigned S3 URL and it pulls the file down itself
# via SSM Run Command (no S3 credentials needed on the box).
SQL_SERVER_INSTANCE_ID = "i-005bc43c1a95338e4"
PUBLISH_DIR = r"D:\Hacienda ERP Data Validation\FilePublish\ToPublish - Sample Converted Data Files"
PUBLISH_KEY_PREFIX = "Sampling/Client/"
_SAFE_SAMPLE_NAME = re.compile(r"^[A-Za-z0-9 ._()\-]+\.xlsx$")


def publish_sample_to_server(bucket, key, timeout=30):
    """Copy one client sample workbook from S3 onto the SQL Server box.

    The box downloads the file itself from a short-lived presigned URL via SSM
    Run Command, so it needs no S3 credentials — only the outbound HTTPS it
    already has as an SSM-managed instance. The file is written to a .part file
    first and renamed into place so the watched ToPublish folder never sees a
    partial file. Returns {ok, status, commandId, dest, stdout, stderr}.
    """
    if not key.startswith(PUBLISH_KEY_PREFIX):
        return {"ok": False, "error": "key must be under " + PUBLISH_KEY_PREFIX}
    filename = key.rsplit("/", 1)[-1]
    if not _SAFE_SAMPLE_NAME.match(filename):
        return {"ok": False, "error": "unsafe sample filename"}

    url = s3_client.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=900)
    if "'" in url:  # presigned URLs never contain quotes; refuse if one somehow does
        return {"ok": False, "error": "unexpected character in download url"}

    dest = PUBLISH_DIR + "\\" + filename
    ps = (
        "$ErrorActionPreference='Stop';"
        "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;"
        "$dir='" + PUBLISH_DIR + "';"
        "$dest='" + dest + "';"
        "$tmp=$dest+'.part';"
        "if(!(Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Force -Path $dir | Out-Null};"
        "Invoke-WebRequest -Uri '" + url + "' -OutFile $tmp -UseBasicParsing;"
        "Move-Item -LiteralPath $tmp -Destination $dest -Force;"
        "Write-Output ('PUBLISHED ' + $dest)"
    )
    send = ssm_client.send_command(
        InstanceIds=[SQL_SERVER_INSTANCE_ID],
        DocumentName="AWS-RunPowerShellScript",
        Comment="Publish sample converted data file",
        Parameters={"commands": [ps]},
        TimeoutSeconds=600,
    )
    command_id = send["Command"]["CommandId"]

    # Poll briefly for a terminal status so the run can record whether it landed.
    status, stdout, stderr = "Pending", "", ""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2)
        try:
            inv = ssm_client.get_command_invocation(
                CommandId=command_id, InstanceId=SQL_SERVER_INSTANCE_ID)
        except ssm_client.exceptions.InvocationDoesNotExist:
            continue
        status = inv["Status"]
        if status in ("Success", "Failed", "Cancelled", "TimedOut"):
            stdout = (inv.get("StandardOutputContent") or "").strip()
            stderr = (inv.get("StandardErrorContent") or "").strip()
            break

    return {
        "ok": status == "Success",
        "status": status,
        "commandId": command_id,
        "dest": dest,
        "stdout": stdout[-800:],
        "stderr": stderr[-800:],
    }


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
        # Pass dest_key so the table stores where the file lives now.
        # Pass eTag so the row's Latest_File_ID points into AWS_FILES, and
        # _flip_file_expected_after_load sets File_Expected=N as a side effect
        # (Phase 3 spec rule).
        track_file_load(
            connection_str, mock_number, parsed, table_name,
            row_count=result["rowCount"], df=df,
            triggered_by=triggered_by,
            file_key=dest_key,
            file_size=file_info.get("size", 0),
            etag=file_etag,
        )

        # Step 7 (Phase 4): Recompute Validation Group state.
        # Wrapped in try/except — VG tracking is observational and must not
        # break the main file pipeline if VALIDATION_GROUPS_{MOCK} is missing
        # or the entity isn't mapped to a VG code yet.
        try:
            vg_summary = vg_on_table_load_success(
                connection_str=connection_str,
                mock_number=mock_number,
                parsed=parsed,
                etag=file_etag,
            )
            if vg_summary.get("run_created"):
                print(f"  Validation run triggered: {vg_summary['run_created']} "
                      f"({vg_summary['trigger_reason']})")
            elif vg_summary.get("skipped_reason"):
                print(f"  VG tracking skipped: {vg_summary['skipped_reason']}")
        except Exception as vg_err:
            print(f"  WARNING: VG tracker failed (file load still succeeded): {vg_err}")

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

    # ─── PHASE 4 — VALIDATION RUNS + DEPENDENCIES ───
    if action == "validation_runs":
        # ?action=validation_runs&mock=MOCK12[&status=Pending+Approval]
        try:
            params = event.get("queryStringParameters") or {}
            mock = params.get("mock", "MOCK12")
            status_filter = params.get("status") or None
            conn_str = get_connection_string()
            res = vg_handle_list_runs(conn_str, mock, status_filter)
            return {
                "statusCode": 200 if res.get("ok") else 400,
                "headers": headers,
                "body": json.dumps(res, default=str),
            }
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "validation_group_members":
        # ?action=validation_group_members&mock=MOCK12&vgid=APINV-PRIFAS
        # Returns members of the VG annotated with current load status so the
        # dashboard can show what's loaded vs. pending vs. failed.
        try:
            params = event.get("queryStringParameters") or {}
            mock = params.get("mock", "MOCK12")
            vgid = params.get("vgid", "")
            if not vgid:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error": "vgid required"})}
            conn_str = get_connection_string()
            res = vg_list_group_members(conn_str, mock, vgid)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "validation_run_complete":
        # POSTed by the existing button-driven validation script when it finishes.
        # Body: { "mock": "MOCK12", "run_id": "VAL-0001", "error_count": N,
        #         "warning_count": N, "informative_count": N,
        #         "validation_file_etag": "...", "actor": "validation-runner" }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = vg_handle_run_complete(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                run_id=body.get("run_id", ""),
                error_count=int(body.get("error_count", 0) or 0),
                warning_count=int(body.get("warning_count", 0) or 0),
                informative_count=int(body.get("informative_count", 0) or 0),
                validation_file_etag=body.get("validation_file_etag") or None,
                actor=body.get("actor", "") or "",
            )
            return {
                "statusCode": 200 if res.get("ok") else 400,
                "headers": headers,
                "body": json.dumps(res, default=str),
            }
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "validation_run_decide":
        # POSTed by the approval UI.
        # Body: { "mock": "MOCK12", "run_id": "VAL-0001",
        #         "decision": "Approved" | "Rejected", "comments": "...",
        #         "reextract_required": true|false,
        #         "affected_members": "TBL1;TBL2", "actor": "user@example.com" }
        try:
            body = json.loads(event.get("body") or "{}")
            mock = body.get("mock", "MOCK12")
            conn_str = get_connection_string()
            res = vg_handle_run_decision(
                connection_str=conn_str,
                mock_number=mock,
                run_id=body.get("run_id", ""),
                decision=body.get("decision", ""),
                comments=body.get("comments", "") or "",
                reextract_required=bool(body.get("reextract_required", False)),
                affected_members=body.get("affected_members", "") or "",
                actor=body.get("actor", "") or "",
            )

            # Phase 5 hook: on Approval, ripple state into VBL Groups
            if res.get("ok") and res.get("decision") == "Approved":
                try:
                    vbl_summary = vbl_on_vg_approved(
                        connection_str=conn_str,
                        mock_number=mock,
                        validation_group_id=res.get("vg_id", ""),
                        approver_email=body.get("actor", "") or "",
                    )
                    res["vbl_propagation"] = vbl_summary
                except Exception as vbl_err:
                    print(f"  WARNING: VBL propagation failed: {vbl_err}")
                    res["vbl_propagation_error"] = str(vbl_err)

            return {
                "statusCode": 200 if res.get("ok") else 400,
                "headers": headers,
                "body": json.dumps(res, default=str),
            }
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    # ─── PHASE 6.2 — FILE CONFIGURATION ADMIN ───
    if action == "file_configs":
        # ?action=file_configs&mock=MOCK12[&module=FIN][&search=AP]
        try:
            p = event.get("queryStringParameters") or {}
            conn_str = get_connection_string()
            res = file_config_admin.list_file_configs(
                conn_str, p.get("mock", "MOCK12"),
                p.get("module") or None, p.get("search") or None,
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "file_config_detail":
        # ?action=file_config_detail&mock=MOCK12&entity=...&source=...
        try:
            p = event.get("queryStringParameters") or {}
            conn_str = get_connection_string()
            res = file_config_admin.get_file_config_detail(
                conn_str, p.get("mock", "MOCK12"),
                p.get("entity", ""), p.get("source", ""),
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "update_file_config":
        # POST { mock, entity, source, updates: {field: value, ...}, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = file_config_admin.update_file_config(
                conn_str, body.get("mock", "MOCK12"),
                body.get("entity", ""), body.get("source", ""),
                body.get("updates") or {},
                body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "update_validation_group":
        # POST { mock, vg_id, members_total?, error_threshold?, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = file_config_admin.update_validation_group(
                conn_str, body.get("mock", "MOCK12"),
                body.get("vg_id", ""),
                body.get("members_total"),
                body.get("error_threshold"),
                body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "add_file_entity":
        # POST { mock, payload: {Entity, Source, Table_Name, ...}, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = file_config_admin.add_file_entity(
                conn_str, body.get("mock", "MOCK12"),
                body.get("payload") or {},
                body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "list_sql_tables":
        # ?action=list_sql_tables[&prefix=FIN_]
        try:
            p = event.get("queryStringParameters") or {}
            conn_str = get_connection_string()
            res = file_config_admin.list_sql_tables(conn_str, p.get("prefix") or None)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "sql_table_columns":
        # ?action=sql_table_columns&table=...[&db=Hacienda_ERP]
        try:
            p = event.get("queryStringParameters") or {}
            conn_str = get_connection_string()
            res = file_config_admin.get_sql_table_columns(conn_str, p.get("table", ""), p.get("db") or None)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "save_column_mapping":
        # POST { mock, entity, source, table_name, mappings: [...], actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = file_config_admin.save_column_mapping(
                conn_str, body.get("mock", "MOCK12"),
                body.get("entity", ""), body.get("source", ""),
                body.get("table_name", "") or "",
                body.get("mappings") or [],
                body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "create_sql_table":
        # POST { table_name, columns: [{name, data_type, length?, nullable?}, ...], actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = file_config_admin.create_sql_table(
                conn_str, body.get("table_name", ""),
                body.get("columns") or [],
                body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    # ─── PHASE 6 — DASHBOARD: AWS FILES EVENT LOG ───
    if action == "aws_files":
        # ?action=aws_files
        # Query params (all optional):
        #   mock=MOCK12               Filter by Mock_Number
        #   vgid=APINV-PRIFAS         Filter by Validation_Group_ID
        #   vbl=VBL-FIN-AP            Filter by VBL_Group_ID
        #   category=Extract          Filter by File_Category
        #   status=Table+Load+Success Filter by File_Status
        #   source=PRIFAS             Filter by Source
        #   search=AP_INVOICE         Substring search on File_Name
        #   etag=abc123               Lookup by eTag prefix
        #   from=2026-01-01           Received_DateTime >= ?
        #   to=2026-12-31             Received_DateTime <= ?
        #   limit=200                 default 200, max 1000
        #   offset=0                  for pagination
        try:
            params = event.get("queryStringParameters") or {}
            limit = max(1, min(1000, int(params.get("limit", "200") or "200")))
            offset = max(0, int(params.get("offset", "0") or "0"))

            where = []
            args = []
            def add(col, val, op="="):
                if val:
                    where.append(f"{col} {op} ?")
                    args.append(val)
            add("Mock_Number",          params.get("mock"))
            add("Validation_Group_ID",  params.get("vgid"))
            add("VBL_Group_ID",         params.get("vbl"))
            add("File_Category",        params.get("category"))
            add("File_Status",          params.get("status"))
            add("[Source]",             params.get("source"))
            if params.get("search"):
                where.append("File_Name LIKE ?")
                args.append(f"%{params['search']}%")
            if params.get("etag"):
                where.append("AWS_eTag LIKE ?")
                args.append(f"{params['etag']}%")
            if params.get("from"):
                where.append("Received_DateTime >= ?")
                args.append(params["from"])
            if params.get("to"):
                where.append("Received_DateTime <= ?")
                args.append(params["to"])

            where_clause = ("WHERE " + " AND ".join(where)) if where else ""

            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cur = conn.cursor()
                # Total count for pagination
                cur.execute(f"SELECT COUNT(*) FROM AWS_FILES {where_clause}", args)
                total = cur.fetchone()[0]
                # Page
                cur.execute(
                    f"""
                    SELECT
                        AWS_eTag, Movement_Sequence, File_Name, File_Category,
                        File_Size_KB, Record_Count,
                        Conversion_Plan_Table_Name, Conversion_Plan_Entity,
                        Validation_Group_ID, VBL_Group_ID, WBS_ID,
                        Pillar, Module, Data_Entity, [Source], Business_Unit, Mock_Number,
                        S3_Bucket, Parent_Folder, File_URL, Moved_To_Folder,
                        Received_DateTime, Processed_DateTime,
                        File_Status, Error_Type, Error_Owner,
                        Supersedes_eTag, Superseded_By_eTag, Split_From_eTag,
                        Check_File_Name, Check_File_Expected, Check_Column_Headers,
                        Check_TSQL_File_Found, Check_TSQL_Load,
                        Sterling_Transmission_Status, Sterling_Transmission_DateTime,
                        Created_By, Last_Updated_By, Last_Updated_DateTime,
                        Reason_for_Upload
                    FROM AWS_FILES
                    {where_clause}
                    ORDER BY Received_DateTime DESC, Movement_Sequence
                    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
                    """,
                    args + [offset, limit],
                )
                cols = [c[0] for c in cur.description]
                rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            return {
                "statusCode": 200, "headers": headers,
                "body": json.dumps({
                    "ok": True, "total": total, "limit": limit,
                    "offset": offset, "rows": rows,
                }, default=str),
            }
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "pipeline_metrics":
        # ?action=pipeline_metrics[&mock=MOCK12][&window_hours=24]
        # Lightweight rollup that powers the dashboard metric tiles.
        # Cheap: one COUNT query per metric, no row payload returned.
        try:
            p = event.get("queryStringParameters") or {}
            mock = (p.get("mock") or "").strip().upper() or None
            window_hours = max(1, min(168, int(p.get("window_hours", "24") or "24")))

            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cur = conn.cursor()

                # ─── AWS_FILES rollup ───
                mock_clause = "AND Mock_Number = ?" if mock else ""
                mock_args = [mock] if mock else []

                # Queue depth — Received / Gate Check Running on seq 1
                cur.execute(
                    f"""
                    SELECT COUNT(*) FROM AWS_FILES
                    WHERE Movement_Sequence = 1
                      AND File_Status IN ('Received','Gate Check Running')
                      {mock_clause}
                    """,
                    mock_args,
                )
                queue_depth = cur.fetchone()[0] or 0

                # In flight — past gate, not yet Table Load Success
                cur.execute(
                    f"""
                    SELECT COUNT(*) FROM AWS_FILES
                    WHERE Movement_Sequence = 1
                      AND File_Status NOT IN ('Received','Gate Check Running',
                        'Table Load Success','Invalid File Name','File Not Expected',
                        'Invalid Headers','TSQL Load File Not Found','TSQL Load Error',
                        'Superseded','Archived','Rejected','Distributed','Loaded')
                      {mock_clause}
                    """,
                    mock_args,
                )
                in_flight = cur.fetchone()[0] or 0

                # Window aggregates
                cur.execute(
                    f"""
                    SELECT
                        SUM(CASE WHEN File_Status = 'Table Load Success' THEN 1 ELSE 0 END) AS loaded,
                        SUM(CASE WHEN File_Status IN ('Invalid File Name','File Not Expected',
                            'Invalid Headers','TSQL Load File Not Found','TSQL Load Error')
                            THEN 1 ELSE 0 END) AS failed,
                        SUM(CASE WHEN File_Status = 'Superseded' THEN 1 ELSE 0 END) AS superseded
                    FROM AWS_FILES
                    WHERE Movement_Sequence = 1
                      AND Received_DateTime >= DATEADD(hour, ?, SYSUTCDATETIME())
                      {mock_clause}
                    """,
                    [-window_hours] + mock_args,
                )
                row = cur.fetchone()
                loaded_window = row[0] or 0
                failed_window = row[1] or 0
                superseded_window = row[2] or 0

                # Mean load duration (seconds): Processed - Received, capped at window
                cur.execute(
                    f"""
                    SELECT AVG(CAST(DATEDIFF(SECOND, Received_DateTime, Processed_DateTime) AS FLOAT))
                    FROM AWS_FILES
                    WHERE Movement_Sequence = 1
                      AND File_Status = 'Table Load Success'
                      AND Received_DateTime IS NOT NULL
                      AND Processed_DateTime IS NOT NULL
                      AND Received_DateTime >= DATEADD(hour, ?, SYSUTCDATETIME())
                      {mock_clause}
                    """,
                    [-window_hours] + mock_args,
                )
                mean_load = cur.fetchone()[0]
                mean_load_seconds = float(mean_load) if mean_load is not None else None

                # By module (for the module breakdown chart)
                cur.execute(
                    f"""
                    SELECT COALESCE(Module, '(unknown)'), COUNT(*)
                    FROM AWS_FILES
                    WHERE Movement_Sequence = 1
                      AND Received_DateTime >= DATEADD(hour, ?, SYSUTCDATETIME())
                      {mock_clause}
                    GROUP BY Module
                    ORDER BY COUNT(*) DESC
                    """,
                    [-window_hours] + mock_args,
                )
                by_module = {r[0] or '(unknown)': r[1] for r in cur.fetchall()}

                # By status
                cur.execute(
                    f"""
                    SELECT File_Status, COUNT(*)
                    FROM AWS_FILES
                    WHERE Movement_Sequence = 1
                      AND Received_DateTime >= DATEADD(hour, ?, SYSUTCDATETIME())
                      {mock_clause}
                    GROUP BY File_Status
                    ORDER BY COUNT(*) DESC
                    """,
                    [-window_hours] + mock_args,
                )
                by_status = {r[0]: r[1] for r in cur.fetchall()}

                # ─── VALIDATION_RUNS pending (per-Mock table; only count if mock given) ───
                validation_runs_pending = None
                if mock:
                    vr_table = f"VALIDATION_RUNS_{mock}"
                    cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (vr_table,))
                    if cur.fetchone()[0] > 0:
                        cur.execute(
                            f"SELECT COUNT(*) FROM {vr_table} WHERE Run_Status = 'Pending Approval'"
                        )
                        validation_runs_pending = cur.fetchone()[0] or 0

                # ─── VBL_GROUPS pending + Sterling pending ───
                vbl_runs_pending = None
                sterling_pending = None
                if mock:
                    vbl_table = f"VBL_GROUPS_{mock}"
                    cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (vbl_table,))
                    if cur.fetchone()[0] > 0:
                        cur.execute(
                            f"SELECT COUNT(*) FROM {vbl_table} WHERE Latest_VBL_Status = 'Pending Approval'"
                        )
                        vbl_runs_pending = cur.fetchone()[0] or 0
                        cur.execute(
                            f"""
                            SELECT COUNT(*) FROM {vbl_table}
                            WHERE Latest_Approval_Status = 'Approved'
                              AND COALESCE(Sterling_Transmission_Status, '') NOT IN ('Submitted')
                              AND Conversion_Load_File_eTag IS NOT NULL
                            """
                        )
                        sterling_pending = cur.fetchone()[0] or 0

                # Success rate over window
                denom = loaded_window + failed_window
                success_rate = (loaded_window / denom) if denom > 0 else None

                return {
                    "statusCode": 200, "headers": headers,
                    "body": json.dumps({
                        "ok": True,
                        "mock": mock,
                        "window_hours": window_hours,
                        "queue_depth": queue_depth,
                        "in_flight": in_flight,
                        "loaded_window": loaded_window,
                        "failed_window": failed_window,
                        "superseded_window": superseded_window,
                        "mean_load_seconds": mean_load_seconds,
                        "throughput_per_hour": (loaded_window / window_hours) if window_hours else 0,
                        "success_rate": success_rate,
                        "validation_runs_pending": validation_runs_pending,
                        "vbl_runs_pending": vbl_runs_pending,
                        "sterling_pending": sterling_pending,
                        "by_module": by_module,
                        "by_status": by_status,
                    }, default=str),
                }
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "zip_files":
        # POST { bucket?, paths: [...], filename?, actor? }
        # Streams the listed S3 objects (and any folders) into a zip in
        # /tmp, uploads to s3://bucket/_downloads/{uuid}/{filename},
        # returns a presigned GET URL the browser navigates to. One
        # download → no popup-blocker issues.
        try:
            body = json.loads(event.get("body") or "{}")
            target_bucket = body.get("bucket") or DEFAULT_BUCKET
            paths = body.get("paths") or []
            filename = body.get("filename")
            actor = body.get("actor", "") or ""

            if not isinstance(paths, list) or not paths:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error":
                            "paths must be a non-empty list"})}

            res = build_download_zip(s3_client, target_bucket, paths,
                                      filename=filename, actor=actor)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    # ─── SAMPLING (Validations page) ───
    if action == "sampling_targets":
        # ?action=sampling_targets — target tables + their direct children
        try:
            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps(sampling.list_targets(), default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "sampling_relationships":
        # ?action=sampling_relationships — full parent/child edge list + targets
        # (for client-side multi-level traversal). Config only, no DB.
        try:
            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps(sampling.list_relationships(), default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "run_sampling":
        # POST { target_table, sample_size, bucket?, actor? }
        # Selects N random records from the target, gathers linked child
        # records, writes an Excel workbook to Sampling/ and returns a
        # presigned download URL + summary.
        try:
            body = json.loads(event.get("body") or "{}")
            target_table = (body.get("target_table") or "").strip()
            sample_size = body.get("sample_size")
            target_bucket = body.get("bucket") or DEFAULT_BUCKET
            actor = body.get("actor", "") or ""
            source_db = body.get("source_db") or None
            combine_all = bool(body.get("combine_all"))
            if not target_table:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error": "target_table required"})}
            conn_str = get_connection_string()
            res = sampling.run_sample(conn_str, s3_client, target_bucket,
                                      target_table, sample_size, actor=actor,
                                      source_db=source_db, combine_all=combine_all)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "entity_plan":
        # ?action=entity_plan&mock=MOCK14[&counts=1] — expected entity files from
        # SETUP_CONVERSION_PLAN_{mock} (+ conversion-table row counts if counts=1).
        try:
            p = event.get("queryStringParameters") or {}
            mock = (p.get("mock") or "MOCK14").upper()
            with_counts = str(p.get("counts") or "").lower() in ("1", "true", "yes")
            conn_str = get_connection_string()
            res = sampling.list_entity_plan(conn_str, mock, with_counts=with_counts)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "generate_entity_files":
        # ?action=generate_entity_files&mock=MOCK14&entity=Supplier[&subentity=..][&dry_run=1]
        # Server-side run of the ConvertedFilesBySource scripts for one entity:
        # splits each conversion table by source[/BU] and writes CV_ files to
        # Sampling/Generated/. dry_run=1 previews (counts, no writes).
        try:
            p = event.get("queryStringParameters") or {}
            mock = (p.get("mock") or "MOCK14").upper()
            entity = (p.get("entity") or "").strip()
            subentity = (p.get("subentity") or "").strip() or None
            dry_run = str(p.get("dry_run") or "").lower() in ("1", "true", "yes")
            actor = (p.get("actor") or "").strip()
            bu_filter = (p.get("bu") or "").strip() or None
            target_bucket = p.get("bucket") or DEFAULT_BUCKET
            if not entity:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error": "entity required"})}
            conn_str = get_connection_string()
            res = sampling.generate_entity_files(conn_str, s3_client, target_bucket,
                                                 mock, entity, subentity, dry_run=dry_run,
                                                 actor=actor, bu_filter=bu_filter)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "publish_to_server":
        # ?action=publish_to_server&key=Sampling/Client/<file>.xlsx[&bucket=...]
        # Drops one copy of the client sample workbook into the SQL Server box's
        # watched ToPublish folder via SSM Run Command (publish_sample_to_server).
        try:
            p = event.get("queryStringParameters") or {}
            key = (p.get("key") or "").strip()
            target_bucket = p.get("bucket") or DEFAULT_BUCKET
            if not key:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error": "key required"})}
            res = publish_sample_to_server(target_bucket, key)
            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "sampling_runs":
        # ?action=sampling_runs[&bucket=...] — recent sampling runs (history)
        try:
            p = event.get("queryStringParameters") or {}
            target_bucket = p.get("bucket") or DEFAULT_BUCKET
            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps(sampling.list_runs(s3_client, target_bucket), default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "sql_locate":
        # ?action=sql_locate&name=OBJECT_NAME — DIAGNOSTIC (metadata only, no row data).
        # Reports the connection's current DB/server, the user databases the
        # login can see, and which of those databases contain an object matching
        # `name` (exact + LIKE). Helps pin down cross-database table location.
        try:
            p = event.get("queryStringParameters") or {}
            name = (p.get("name") or "").strip()
            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cur = conn.cursor()
                cur.execute("SELECT DB_NAME(), @@SERVERNAME")
                current_db, server_name = cur.fetchone()
                cur.execute("SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name")
                user_dbs = [r[0] for r in cur.fetchall()]
                located = []
                if name:
                    search_dbs = sorted(set(user_dbs) | {current_db})
                    like = f"%{name}%"
                    for db in search_dbs:
                        try:
                            cur.execute(
                                f"SELECT name, type_desc FROM [{db}].sys.objects "
                                "WHERE name = ? OR name LIKE ?",
                                (name, like),
                            )
                            for nm, td in cur.fetchall():
                                located.append({"database": db, "object": nm, "type": td})
                        except Exception as db_err:
                            located.append({"database": db, "error": str(db_err)[:120]})
            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps({"ok": True, "current_db": current_db,
                                        "server": server_name, "user_databases": user_dbs,
                                        "searched_for": name, "located": located}, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "update_aws_file_reason":
        # POST { etag, reason, actor }
        # Lets admins backfill Reason_for_Upload on an AWS_FILES row from
        # the dashboard detail panel. Updates both seq 1 and seq 2 if
        # present so the lineage stays consistent.
        VALID = {'Initial Load', 'Re-extract', 'Correction', 'Late Arrival',
                 'Manual Re-upload', 'Other', ''}
        try:
            body = json.loads(event.get("body") or "{}")
            etag = (body.get("etag") or "").strip().strip('"')
            reason = (body.get("reason") or "").strip()
            actor = body.get("actor", "") or ""
            if not etag:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error": "etag required"})}
            if reason not in VALID:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error":
                            f"reason must be one of: {sorted(v for v in VALID if v)}"})}
            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cur = conn.cursor()
                cur.execute(
                    """
                    UPDATE AWS_FILES SET
                        Reason_for_Upload = NULLIF(?, ''),
                        Last_Updated_By = ?,
                        Last_Updated_DateTime = SYSUTCDATETIME()
                    WHERE AWS_eTag = ?
                    """,
                    (reason, actor or "dashboard", etag),
                )
                affected = cur.rowcount
                conn.commit()
            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps({"ok": True, "rows_updated": affected,
                                         "reason": reason or None})}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "aws_file_chain":
        # ?action=aws_file_chain&etag=<full eTag>
        # Returns the version chain (Supersedes -> Superseded_By walk) and the
        # split lineage (parent via Split_From_eTag, children where Split_From
        # points at this eTag) for the dashboard's detail overlay.
        try:
            p = event.get("queryStringParameters") or {}
            etag = (p.get("etag") or "").strip().strip('"')
            if not etag:
                return {"statusCode": 400, "headers": headers,
                        "body": json.dumps({"ok": False, "error": "etag required"})}

            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cur = conn.cursor()

                def fetch_row(e):
                    cur.execute(
                        """
                        SELECT TOP 1
                            AWS_eTag, Movement_Sequence, File_Name, File_Category,
                            File_Status, File_Size_KB, Record_Count,
                            Conversion_Plan_Entity, [Source], Business_Unit, Mock_Number,
                            Parent_Folder, File_URL,
                            Received_DateTime, Processed_DateTime,
                            Supersedes_eTag, Superseded_By_eTag, Split_From_eTag,
                            Validation_Group_ID, VBL_Group_ID
                        FROM AWS_FILES
                        WHERE AWS_eTag = ? AND Movement_Sequence = 1
                        """,
                        (e,),
                    )
                    r = cur.fetchone()
                    if not r:
                        return None
                    cols = [c[0] for c in cur.description]
                    return dict(zip(cols, r))

                # Anchor (the file the user clicked on)
                anchor = fetch_row(etag)
                if not anchor:
                    return {"statusCode": 404, "headers": headers,
                            "body": json.dumps({"ok": False, "error": "eTag not found"})}

                # Walk supersede chain backwards (toward older versions)
                older = []
                cursor_e = anchor.get("Supersedes_eTag")
                seen = {etag}
                while cursor_e and cursor_e not in seen:
                    seen.add(cursor_e)
                    row = fetch_row(cursor_e)
                    if not row:
                        break
                    older.append(row)
                    cursor_e = row.get("Supersedes_eTag")

                # Walk supersede chain forwards (toward newer versions)
                newer = []
                cursor_e = anchor.get("Superseded_By_eTag")
                while cursor_e and cursor_e not in seen:
                    seen.add(cursor_e)
                    row = fetch_row(cursor_e)
                    if not row:
                        break
                    newer.append(row)
                    cursor_e = row.get("Superseded_By_eTag")

                # Split parent (if this is a distribution row)
                split_parent = None
                if anchor.get("Split_From_eTag"):
                    split_parent = fetch_row(anchor["Split_From_eTag"])

                # Split children (other rows whose Split_From points at this eTag)
                cur.execute(
                    """
                    SELECT
                        AWS_eTag, File_Name, File_Category, File_Status,
                        Business_Unit, Parent_Folder, Received_DateTime
                    FROM AWS_FILES
                    WHERE Split_From_eTag = ? AND Movement_Sequence = 1
                    ORDER BY Business_Unit, Received_DateTime
                    """,
                    (etag,),
                )
                split_cols = [c[0] for c in cur.description]
                split_children = [dict(zip(split_cols, r)) for r in cur.fetchall()]

                return {"statusCode": 200, "headers": headers,
                        "body": json.dumps({
                            "ok": True,
                            "anchor": anchor,
                            "older_versions": older,
                            "newer_versions": newer,
                            "split_parent": split_parent,
                            "split_children": split_children,
                        }, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "validation_groups":
        # ?action=validation_groups&mock=MOCK12
        # Returns one row per VG with member counts, dependency summary,
        # latest run + approval status. Powers the Validation Groups tab.
        try:
            params = event.get("queryStringParameters") or {}
            mock = params.get("mock", "MOCK12")
            vg_table = f"VALIDATION_GROUPS_{mock}"
            dep_table = f"VG_DEPENDENCIES_{mock}"

            conn_str = get_connection_string()
            with pyodbc.connect(conn_str) as conn:
                cur = conn.cursor()
                cur.execute(
                    "SELECT COUNT(*) FROM sys.tables WHERE name IN (?, ?)",
                    (vg_table, dep_table),
                )
                if cur.fetchone()[0] < 2:
                    return {"statusCode": 200, "headers": headers,
                            "body": json.dumps({"ok": True, "groups": [],
                                                "note": f"Per-Mock tables missing for {mock}"})}

                cur.execute(
                    f"""
                    SELECT
                        Validation_Group_ID, Validation_Group_Name,
                        Pillar, Module, Data_Entity,
                        Members_Total, Members_Currently_Loaded, All_Members_Loaded,
                        Error_Threshold, Threshold_Exceeded, Reextract_Required,
                        Current_Validation_Run_ID, Validation_Run_Count,
                        Latest_Validation_Status, Latest_Validation_DateTime,
                        Latest_Approval_Status, Latest_Approver,
                        Latest_Approval_DateTime
                    FROM {vg_table}
                    ORDER BY Validation_Group_ID
                    """
                )
                cols = [c[0] for c in cur.description]
                groups = [dict(zip(cols, r)) for r in cur.fetchall()]

                # Aggregate dep state per VG
                cur.execute(
                    f"""
                    SELECT Validation_Group_ID,
                           COUNT(*) AS dep_total,
                           SUM(CASE WHEN Dependency_Status = 'Loaded' THEN 1 ELSE 0 END) AS dep_loaded,
                           SUM(CASE WHEN Blocks_Validation_Trigger = 'Y' THEN 1 ELSE 0 END) AS dep_blocking
                    FROM {dep_table}
                    GROUP BY Validation_Group_ID
                    """
                )
                dep_by_vg = {row[0]: {
                    "total": row[1] or 0,
                    "loaded": row[2] or 0,
                    "blocking": row[3] or 0,
                } for row in cur.fetchall()}
                for g in groups:
                    g["dependencies"] = dep_by_vg.get(g["Validation_Group_ID"], {
                        "total": 0, "loaded": 0, "blocking": 0,
                    })

            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps({"ok": True, "groups": groups}, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    # ─── PHASE 5 — VBL GROUPS / STERLING / DISTRIBUTION ───
    if action == "vbl_groups":
        # ?action=vbl_groups&mock=MOCK12[&status=Pending+Approval]
        try:
            params = event.get("queryStringParameters") or {}
            mock = params.get("mock", "MOCK12")
            status_filter = params.get("status") or None
            conn_str = get_connection_string()
            res = handle_list_vbl_groups(conn_str, mock, status_filter)
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "vbl_run_complete":
        # POSTed by Conversion Load / Recon / VBL Report script.
        # Body: { mock, vbl_group_id, vbl_file_etag, recon_file_etag,
        #         conversion_load_file_etag, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = handle_vbl_run_complete(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                vbl_group_id=body.get("vbl_group_id", ""),
                vbl_file_etag=body.get("vbl_file_etag") or None,
                recon_file_etag=body.get("recon_file_etag") or None,
                conversion_load_file_etag=body.get("conversion_load_file_etag") or None,
                actor=body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "vbl_run_decide":
        # POSTed by the VBL approval UI.
        # Body: { mock, vbl_group_id, decision, comments, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = handle_vbl_run_decision(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                vbl_group_id=body.get("vbl_group_id", ""),
                decision=body.get("decision", ""),
                comments=body.get("comments", "") or "",
                actor=body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "update_vbl_group":
        # POST { mock, vbl_group_id, updates: {VBL_Group_Name?, Notes?}, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = handle_update_vbl_group(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                vbl_group_id=body.get("vbl_group_id", ""),
                updates=body.get("updates") or {},
                actor=body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "delete_vbl_group":
        # POST { mock, vbl_group_id, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = handle_delete_vbl_group(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                vbl_group_id=body.get("vbl_group_id", ""),
                actor=body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "create_vbl_group":
        # POST { mock, payload: {vbl_group_id, vbl_group_name, pillar, module,
        #                       members: [{validation_group_id, required}]}, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = handle_create_vbl_group(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                payload=body.get("payload") or {},
                actor=body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "update_vbl_members":
        # POST { mock, vbl_group_id, members: [{validation_group_id, required}], actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = handle_update_vbl_members(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                vbl_group_id=body.get("vbl_group_id", ""),
                members=body.get("members") or [],
                actor=body.get("actor", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "mark_sterling_sent":
        # POSTed by VBL approval UI's 'Mark as Sent to Sterling' button.
        # Body: { mock, vbl_group_id, sterling_status, error_notes, actor }
        try:
            body = json.loads(event.get("body") or "{}")
            conn_str = get_connection_string()
            res = handle_mark_sterling_sent(
                connection_str=conn_str,
                mock_number=body.get("mock", "MOCK12"),
                vbl_group_id=body.get("vbl_group_id", ""),
                sterling_status=body.get("sterling_status", "Submitted"),
                actor=body.get("actor", "") or "",
                error_notes=body.get("error_notes", "") or "",
            )
            return {"statusCode": 200 if res.get("ok") else 400,
                    "headers": headers,
                    "body": json.dumps(res, default=str)}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "register_distribution_files":
        # POSTed by the distribution script after BU-splitting a parent file.
        # Body: { rows: [ { distribution_etag, parent_etag, bucket, dest_key,
        #                   business_unit }, ... ], actor }
        # Each row writes one AWS_FILES distribution entry.
        try:
            body = json.loads(event.get("body") or "{}")
            actor = body.get("actor", "") or "distribution-runner"
            conn_str = get_connection_string()
            written = []
            skipped = []
            for r in body.get("rows", []):
                result = aws_files_writer.write_distribution_row(
                    connection_str=conn_str,
                    distribution_etag=r.get("distribution_etag", ""),
                    parent_etag=r.get("parent_etag", ""),
                    bucket=r.get("bucket", DEFAULT_BUCKET),
                    dest_key=r.get("dest_key", ""),
                    business_unit=r.get("business_unit", ""),
                    actor=actor,
                )
                if result:
                    written.append(result)
                else:
                    skipped.append(r.get("distribution_etag", "")[:12])
            return {"statusCode": 200, "headers": headers,
                    "body": json.dumps({"ok": True,
                                         "written": written,
                                         "skipped": skipped})}
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    if action == "vg_dependencies_refresh":
        # ?action=vg_dependencies_refresh&mock=MOCK12[&vgid=APINV-PRIFAS]
        # Recomputes Dependency_Status across all VG_DEPENDENCIES rows.
        try:
            params = event.get("queryStringParameters") or {}
            mock = params.get("mock", "MOCK12")
            vgid = params.get("vgid") or None
            conn_str = get_connection_string()
            res = vg_evaluate_dependencies(conn_str, mock, vgid)
            return {
                "statusCode": 200, "headers": headers,
                "body": json.dumps({"ok": True, **res}, default=str),
            }
        except Exception as e:
            traceback.print_exc()
            return {"statusCode": 500, "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})}

    # ── RESET FILE_EXPECTED ACTION ──
    # Admin-only. Flips File_Expected back to 'Y' for an entity+source row
    # in SETUP_CONVERSION_PLAN_{MOCK} so the source team can re-upload after
    # the gate auto-flipped it to 'N' on a successful Table Load. Required by
    # spec for the "re-extract after rejection" workflow (Phase 4 will call
    # this automatically when a validation run is rejected with
    # Reextract_Required=Y).
    if action == "reset_file_expected":
        try:
            params = event.get("queryStringParameters") or {}
            mock = params.get("mock", "")
            entity = params.get("entity", "") or None
            src = params.get("source", "") or None
            vgid = params.get("validation_group_id", "") or None
            reason = params.get("reason", "") or None
            actor = params.get("actor", "")

            conn_str = get_connection_string()
            result = handle_reset_file_expected(
                connection_str=conn_str,
                mock_number=mock,
                entity=entity,
                source=src,
                validation_group_id=vgid,
                reason=reason,
                actor=actor,
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
                    # Phase 1 spec columns — present on Mocks promoted to
                    # the 100-col shape; gracefully skipped on legacy Mocks.
                    "File_Expected", "Current_Process_Stage", "Validation_Group_ID",
                    "Latest_Validation_Status", "Latest_Approval_Status",
                    "Pre_Load_Validation_Status", "Pre_Load_Recon_Status",
                    "Oracle_Load_Status",
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
