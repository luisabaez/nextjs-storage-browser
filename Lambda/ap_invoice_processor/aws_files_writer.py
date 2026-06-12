"""
aws_files_writer.py
====================
Writes rows to the AWS_FILES event-log table at every meaningful S3 file
transition. This is the heart of Phase 2 — without it the dashboard has
no visibility into what's happening to a file at any moment.

The composite primary key is (AWS_eTag, Movement_Sequence):
    seq 1 = file landed (InitialUpload / InputFilesForProcessing)
    seq 2 = file moved to a destination (ConversionFiles / ProcessedFiles)

A failed file has seq 1 only (gate-check or load failure → moved to Errors,
Moved_To_Folder populated on seq 1, no seq 2).

Version chain: Supersedes_eTag / Superseded_By_eTag form a doubly-linked
history. When a new upload lands for an entity that already has an active
row in AWS_FILES (Superseded_By_eTag IS NULL), the new seq 1 inherits
Supersedes_eTag pointing at the prior row, and the prior row's
Superseded_By_eTag is set to the new eTag.

Every public function wraps its work in a try/except and **never raises**.
If the tracking write fails, the print goes to CloudWatch but the file
processing continues — tracking is observational, not authoritative.
"""

from datetime import datetime
from typing import Optional

import pyodbc


# ─────────────────────────────────────────────────────────────────────────────
# File_Status enum (spec section: AWS Files → File_Status)
# ─────────────────────────────────────────────────────────────────────────────
STATUS_RECEIVED              = "Received"
STATUS_GATE_CHECK_RUNNING    = "Gate Check Running"
STATUS_INVALID_FILE_NAME     = "Invalid File Name"
STATUS_FILE_NOT_EXPECTED     = "File Not Expected"
STATUS_INVALID_HEADERS       = "Invalid Headers"
STATUS_TSQL_FILE_NOT_FOUND   = "TSQL Load File Not Found"
STATUS_TSQL_LOAD_ERROR       = "TSQL Load Error"
STATUS_TABLE_LOAD_SUCCESS    = "Table Load Success"
STATUS_SUPERSEDED            = "Superseded"
STATUS_ARCHIVED              = "Archived"

# Gate check result enum
CHECK_PASS    = "Pass"
CHECK_FAIL    = "Fail"
CHECK_NOT_RUN = "Not Run"
CHECK_NA      = "N/A"

# Error owner
OWNER_SOURCE_TEAM   = "Source Team"
OWNER_PIPELINE_TEAM = "Pipeline Team"

# Gate-check column names in order (must match the spec)
GATE_CHECK_COLUMNS = [
    "Check_File_Name",
    "Check_File_Expected",
    "Check_Column_Headers",
    "Check_TSQL_File_Found",
    "Check_TSQL_Load",
]

# Map failed-check column → error_type / error_owner
_FAILURE_DETAILS = {
    "Check_File_Name":       (STATUS_INVALID_FILE_NAME,   OWNER_SOURCE_TEAM),
    "Check_File_Expected":   (STATUS_FILE_NOT_EXPECTED,   OWNER_SOURCE_TEAM),
    "Check_Column_Headers":  (STATUS_INVALID_HEADERS,     OWNER_SOURCE_TEAM),
    "Check_TSQL_File_Found": (STATUS_TSQL_FILE_NOT_FOUND, OWNER_PIPELINE_TEAM),
    "Check_TSQL_Load":       (STATUS_TSQL_LOAD_ERROR,     OWNER_PIPELINE_TEAM),
}


def _now() -> datetime:
    return datetime.utcnow()


def _normalise_etag(etag: str) -> str:
    """S3 eTags come wrapped in double quotes — strip them."""
    return (etag or "").strip().strip('"')


def _safe(fn):
    """
    Decorator: log+swallow exceptions. AWS_FILES writes are observational and
    must not break file processing if SQL is briefly unreachable.
    """
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            import traceback
            print(f"  WARNING: aws_files_writer.{fn.__name__} failed: {e}")
            traceback.print_exc()
            return None
    return wrapper


# ─────────────────────────────────────────────────────────────────────────────
# Conversion Plan FK resolution
# ─────────────────────────────────────────────────────────────────────────────
def _resolve_conversion_plan_fk(cursor, mock_number: str, parsed: dict) -> dict:
    """
    Look up FK columns on SETUP_CONVERSION_PLAN_{MOCK} for the parsed file.
    Returns whatever it can find; missing values are returned as None.
    """
    fk = {
        "WBS_ID": None,
        "Conversion_Plan_Table_Name": None,
        "Conversion_Plan_Entity": parsed.get("entity_display") or parsed.get("entity_prefix"),
        "Validation_Group_ID": None,
        "Pillar": None,
        "Module": parsed.get("module"),
        "Data_Entity": parsed.get("entity_display"),
        "Source": parsed.get("source"),
    }

    if not mock_number:
        return fk

    setup_table = f"SETUP_CONVERSION_PLAN_{mock_number}"
    # Quick existence guard so we don't blow up on a Mock that hasn't been
    # provisioned yet (the Lambda auto-create handles that on first load).
    cursor.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (setup_table,))
    if cursor.fetchone()[0] == 0:
        return fk

    # Match by entity + source — entity_prefix is the most reliable join key.
    entity = parsed.get("entity_display") or parsed.get("entity_prefix") or ""
    source = parsed.get("source") or ""
    sub_entity = parsed.get("entity_prefix") or ""

    cursor.execute(
        f"""
        SELECT TOP 1
            [ID],
            [Table_Name],
            [Validation_Group_ID],
            [Pillar],
            [Module],
            [Entity]
        FROM [{setup_table}]
        WHERE (
            (LTRIM(RTRIM(ISNULL([Entity], ''))) = ? AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?)
            OR
            (LTRIM(RTRIM(ISNULL([SubEntity], ''))) = ? AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?)
        )
        """,
        (entity, source, sub_entity, source),
    )
    row = cursor.fetchone()
    if row:
        fk["WBS_ID"] = row[0]
        fk["Conversion_Plan_Table_Name"] = row[1]
        fk["Validation_Group_ID"] = row[2]
        fk["Pillar"] = row[3]
        if not fk["Module"]:
            fk["Module"] = row[4]
        if not fk["Data_Entity"]:
            fk["Data_Entity"] = row[5]
    return fk


# ─────────────────────────────────────────────────────────────────────────────
# Version chain
# ─────────────────────────────────────────────────────────────────────────────
def _link_version_chain(cursor, new_etag: str, parsed: dict, mock_number: str) -> Optional[str]:
    """
    Find the prior active eTag for the same entity+source+mock and set up
    the version chain. Returns the prior eTag if one was found, else None.
    """
    entity = parsed.get("entity_display") or parsed.get("entity_prefix") or ""
    source = parsed.get("source") or ""
    if not entity or not source or not mock_number:
        return None

    cursor.execute(
        """
        SELECT TOP 1 AWS_eTag
        FROM AWS_FILES
        WHERE Conversion_Plan_Entity = ?
          AND [Source] = ?
          AND Mock_Number = ?
          AND Movement_Sequence = 1
          AND Superseded_By_eTag IS NULL
          AND AWS_eTag <> ?
        ORDER BY Received_DateTime DESC
        """,
        (entity, source, mock_number, new_etag),
    )
    row = cursor.fetchone()
    if not row:
        return None
    prior_etag = row[0]

    # Point the prior row at the new one and mark it superseded.
    cursor.execute(
        """
        UPDATE AWS_FILES SET
            Superseded_By_eTag = ?,
            File_Status = ?,
            Last_Updated_DateTime = SYSUTCDATETIME(),
            Last_Updated_By = 'ap-invoice-processor-lambda'
        WHERE AWS_eTag = ?
        """,
        (new_etag, STATUS_SUPERSEDED, prior_etag),
    )
    return prior_etag


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────
@_safe
def write_received_row(connection_str: str, bucket: str, file_key: str,
                       etag: str, file_size_bytes: int,
                       parsed: Optional[dict] = None,
                       triggered_by: str = "",
                       reason_for_upload: Optional[str] = None) -> Optional[str]:
    """
    Writes the seq 1 'Received' row. Idempotent: if (eTag, 1) already exists,
    leaves it alone (re-runs of the Lambda on the same file don't duplicate).

    parsed may be None if parse_filename failed — in that case the row is
    still written with whatever metadata we have so the dashboard sees the
    bad file. The caller should immediately follow with
    mark_gate_check_failure('Check_File_Name', ...).

    Returns the normalised eTag.
    """
    etag = _normalise_etag(etag)
    if not etag:
        print("  WARNING: write_received_row called without eTag — skipping")
        return None

    parsed = parsed or {}
    filename = parsed.get("filename") or file_key.split("/")[-1]
    parent_folder = "/".join(file_key.split("/")[:-1]) + "/" if "/" in file_key else ""
    file_url = f"s3://{bucket}/{file_key}"
    parent_url = f"s3://{bucket}/{parent_folder}" if parent_folder else f"s3://{bucket}/"

    now = _now()

    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()

        # Idempotency guard
        cur.execute(
            "SELECT COUNT(*) FROM AWS_FILES WHERE AWS_eTag = ? AND Movement_Sequence = 1",
            (etag,),
        )
        if cur.fetchone()[0] > 0:
            return etag  # already tracked

        mock_number = parsed.get("mock_number") or ""
        fk = _resolve_conversion_plan_fk(cur, mock_number, parsed) if parsed else {
            "WBS_ID": None, "Conversion_Plan_Table_Name": None,
            "Conversion_Plan_Entity": None, "Validation_Group_ID": None,
            "Pillar": None, "Module": None, "Data_Entity": None, "Source": None,
        }

        # Compute attempt number across all rows for this filename + mock
        attempt_number = 1
        if mock_number and filename:
            cur.execute(
                """
                SELECT COUNT(DISTINCT AWS_eTag) FROM AWS_FILES
                WHERE File_Name = ? AND Mock_Number = ?
                """,
                (filename, mock_number),
            )
            attempt_number = (cur.fetchone()[0] or 0) + 1

        # Link the prior version (if any) into the chain
        prior_etag = _link_version_chain(cur, etag, parsed, mock_number) if parsed else None

        cur.execute(
            """
            INSERT INTO AWS_FILES (
                AWS_eTag, Movement_Sequence, File_Name, File_Category,
                File_Size_KB, Attempt_Number,
                Conversion_Plan_Table_Name, Conversion_Plan_Entity,
                Validation_Group_ID, WBS_ID, Pillar, Module, Data_Entity,
                [Source], Mock_Number,
                S3_Bucket, Parent_Folder, Parent_Folder_URL, File_URL,
                Created_DateTime, Received_DateTime, File_Status,
                Error_Type, Error_Owner,
                Supersedes_eTag, Reason_for_Upload,
                Check_File_Name, Check_File_Expected, Check_Column_Headers,
                Check_TSQL_File_Found, Check_TSQL_Load,
                Created_By, Last_Updated_By, Last_Updated_DateTime
            ) VALUES (?, 1, ?, 'Extract',
                ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                NULL, NULL,
                ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?, ?)
            """,
            (
                etag, filename,
                file_size_bytes // 1024 if file_size_bytes else None, attempt_number,
                fk["Conversion_Plan_Table_Name"], fk["Conversion_Plan_Entity"],
                fk["Validation_Group_ID"], fk["WBS_ID"], fk["Pillar"], fk["Module"], fk["Data_Entity"],
                fk["Source"] or parsed.get("source"), mock_number or None,
                bucket, parent_folder, parent_url, file_url,
                now, now, STATUS_RECEIVED,
                prior_etag, reason_for_upload,
                CHECK_NOT_RUN, CHECK_NOT_RUN, CHECK_NOT_RUN,
                CHECK_NOT_RUN, CHECK_NOT_RUN,
                triggered_by or "ap-invoice-processor-lambda",
                "ap-invoice-processor-lambda", now,
            ),
        )
        conn.commit()
        print(f"  AWS_FILES seq 1 written for {filename} (eTag={etag[:12]}…, attempt {attempt_number})")
        if prior_etag:
            print(f"    └─ supersedes prior eTag {prior_etag[:12]}…")
    return etag


@_safe
def update_gate_check(connection_str: str, etag: str, check_column: str, result: str) -> None:
    """
    Update one of the Check_* columns on the seq 1 row.
    check_column must be one of GATE_CHECK_COLUMNS.
    result is Pass | Fail | Not Run | N/A.
    """
    etag = _normalise_etag(etag)
    if not etag or check_column not in GATE_CHECK_COLUMNS:
        return
    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"""
            UPDATE AWS_FILES SET
                [{check_column}] = ?,
                Last_Updated_DateTime = SYSUTCDATETIME(),
                Last_Updated_By = 'ap-invoice-processor-lambda'
            WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (result, etag),
        )
        conn.commit()


@_safe
def mark_gate_check_failure(connection_str: str, etag: str, failed_check: str,
                            error_message: str = "") -> None:
    """
    Cascade gate-check failure on the seq 1 row:
      - Failed column → 'Fail'
      - Any not-yet-run subsequent columns → 'Not Run'
      - File_Status, Error_Type, Error_Owner set per the failed check
      - Roll up Current_Process_Stage on the SETUP_CONVERSION_PLAN row per
        the spec enum: gate checks 1-3 → 'Gate Check Failed',
                       gate checks 4-5 → 'Table Load Failed'
    """
    etag = _normalise_etag(etag)
    if not etag or failed_check not in GATE_CHECK_COLUMNS:
        return
    file_status, error_owner = _FAILURE_DETAILS[failed_check]
    # Stage rollup per spec — first three checks are owned by Source Team
    # and surface as 'Gate Check Failed'; the TSQL pair surface as
    # 'Table Load Failed'.
    stage_rollup = ("Table Load Failed"
                    if failed_check in ("Check_TSQL_File_Found", "Check_TSQL_Load")
                    else "Gate Check Failed")
    # Subsequent checks all become Not Run (they were never attempted)
    idx = GATE_CHECK_COLUMNS.index(failed_check)
    subsequent = GATE_CHECK_COLUMNS[idx + 1:]
    set_clauses = [f"[{failed_check}] = ?"] + [f"[{c}] = ?" for c in subsequent]
    set_clauses += [
        "File_Status = ?",
        "Error_Type = ?",
        "Error_Owner = ?",
        "Notes = CASE WHEN ? = '' THEN Notes ELSE COALESCE(Notes + CHAR(10), '') + ? END",
        "Last_Updated_DateTime = SYSUTCDATETIME()",
        "Last_Updated_By = 'ap-invoice-processor-lambda'",
    ]
    params = [CHECK_FAIL] + [CHECK_NOT_RUN] * len(subsequent) + [
        file_status, file_status, error_owner,
        error_message or "", error_message or "",
    ]
    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"""
            UPDATE AWS_FILES SET {", ".join(set_clauses)}
            WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (*params, etag),
        )

        # Roll up the failure stage onto the SETUP_CONVERSION_PLAN row, if
        # we can identify the entity from the AWS_FILES row we just updated.
        cur.execute(
            """
            SELECT Mock_Number, Conversion_Plan_Entity, [Source]
            FROM AWS_FILES WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (etag,),
        )
        meta = cur.fetchone()
        if meta and meta[0] and meta[1] and meta[2]:
            mock, entity, source = meta
            setup_table = f"SETUP_CONVERSION_PLAN_{mock}"
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (setup_table,))
            if cur.fetchone()[0] > 0:
                cur.execute(
                    "SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID(?) AND name = 'Current_Process_Stage'",
                    (setup_table,),
                )
                if cur.fetchone()[0] > 0:
                    cur.execute(
                        f"""
                        UPDATE [{setup_table}] SET
                            Current_Process_Stage = ?,
                            Last_Updated_By = 'aws_files_writer',
                            Last_Updated_Date = SYSUTCDATETIME()
                        WHERE LTRIM(RTRIM(ISNULL([Entity], ''))) = ?
                          AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?
                        """,
                        (stage_rollup, entity, source),
                    )

        conn.commit()
        print(f"  AWS_FILES gate fail: eTag={etag[:12]}… check={failed_check} → {file_status} (stage: {stage_rollup})")


@_safe
def mark_load_success(connection_str: str, etag: str, table_name: str,
                      record_count: int) -> None:
    """
    Mark all five gate checks Pass, set File_Status='Table Load Success',
    capture Record_Count and Processed_DateTime. Called after a successful
    TSQL load, just before the file moves to ProcessedFiles.
    """
    etag = _normalise_etag(etag)
    if not etag:
        return
    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"""
            UPDATE AWS_FILES SET
                [Check_File_Name] = ?,
                [Check_File_Expected] = ?,
                [Check_Column_Headers] = ?,
                [Check_TSQL_File_Found] = ?,
                [Check_TSQL_Load] = ?,
                File_Status = ?,
                Error_Type = NULL,
                Error_Owner = NULL,
                Record_Count = ?,
                Conversion_Plan_Table_Name = COALESCE(Conversion_Plan_Table_Name, ?),
                Processed_DateTime = SYSUTCDATETIME(),
                Last_Updated_DateTime = SYSUTCDATETIME(),
                Last_Updated_By = 'ap-invoice-processor-lambda'
            WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (
                CHECK_PASS, CHECK_PASS, CHECK_PASS, CHECK_PASS, CHECK_PASS,
                STATUS_TABLE_LOAD_SUCCESS,
                record_count, table_name,
                etag,
            ),
        )
        conn.commit()
        print(f"  AWS_FILES load success: eTag={etag[:12]}… rows={record_count}")


@_safe
def write_seq2_move_row(connection_str: str, etag: str, bucket: str,
                        dest_key: str) -> None:
    """
    After a successful move to ConversionFiles/ProcessedFiles, write the
    seq 2 row showing the file at its new home, and update the seq 1 row's
    Moved_To_Folder so the dashboard's lineage view connects the two.

    Idempotent on (eTag, 2).
    """
    etag = _normalise_etag(etag)
    if not etag:
        return
    dest_folder = "/".join(dest_key.split("/")[:-1]) + "/" if "/" in dest_key else ""

    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()

        # Idempotency
        cur.execute(
            "SELECT COUNT(*) FROM AWS_FILES WHERE AWS_eTag = ? AND Movement_Sequence = 2",
            (etag,),
        )
        if cur.fetchone()[0] > 0:
            return

        # Read the seq 1 row to copy denorm'd columns onto seq 2
        cur.execute(
            """
            SELECT File_Name, File_Category, File_Size_KB, Record_Count,
                   Attempt_Number, Conversion_Plan_Table_Name, Conversion_Plan_Entity,
                   Validation_Group_ID, WBS_ID, Pillar, Module, Data_Entity,
                   [Source], Business_Unit, Mock_Number,
                   Created_DateTime, Received_DateTime, Processed_DateTime
            FROM AWS_FILES
            WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (etag,),
        )
        seq1 = cur.fetchone()
        if not seq1:
            print(f"  WARNING: seq 1 row missing for eTag {etag[:12]}… skipping seq 2 insert")
            return

        file_url = f"s3://{bucket}/{dest_key}"
        parent_url = f"s3://{bucket}/{dest_folder}"

        cur.execute(
            """
            INSERT INTO AWS_FILES (
                AWS_eTag, Movement_Sequence, File_Name, File_Category,
                File_Size_KB, Record_Count, Attempt_Number,
                Conversion_Plan_Table_Name, Conversion_Plan_Entity,
                Validation_Group_ID, WBS_ID, Pillar, Module, Data_Entity,
                [Source], Business_Unit, Mock_Number,
                S3_Bucket, Parent_Folder, Parent_Folder_URL, File_URL,
                Created_DateTime, Received_DateTime, Processed_DateTime,
                File_Status,
                Check_File_Name, Check_File_Expected, Check_Column_Headers,
                Check_TSQL_File_Found, Check_TSQL_Load,
                Created_By, Last_Updated_By, Last_Updated_DateTime
            ) VALUES (
                ?, 2, ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?,
                ?, ?, ?, ?, ?,
                ?, ?, SYSUTCDATETIME()
            )
            """,
            (
                etag,
                seq1[0], seq1[1],
                seq1[2], seq1[3], seq1[4],
                seq1[5], seq1[6],
                seq1[7], seq1[8], seq1[9], seq1[10], seq1[11],
                seq1[12], seq1[13], seq1[14],
                bucket, dest_folder, parent_url, file_url,
                seq1[15], seq1[16], seq1[17],
                STATUS_TABLE_LOAD_SUCCESS,
                CHECK_NA, CHECK_NA, CHECK_NA, CHECK_NA, CHECK_NA,
                "ap-invoice-processor-lambda", "ap-invoice-processor-lambda",
            ),
        )

        # Update seq 1 to record where the file went
        cur.execute(
            """
            UPDATE AWS_FILES SET
                Moved_To_Folder = ?,
                Last_Updated_DateTime = SYSUTCDATETIME(),
                Last_Updated_By = 'ap-invoice-processor-lambda'
            WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (dest_folder, etag),
        )
        conn.commit()
        print(f"  AWS_FILES seq 2 written for eTag={etag[:12]}… at {dest_folder}")


@_safe
def mark_moved_to_errors(connection_str: str, etag: str, dest_folder: str) -> None:
    """
    When a file fails gate checks or TSQL load, it moves to the Errors folder
    but no seq 2 is created — we just record Moved_To_Folder on the seq 1 row.
    """
    etag = _normalise_etag(etag)
    if not etag:
        return
    # Strip trailing slash inconsistencies
    if dest_folder and "/" in dest_folder and not dest_folder.endswith("/"):
        dest_folder = "/".join(dest_folder.split("/")[:-1]) + "/"
    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE AWS_FILES SET
                Moved_To_Folder = ?,
                Last_Updated_DateTime = SYSUTCDATETIME(),
                Last_Updated_By = 'ap-invoice-processor-lambda'
            WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (dest_folder, etag),
        )
        conn.commit()


@_safe
def write_distribution_row(connection_str: str, *,
                            distribution_etag: str,
                            parent_etag: str,
                            bucket: str,
                            dest_key: str,
                            business_unit: str,
                            actor: str = "distribution-runner") -> Optional[str]:
    """
    Phase 5 — registers a per-BU split file in AWS_FILES.

    Called by the existing distribution script after it splits a parent file
    (Extract, Validation to Source, Conversion Load, Recon Report, or VBL
    Report) into per-BU copies. Each split file gets its own AWS_FILES row
    with Split_From_eTag pointing back at the parent.

    Returns the distribution_etag on success.
    """
    distribution_etag = _normalise_etag(distribution_etag)
    parent_etag = _normalise_etag(parent_etag)
    if not distribution_etag or not parent_etag or not business_unit:
        return None

    filename = dest_key.split("/")[-1]
    parent_folder = "/".join(dest_key.split("/")[:-1]) + "/" if "/" in dest_key else ""
    file_url = f"s3://{bucket}/{dest_key}"
    parent_url = f"s3://{bucket}/{parent_folder}" if parent_folder else f"s3://{bucket}/"

    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()

        # Idempotency: skip if this distribution eTag already tracked
        cur.execute(
            "SELECT COUNT(*) FROM AWS_FILES "
            "WHERE AWS_eTag = ? AND Movement_Sequence = 1",
            (distribution_etag,),
        )
        if cur.fetchone()[0] > 0:
            return distribution_etag

        # Inherit metadata from the parent row so the child carries the same
        # WBS_ID, Validation_Group_ID, VBL_Group_ID, etc.
        cur.execute(
            """
            SELECT File_Category, Conversion_Plan_Table_Name, Conversion_Plan_Entity,
                   Validation_Group_ID, VBL_Group_ID, WBS_ID, Pillar, Module,
                   Data_Entity, [Source], Mock_Number, File_Size_KB, Record_Count
            FROM AWS_FILES
            WHERE AWS_eTag = ? AND Movement_Sequence = 1
            """,
            (parent_etag,),
        )
        parent_row = cur.fetchone()
        if not parent_row:
            print(f"  WARNING: parent eTag {parent_etag[:12]}… not found — "
                  f"distribution row will have minimal metadata")
            parent_row = (None,) * 13

        parent_category = parent_row[0] or "Extract"
        # Phase 2 spec defines this enum exactly
        distribution_category = (
            f"Distribution - {parent_category}"
            if not parent_category.startswith("Distribution")
            else parent_category
        )

        now = datetime.utcnow()
        cur.execute(
            """
            INSERT INTO AWS_FILES (
                AWS_eTag, Movement_Sequence, File_Name, File_Category,
                File_Size_KB, Attempt_Number,
                Conversion_Plan_Table_Name, Conversion_Plan_Entity,
                Validation_Group_ID, VBL_Group_ID, WBS_ID, Pillar, Module,
                Data_Entity, [Source], Business_Unit, Mock_Number,
                S3_Bucket, Parent_Folder, Parent_Folder_URL, File_URL,
                Created_DateTime, Received_DateTime, Processed_DateTime,
                File_Status, Split_From_eTag,
                Check_File_Name, Check_File_Expected, Check_Column_Headers,
                Check_TSQL_File_Found, Check_TSQL_Load,
                Created_By, Last_Updated_By, Last_Updated_DateTime
            ) VALUES (?, 1, ?, ?,
                ?, 1,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                'Distributed', ?,
                'N/A', 'N/A', 'N/A', 'N/A', 'N/A',
                ?, ?, ?)
            """,
            (
                distribution_etag, filename, distribution_category,
                parent_row[11],
                parent_row[1], parent_row[2],
                parent_row[3], parent_row[4], parent_row[5], parent_row[6], parent_row[7],
                parent_row[8], parent_row[9], business_unit, parent_row[10],
                bucket, parent_folder, parent_url, file_url,
                now, now, now,
                parent_etag,
                actor, actor, now,
            ),
        )
        conn.commit()
        print(f"  AWS_FILES distribution row written: eTag={distribution_etag[:12]}… "
              f"BU={business_unit} from parent={parent_etag[:12]}…")
    return distribution_etag


@_safe
def update_business_unit(connection_str: str, etag: str, bu_value: str) -> None:
    """
    Populate Business_Unit on both seq 1 and seq 2 (if present). Called after
    we've parsed the dataframe and extracted BU values.
    """
    etag = _normalise_etag(etag)
    if not etag or not bu_value:
        return
    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE AWS_FILES SET
                Business_Unit = ?,
                Last_Updated_DateTime = SYSUTCDATETIME(),
                Last_Updated_By = 'ap-invoice-processor-lambda'
            WHERE AWS_eTag = ?
            """,
            (bu_value, etag),
        )
        conn.commit()
