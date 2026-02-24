"""
AP Invoice Processor Lambda Function
=====================================
Processes AP Invoice CSV files from S3, validates them, and loads data into
SQL Server staging tables (Hacienda_ERP_Test database).

Invoked via Lambda Function URL with query parameters:
    ?action=process  — Process all files in APInvoiceInput/
    ?action=status   — Return current processing status

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
from column_mappings import get_mapping, get_table_name
from table_definitions import get_create_table_sql

# ─── Configuration ────────────────────────────────────────────────────────────

DEFAULT_BUCKET = "hacienda-erp-dev"
INPUT_FOLDER = "APInvoiceInput/"
UPLOADED_FOLDER = "UploadedAPInvoices/"
FAILED_FOLDER = "FailedAPInvoices/"
STATUS_FILE_KEY = "APInvoiceInput/_processing_status.json"
HISTORY_FOLDER_KEY = "APInvoiceInput/_processing_history/"

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
    """List all CSV files in the input folder."""
    files = []
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=INPUT_FOLDER):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            name = key.split("/")[-1]
            # Skip folder markers, status files, hidden files
            if not name or name.startswith("_") or name.startswith(".") or key.endswith("/"):
                continue
            if name.lower().endswith(".csv"):
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
    # Format: 2026-02-24T15-30-45Z (replace colons for S3 key safety)
    safe_timestamp = completed_at.replace(":", "-")
    # Truncate microseconds if present
    if "." in safe_timestamp:
        safe_timestamp = safe_timestamp.split(".")[0]
    safe_timestamp += "Z"
    history_key = f"{HISTORY_FOLDER_KEY}{safe_timestamp}.json"

    # Calculate duration if both timestamps present
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


def read_csv_from_s3(bucket, key):
    """Read a CSV file from S3 into a pandas DataFrame."""
    response = s3_client.get_object(Bucket=bucket, Key=key)
    content = response["Body"].read().decode("utf-8")
    df = pd.read_csv(io.StringIO(content), dtype=str)
    df = df.fillna("")
    return df


# ─── Table Management ─────────────────────────────────────────────────────────

def ensure_table_exists(cursor, table_name, file_type, source):
    """
    Check if the target table exists; create it if not.

    Uses SQL Server sys.tables to check existence, then creates using
    the column definitions from table_definitions.py.
    """
    cursor.execute(
        "SELECT COUNT(*) FROM sys.tables WHERE name = ?",
        (table_name,)
    )
    exists = cursor.fetchone()[0] > 0

    if exists:
        print(f"  Table {table_name} exists")
        return False  # did not create

    # Table doesn't exist — create it
    create_sql = get_create_table_sql(table_name, file_type, source)
    if not create_sql:
        raise ValueError(
            f"Cannot auto-create table {table_name}: "
            f"no definition for type={file_type}, source={source}"
        )

    print(f"  Creating table {table_name}...")
    cursor.execute(create_sql)
    cursor.connection.commit()
    print(f"  Table {table_name} created successfully")
    return True  # table was created


# ─── Processing Logic ─────────────────────────────────────────────────────────

def process_single_file(bucket, file_info, connection_str):
    """
    Process a single AP Invoice CSV file.

    Returns:
        dict with keys: filename, status, rowCount, error, source, type, mockNumber
    """
    filename = file_info["name"]
    file_key = file_info["key"]
    result = {
        "filename": filename,
        "source": "",
        "type": "",
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

        result["source"] = parsed["source"]
        result["type"] = parsed["file_type"]
        result["mockNumber"] = parsed["mock_number"]

        file_type = parsed["file_type"]
        source = parsed["source"]
        mock_number = parsed["mock_number"]

        print(f"Processing: {filename} | Type={file_type} Source={source} Mock={mock_number}")

        # Step 2: Validate source
        if not validate_source(source):
            raise ValueError(f"Unknown source agency: {source}")

        # Step 3: Get column mapping
        mapping = get_mapping(file_type, source)
        if not mapping:
            raise ValueError(
                f"No column mapping found for type={file_type}, source={source}. "
                f"This source/type combination is not supported."
            )

        # Step 4: Read CSV from S3
        print(f"  Reading CSV from S3: {file_key}")
        df = read_csv_from_s3(bucket, file_key)
        print(f"  CSV loaded: {len(df)} rows, {len(df.columns)} columns")

        if len(df) == 0:
            raise ValueError("CSV file is empty (header only, no data rows)")

        # Step 5: Validate CSV headers
        actual_headers = list(df.columns)
        expected_csv_cols = mapping["csv_columns"]
        is_valid, header_error = validate_csv_headers(actual_headers, expected_csv_cols)
        if not is_valid:
            raise ValueError(f"Header validation failed: {header_error}")

        # Step 6: Determine target table
        table_name = get_table_name(file_type, mock_number, source)
        print(f"  Target table: {table_name}")

        # Step 7: Connect and truncate table
        sql_columns = mapping["sql_columns"]
        placeholders = ", ".join(["?"] * len(sql_columns))
        col_list = ", ".join(sql_columns)

        with pyodbc.connect(connection_str) as conn:
            cursor = conn.cursor()

            # Ensure table exists (auto-create if needed)
            was_created = ensure_table_exists(cursor, table_name, file_type, source)

            # Truncate the target table (skip if just created — it's empty)
            if not was_created:
                print(f"  Truncating table: {table_name}")
                cursor.execute(f"DELETE FROM {table_name}")
                conn.commit()

            # Step 8: Build rows for insert
            csv_cols = mapping["csv_columns"]
            rows = []
            for _, row in df.iterrows():
                values = []
                for csv_col in csv_cols:
                    val = str(row.get(csv_col, "")).strip()
                    values.append(val if val else None)
                rows.append(tuple(values))

            # Step 9: Bulk insert
            insert_sql = f"INSERT INTO {table_name} ({col_list}) VALUES ({placeholders})"
            print(f"  Inserting {len(rows)} rows...")

            # Insert in batches of 1000 for large files
            batch_size = 1000
            for i in range(0, len(rows), batch_size):
                batch = rows[i:i + batch_size]
                cursor.executemany(insert_sql, batch)
                conn.commit()

            result["rowCount"] = len(rows)
            print(f"  Successfully inserted {len(rows)} rows into {table_name}")

        # Step 10: Move to uploaded folder
        dest_key = f"{UPLOADED_FOLDER}{source}/{filename}"
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
            dest_key = f"{FAILED_FOLDER}{result.get('source', 'unknown')}/{filename}"
            move_file(bucket, file_key, dest_key)
            write_error_file(bucket, dest_key, f"{error_msg}\n\n{tb}")
            print(f"  Moved to: {dest_key}")
        except Exception as move_err:
            print(f"  ERROR moving failed file: {move_err}")

    return result


# ─── Lambda Handler ───────────────────────────────────────────────────────────

def lambda_handler(event, context):
    """
    Main Lambda handler.

    Supports two actions:
        ?action=process  — Process all files in input folder
        ?action=status   — Return current processing status
    """
    # Parse action from query string or body
    action = "process"

    if "queryStringParameters" in event and event["queryStringParameters"]:
        action = event["queryStringParameters"].get("action", "process")
    elif "rawQueryString" in event and event["rawQueryString"]:
        for param in event["rawQueryString"].split("&"):
            if param.startswith("action="):
                action = param.split("=")[1]

    # Parse bucket from body or use default
    bucket = DEFAULT_BUCKET
    if "body" in event and event["body"]:
        try:
            body = json.loads(event["body"])
            bucket = body.get("bucket", DEFAULT_BUCKET)
        except (json.JSONDecodeError, TypeError):
            pass

    print(f"AP Invoice Processor: action={action}, bucket={bucket}")

    # CORS headers for Function URL
    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }

    # Handle OPTIONS (CORS preflight)
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {"statusCode": 200, "headers": headers, "body": ""}

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

            # Sort newest first (ISO timestamps sort lexicographically)
            history_files.sort(reverse=True)

            # Limit to last 50 runs
            history_files = history_files[:50]

            # Fetch content of each history file
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
            # List input files
            input_files = list_input_files(bucket)

            if not input_files:
                return {
                    "statusCode": 200,
                    "headers": headers,
                    "body": json.dumps({
                        "status": "complete",
                        "message": "No files found in input folder",
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

            # Initialize file status entries
            for f in input_files:
                parsed = parse_filename(f["name"])
                status["files"].append({
                    "filename": f["name"],
                    "source": parsed.get("source", ""),
                    "type": parsed.get("file_type", ""),
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
                # Update status to show current file as processing
                status["files"][i]["status"] = "processing"
                status["files"][i]["startedAt"] = datetime.utcnow().isoformat()
                write_status(bucket, status)

                # Process the file
                result = process_single_file(bucket, file_info, connection_str)

                # Update status with result
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

            print(f"Processing complete: {status['successCount']} success, {status['failCount']} failed")

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps(status, default=str),
            }

        except Exception as e:
            tb = traceback.format_exc()
            print(f"FATAL ERROR: {e}\n{tb}")

            # Try to update status
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
        "body": json.dumps({"error": f"Unknown action: {action}. Use 'process' or 'status'."}),
    }
