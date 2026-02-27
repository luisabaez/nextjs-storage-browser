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

# ─── Configuration ────────────────────────────────────────────────────────────

DEFAULT_BUCKET = "hacienda-erp-dev"
INPUT_FOLDER = "InputFilesForProcessing/"
PROCESSED_FOLDER = "ProcessedFiles/"
FAILED_FOLDER = "FailedInvoices/"
FAILED_UNMATCHED_FOLDER = "FailedUnmatchedFilenames/"
STATUS_FILE_KEY = "InputFilesForProcessing/_processing_status.json"
HISTORY_FOLDER_KEY = "InputFilesForProcessing/_processing_history/"

s3_client = boto3.client("s3")


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


def write_error_file(bucket, file_key, error_message):
    """Write an error detail file next to the failed file."""
    error_key = file_key + "_error.txt"
    s3_client.put_object(
        Bucket=bucket,
        Key=error_key,
        Body=error_message,
        ContentType="text/plain",
    )


def read_file_from_s3(bucket, key, extension):
    """Read a CSV or XLSX file from S3 into a pandas DataFrame."""
    response = s3_client.get_object(Bucket=bucket, Key=key)
    content = response["Body"].read()

    if extension == "xlsx":
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            raise ValueError("openpyxl is required for XLSX files but not installed")
        df = pd.read_excel(io.BytesIO(content), dtype=str, engine="openpyxl")
    else:
        df = pd.read_csv(io.BytesIO(content), dtype=str, encoding="utf-8")

    df = df.fillna("")
    return df


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
    """
    cursor.execute(
        "SELECT COUNT(*) FROM sys.tables WHERE name = ?",
        (table_name,)
    )
    exists = cursor.fetchone()[0] > 0

    if exists:
        print(f"  Table {table_name} exists")
        return False

    # Build CREATE TABLE with all NVARCHAR(500) columns
    col_defs = ",\n    ".join(f"[{col}] NVARCHAR(500)" for col in sql_columns)
    create_sql = f"CREATE TABLE [{table_name}] (\n    {col_defs}\n)"

    print(f"  Creating table {table_name}...")
    cursor.execute(create_sql)
    cursor.connection.commit()
    print(f"  Table {table_name} created successfully")
    return True


# ─── Processing Logic ─────────────────────────────────────────────────────────

def process_single_file(bucket, file_info, connection_str):
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

    try:
        # Step 1: Parse filename
        parsed = parse_filename(filename)
        if not parsed["valid"]:
            raise ValueError(f"Invalid filename: {parsed['error']}")

        if parsed["is_excluded"]:
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

        # Step 3: Read file from S3
        print(f"  Reading {extension.upper()} from S3: {file_key}")
        df = read_file_from_s3(bucket, file_key, extension)
        print(f"  File loaded: {len(df)} rows, {len(df.columns)} columns")

        if len(df) == 0:
            raise ValueError("File is empty (header only, no data rows)")

        # Step 4: Route to legacy or new processing path
        if is_legacy and parsed.get("file_type"):
            # Legacy AP Invoice path
            file_type = parsed["file_type"]
            mapping = legacy_get_mapping(file_type, source)
            if not mapping:
                raise ValueError(
                    f"No column mapping found for legacy type={file_type}, source={source}"
                )

            # Validate CSV headers
            actual_headers = list(df.columns)
            is_valid, header_error = validate_csv_headers(actual_headers, mapping["csv_columns"])
            if not is_valid:
                raise ValueError(f"Header validation failed: {header_error}")

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

                rows = _build_rows(df, csv_columns)
                _batch_insert(cursor, conn, table_name, sql_columns, rows)
                result["rowCount"] = len(rows)

        else:
            # New multi-module processing path
            mapping = get_column_mapping(entity_prefix, source)

            if mapping:
                # Mapping found — validate headers and use mapped columns
                csv_columns = mapping["csv_columns"]
                sql_columns = mapping["sql_columns"]

                actual_headers = list(df.columns)
                is_valid, header_error = validate_csv_headers(actual_headers, csv_columns)
                if not is_valid:
                    raise ValueError(f"Header validation failed: {header_error}")

                table_name = registry_get_table_name(entity_prefix, mock_number, source)
                print(f"  Target table (mapped): {table_name}")

                with pyodbc.connect(connection_str) as conn:
                    cursor = conn.cursor()
                    was_created = ensure_table_exists_dynamic(cursor, table_name, sql_columns)

                    if not was_created:
                        print(f"  Truncating table: {table_name}")
                        cursor.execute(f"DELETE FROM [{table_name}]")
                        conn.commit()

                    rows = _build_rows(df, csv_columns)
                    _batch_insert(cursor, conn, table_name, sql_columns, rows)
                    result["rowCount"] = len(rows)

            else:
                # No mapping — dynamic fallback: sanitize CSV headers
                print(f"  WARNING: No column mapping for {entity_prefix}/{source}, "
                      f"using dynamic fallback")
                actual_headers = list(df.columns)
                sql_columns = [sanitize_column_name(h) for h in actual_headers]
                csv_columns = actual_headers

                table_name = registry_get_table_name(entity_prefix, mock_number, source)
                print(f"  Target table (dynamic): {table_name}")

                with pyodbc.connect(connection_str) as conn:
                    cursor = conn.cursor()
                    was_created = ensure_table_exists_dynamic(cursor, table_name, sql_columns)

                    if not was_created:
                        print(f"  Truncating table: {table_name}")
                        cursor.execute(f"DELETE FROM [{table_name}]")
                        conn.commit()

                    rows = _build_rows(df, csv_columns)
                    _batch_insert(cursor, conn, table_name, sql_columns, rows)
                    result["rowCount"] = len(rows)

        # Step 5: Move to processed folder (organized by MODULE/MOCK/SOURCE/ENTITY)
        dest_key = f"{PROCESSED_FOLDER}{parsed['module']}/{mock_number}/{source}/{entity_prefix}/{filename}"
        move_file(bucket, file_key, dest_key)
        print(f"  Moved to: {dest_key}")

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


# ─── Lambda Handler ───────────────────────────────────────────────────────────

def lambda_handler(event, context):
    """
    Main Lambda handler.

    Supports actions:
        ?action=process   — Process all files in input folder
        ?action=status    — Return current processing status
        ?action=history   — Return processing run history
        ?action=entities  — Return entity registry for dashboard
    """
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
    filter_mock = params.get("mock", "").upper()

    # Parse bucket from body or use default
    bucket = DEFAULT_BUCKET
    if "body" in event and event["body"]:
        try:
            body = json.loads(event["body"])
            bucket = body.get("bucket", DEFAULT_BUCKET)
        except (json.JSONDecodeError, TypeError):
            pass

    print(f"Data File Processor: action={action}, bucket={bucket}, "
          f"module={filter_module}, entity={filter_entity}, mock={filter_mock}")

    # CORS headers
    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }

    # Handle OPTIONS (CORS preflight)
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

    # ── PROCESS ACTION ──
    if action == "process":
        try:
            input_files = list_input_files(bucket)

            # Apply filters
            if filter_module or filter_entity or filter_mock:
                filtered = []
                for f in input_files:
                    parsed = parse_filename(f["name"])
                    if filter_module and parsed.get("module", "").upper() != filter_module:
                        continue
                    if filter_entity and filter_entity not in parsed.get("entity_prefix", "").upper():
                        continue
                    if filter_mock and parsed.get("mock_number", "").upper() != filter_mock:
                        continue
                    filtered.append(f)
                input_files = filtered

            if not input_files:
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

            print(f"Found {len(input_files)} file(s) to process")

            # Initialize status
            status = {
                "status": "processing",
                "startedAt": datetime.utcnow().isoformat(),
                "completedAt": None,
                "totalFiles": len(input_files),
                "processedFiles": 0,
                "successCount": 0,
                "failCount": 0,
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

            # Process each file
            for i, file_info in enumerate(input_files):
                status["files"][i]["status"] = "processing"
                status["files"][i]["startedAt"] = datetime.utcnow().isoformat()
                write_status(bucket, status)

                result = process_single_file(bucket, file_info, connection_str)

                status["files"][i] = result
                status["processedFiles"] = i + 1

                if result["status"] == "success":
                    status["successCount"] += 1
                else:
                    status["failCount"] += 1

                write_status(bucket, status)

            # Mark as complete
            status["status"] = "complete"
            status["completedAt"] = datetime.utcnow().isoformat()
            write_status(bucket, status)

            # Archive to history
            write_history(bucket, status)

            print(f"Processing complete: {status['successCount']} success, "
                  f"{status['failCount']} failed")

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
