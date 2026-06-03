"""
backfill_aws_files.py
======================
Walks the entire S3 bucket and writes a seq 1 'Archived' row to AWS_FILES
for every legacy file the dashboard should know about. Run once at cutover,
then disable.

Why 'Archived' and not 'Received'?
    The spec's File_Status enum reserves 'Received' for files that just
    landed and are about to run gate checks. Pre-existing files have
    already been processed (or have been sitting in errors/ for ages);
    they don't represent live pipeline events. 'Archived' is the right
    enum for "this file exists in S3 but predates tracking."

What gets backfilled?
    Every CSV / XLSX in:
        ProcessedFiles/...        — completed loads
        FailedInvoices/...        — failed loads
        FailedUnmatchedFilenames/ — couldn't be parsed
        InitialUpload/            — anything still pending
        ConversionFiles/          — moved-but-not-loaded
        DataValidation/           — validation outputs
        Dalving Input/            — operator-managed
    What gets skipped:
        Hidden files (start with _ or .)
        S3 directory markers (keys ending in /)
        Folders we don't care about (the entire 'amplify-*' prefix etc.)

Idempotent: skips files whose eTag already exists in AWS_FILES.

Usage:
    # Make sure HACIENDA_SQL_CONN points at Hacienda_ERP_Test and you have
    # AWS credentials with s3:ListBucket on the target bucket.
    python scripts/backfill_aws_files.py
        [--bucket hacienda-erp-dev]
        [--dry-run]
        [--limit 5000]
        [--prefix "ProcessedFiles/"]   # optional, narrows the walk
"""

import argparse
import os
import sys
from datetime import datetime
from typing import Iterable

import boto3

# Top-level prefixes we backfill. Anything outside this list is ignored so
# we don't fill the dashboard with Amplify artifacts, status JSON, etc.
TRACKED_PREFIXES = [
    "ProcessedFiles/",
    "FailedInvoices/",
    "FailedUnmatchedFilenames/",
    "InitialUpload/",
    "InputFilesForProcessing/",
    "ConversionFiles/",
    "ConversionFileErrors/",
    "DataValidation/",
    "Dalving Input/",
    "TSQLFiles/",
    "InitialUploadErrors/",
    "APInvoiceInput/",
    "UploadedAPInvoices/",
    "FailedAPInvoices/",
]

# Skip these — they're internal to Lambda / Amplify, not user data.
INTERNAL_PREFIXES = (
    "_admin/",
    "amplify-",
    "InputFilesForProcessing/_processing_status.json",
    "InputFilesForProcessing/_processing_history/",
)

ALLOWED_EXT = (".csv", ".xlsx", ".xls", ".json", ".txt", ".zip", ".7z")


def is_trackable(key: str) -> bool:
    if key.endswith("/"):
        return False
    for skip in INTERNAL_PREFIXES:
        if key.startswith(skip):
            return False
    name = key.split("/")[-1]
    if name.startswith("_") or name.startswith("."):
        return False
    lower = name.lower()
    if not any(lower.endswith(ext) for ext in ALLOWED_EXT):
        return False
    # Must live under one of the tracked prefixes
    return any(key.startswith(p) for p in TRACKED_PREFIXES)


def walk_bucket(bucket: str, prefix: str = "") -> Iterable[dict]:
    """Yield every S3 object dict under the prefix (paginated)."""
    s3 = boto3.client("s3")
    paginator = s3.get_paginator("list_objects_v2")
    kwargs = {"Bucket": bucket}
    if prefix:
        kwargs["Prefix"] = prefix
    for page in paginator.paginate(**kwargs):
        for obj in page.get("Contents", []):
            yield obj


def parsed_or_none(name: str) -> dict | None:
    """Best-effort parse — if it fails we still backfill the row, just with less metadata."""
    try:
        from Lambda.ap_invoice_processor.file_validator import parse_filename  # type: ignore
    except Exception:
        # Lambda module isn't importable from here — manual parse fallback
        return None
    try:
        p = parse_filename(name)
        return p if p.get("valid") else None
    except Exception:
        return None


def insert_archive_row(cur, *, etag: str, bucket: str, key: str,
                       size_bytes: int, last_modified: datetime,
                       parsed: dict | None) -> bool:
    """Returns True if a row was inserted, False if it already existed."""
    cur.execute(
        "SELECT COUNT(*) FROM AWS_FILES WHERE AWS_eTag = ? AND Movement_Sequence = 1",
        (etag,),
    )
    if cur.fetchone()[0] > 0:
        return False

    filename = key.split("/")[-1]
    parent_folder = "/".join(key.split("/")[:-1]) + "/" if "/" in key else ""
    parent_url = f"s3://{bucket}/{parent_folder}" if parent_folder else f"s3://{bucket}/"
    file_url = f"s3://{bucket}/{key}"

    # Best-effort metadata
    mock_number = (parsed or {}).get("mock_number") or ""
    source = (parsed or {}).get("source") or ""
    module = (parsed or {}).get("module") or ""
    entity_display = (parsed or {}).get("entity_display") or ""

    # File_Category heuristic
    if key.startswith("DataValidation/"):
        file_category = "Validation to Source"
    elif key.startswith("ConversionFiles/") and "Errors" not in key:
        file_category = "Extract"
    else:
        file_category = "Extract"

    cur.execute(
        """
        INSERT INTO AWS_FILES (
            AWS_eTag, Movement_Sequence, File_Name, File_Category,
            File_Size_KB, Attempt_Number,
            Conversion_Plan_Entity, [Source], Module, Data_Entity, Mock_Number,
            S3_Bucket, Parent_Folder, Parent_Folder_URL, File_URL,
            Created_DateTime, Received_DateTime, File_Status,
            Check_File_Name, Check_File_Expected, Check_Column_Headers,
            Check_TSQL_File_Found, Check_TSQL_Load,
            Created_By, Last_Updated_By, Last_Updated_DateTime,
            Notes
        ) VALUES (
            ?, 1, ?, ?,
            ?, 1,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, 'Archived',
            'N/A', 'N/A', 'N/A', 'N/A', 'N/A',
            'backfill_aws_files.py', 'backfill_aws_files.py', SYSUTCDATETIME(),
            ?
        )
        """,
        (
            etag, filename, file_category,
            size_bytes // 1024 if size_bytes else None,
            entity_display or None, source or None, module or None,
            entity_display or None, mock_number or None,
            bucket, parent_folder, parent_url, file_url,
            last_modified, last_modified,
            "Backfilled from existing S3 inventory" if parsed else
            "Backfilled — filename did not parse against known patterns",
        ),
    )
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bucket", default="hacienda-erp-dev")
    ap.add_argument("--prefix", default="", help="Restrict the walk to this S3 prefix")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N inserts (0 = no limit)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn_str = os.environ.get("HACIENDA_SQL_CONN", "")
    if not args.dry_run and not conn_str:
        print("ERROR: HACIENDA_SQL_CONN env var required (or use --dry-run)", file=sys.stderr)
        sys.exit(1)

    seen = 0
    inserted = 0
    skipped_internal = 0
    skipped_existing = 0

    conn = None
    cur = None
    if not args.dry_run:
        import pyodbc
        conn = pyodbc.connect(conn_str)
        cur = conn.cursor()

    try:
        for obj in walk_bucket(args.bucket, args.prefix):
            seen += 1
            key = obj["Key"]
            if not is_trackable(key):
                skipped_internal += 1
                continue

            etag = (obj.get("ETag", "") or "").strip().strip('"')
            if not etag:
                continue

            name = key.split("/")[-1]
            parsed = parsed_or_none(name)

            if args.dry_run:
                inserted += 1
                if inserted <= 20:
                    print(
                        f"  [{inserted:4d}] {key}  ({obj['Size']:,} bytes, "
                        f"eTag={etag[:12]}…, parsed={bool(parsed)})"
                    )
                if args.limit and inserted >= args.limit:
                    break
                continue

            # Live mode
            try:
                if insert_archive_row(
                    cur,
                    etag=etag, bucket=args.bucket, key=key,
                    size_bytes=obj["Size"],
                    last_modified=obj["LastModified"],
                    parsed=parsed,
                ):
                    inserted += 1
                else:
                    skipped_existing += 1
                if inserted and inserted % 100 == 0:
                    conn.commit()
                    print(f"  committed {inserted} rows so far…")
                if args.limit and inserted >= args.limit:
                    break
            except Exception as ie:
                print(f"  WARNING: insert failed for {key}: {ie}", file=sys.stderr)

        if not args.dry_run:
            conn.commit()
    finally:
        if cur is not None:
            cur.close()
        if conn is not None:
            conn.close()

    print()
    print("=" * 60)
    print(f"Walked         {seen:,} objects")
    print(f"Skipped (internal/non-trackable): {skipped_internal:,}")
    print(f"Skipped (already in AWS_FILES):    {skipped_existing:,}")
    print(f"Inserted        {inserted:,} new rows" + (" (dry-run)" if args.dry_run else ""))
    print("=" * 60)


if __name__ == "__main__":
    main()
