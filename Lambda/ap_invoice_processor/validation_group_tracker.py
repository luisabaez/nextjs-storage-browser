"""
validation_group_tracker.py
============================
Maintains VALIDATION_GROUPS_{MOCK} and VALIDATION_RUNS_{MOCK} state.

After every successful Table Load, on_table_load_success is called from
lambda_function.py. The flow:

  1. Resolve which Validation_Group_ID this file belongs to
       (entity_code from naming convention + source).
  2. Recompute Members_Currently_Loaded for that group by counting
       distinct Table Load Success rows in AWS_FILES against the group's
       member tables.
  3. If all members loaded AND all cross-group dependencies satisfied
       (vg_dependencies_check), INSERT a VALIDATION_RUNS row with
       Run_Status = 'Pending Trigger'. The existing button-driven
       validation script then picks it up, executes, and POSTs results
       back via ?action=validation_run_complete.

Trigger reasons:
  Initial Load — first time the group reached all-loaded
  Re-upload    — re-validation after a member was re-uploaded
  Manual       — operator pressed the manual-trigger button

Approval lifecycle handled in lambda_function.py:
  Pending Approval → Approved | Rejected
  Reject with Reextract_Required = Y flips File_Expected = Y on the
  Affected_Members of SETUP_CONVERSION_PLAN_{MOCK} (via
  conversion_plan_tracker.handle_reset_file_expected).
"""

from datetime import datetime
from typing import Optional

import pyodbc

# Per Schema Reference: VG ID = {ENTITY_CODE}-{SOURCE}.
# Maps entity_prefix (from parse_filename) → entity_code (the VG ID prefix).
# Source comes straight from parsed['source'].
ENTITY_PREFIX_TO_VG_CODE = {
    # FIN AP — all three legacy AP entities live under the same VG
    "FIN_AP_INVOICE_HDR":       "APINV",
    "FIN_AP_INVOICE_LINES":     "APINV",
    "FIN_AP_INVOICE_LINES_DTL1": "APINV",
    "FIN_AP_INVOICE":           "APINV",
    # SCM
    "SCM_SUPPLIER":             "SUP",
    "SCM_SUPPLIER_SITE":        "SUP",
    "SCM_PURCHASE_ORDER":       "PO",
    "SCM_BLANKET_PURCHASE_AGREEMENT": "BPA",
    "SCM_REQUISITION":          "REQ",
    "SCM_PROCUREMENT_CONTRACT": "PROCONT",
    "SCM_CONTRACT":             "CONT",
    # HCM contracts
    "HCM_CONTRACT":             "CONT",
}


def resolve_validation_group_id(entity_prefix: str, source: str) -> Optional[str]:
    """
    Best-effort lookup of {ENTITY_CODE}-{SOURCE}. Returns None for entities
    we haven't mapped (HCM person tables, GL tables, etc.) — those don't
    participate in the validation-group flow yet.
    """
    code = ENTITY_PREFIX_TO_VG_CODE.get((entity_prefix or "").upper())
    src = (source or "").upper()
    if not code or not src:
        return None
    return f"{code}-{src}"


def _vg_exists(cur, table: str, vg_id: str) -> bool:
    cur.execute(f"SELECT COUNT(*) FROM {table} WHERE Validation_Group_ID = ?", (vg_id,))
    return cur.fetchone()[0] > 0


def _recompute_member_count(cur, mock_number: str, vg_id: str,
                            data_entity: str, source: str) -> int:
    """
    Count of distinct active AWS_FILES rows with File_Status=Table Load Success
    for the (Conversion_Plan_Entity, Source) pair this VG owns.
    """
    cur.execute(
        """
        SELECT COUNT(DISTINCT Conversion_Plan_Table_Name)
        FROM AWS_FILES
        WHERE Mock_Number = ?
          AND Movement_Sequence = 1
          AND File_Status = 'Table Load Success'
          AND Superseded_By_eTag IS NULL
          AND (Validation_Group_ID = ? OR
               (Conversion_Plan_Entity = ? AND [Source] = ?))
        """,
        (mock_number, vg_id, data_entity, source),
    )
    return cur.fetchone()[0] or 0


def _next_run_id(cur, mock_number: str) -> str:
    """Sequential VAL-NNNN per Mock."""
    cur.execute(
        f"SELECT TOP 1 Validation_Run_ID FROM VALIDATION_RUNS_{mock_number} "
        f"ORDER BY Validation_Run_ID DESC"
    )
    last = cur.fetchone()
    if not last or not last[0]:
        return "VAL-0001"
    try:
        n = int(str(last[0]).split("-")[-1])
        return f"VAL-{n + 1:04d}"
    except (ValueError, IndexError):
        return "VAL-0001"


def _next_run_number_for_group(cur, mock_number: str, vg_id: str) -> int:
    cur.execute(
        f"SELECT COUNT(*) FROM VALIDATION_RUNS_{mock_number} "
        f"WHERE Validation_Group_ID = ?",
        (vg_id,),
    )
    return (cur.fetchone()[0] or 0) + 1


def on_table_load_success(connection_str: str, mock_number: str, parsed: dict,
                          etag: str) -> dict:
    """
    Main entry point. Idempotent — safe to call after every successful load.
    Returns a summary dict for the Lambda logs.
    """
    summary = {
        "validation_group_id": None,
        "members_total": None,
        "members_currently_loaded": None,
        "all_members_loaded": False,
        "dependencies_satisfied": False,
        "run_created": None,
        "trigger_reason": None,
        "skipped_reason": None,
    }

    try:
        vg_id = resolve_validation_group_id(
            parsed.get("entity_prefix", ""), parsed.get("source", "")
        )
        summary["validation_group_id"] = vg_id
        if not vg_id:
            summary["skipped_reason"] = "no_vg_mapping_for_entity"
            return summary

        if not mock_number:
            summary["skipped_reason"] = "no_mock_number"
            return summary

        vg_table  = f"VALIDATION_GROUPS_{mock_number}"
        run_table = f"VALIDATION_RUNS_{mock_number}"

        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            # If the per-Mock tables aren't provisioned, skip silently
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name IN (?, ?)",
                        (vg_table, run_table))
            if cur.fetchone()[0] < 2:
                summary["skipped_reason"] = "per_mock_tables_missing"
                return summary

            # If the VG row doesn't exist (entity outside the spec's seeded
            # groups), skip silently — onboarding will add it later.
            if not _vg_exists(cur, vg_table, vg_id):
                summary["skipped_reason"] = f"vg_not_seeded:{vg_id}"
                return summary

            # Recompute Members_Currently_Loaded
            new_count = _recompute_member_count(
                cur, mock_number, vg_id,
                parsed.get("entity_display") or parsed.get("entity_prefix") or "",
                parsed.get("source", "") or "",
            )

            cur.execute(
                f"""
                UPDATE {vg_table} SET
                    Members_Currently_Loaded = ?,
                    All_Members_Loaded = CASE
                        WHEN Members_Total IS NOT NULL AND Members_Total > 0
                             AND ? >= Members_Total THEN 'Y' ELSE 'N'
                    END,
                    Revalidation_Triggered_By_eTag = ?,
                    Latest_Validation_DateTime = SYSUTCDATETIME(),
                    Last_Updated_By = 'validation_group_tracker',
                    Last_Updated_DateTime = SYSUTCDATETIME()
                WHERE Validation_Group_ID = ?
                """,
                (new_count, new_count, etag, vg_id),
            )
            conn.commit()

            cur.execute(
                f"SELECT Members_Total, Members_Currently_Loaded, All_Members_Loaded "
                f"FROM {vg_table} WHERE Validation_Group_ID = ?",
                (vg_id,),
            )
            total, loaded, all_loaded = cur.fetchone()
            summary["members_total"] = total
            summary["members_currently_loaded"] = loaded
            summary["all_members_loaded"] = (all_loaded == "Y")

            if all_loaded != "Y":
                return summary

            # Members are all loaded — check dependencies
            from vg_dependencies_check import all_dependencies_satisfied
            deps_ok = all_dependencies_satisfied(connection_str, mock_number, vg_id)
            summary["dependencies_satisfied"] = deps_ok
            if not deps_ok:
                return summary

            # Decide trigger reason: prior approved runs → Re-upload, else Initial Load
            cur.execute(
                f"SELECT COUNT(*) FROM {run_table} WHERE Validation_Group_ID = ? "
                f"AND Approval_Status = 'Approved'",
                (vg_id,),
            )
            had_prior_approval = (cur.fetchone()[0] or 0) > 0
            trigger_reason = "Re-upload" if had_prior_approval else "Initial Load"

            # Skip if there's already a Pending/Running run for this group
            cur.execute(
                f"SELECT TOP 1 Validation_Run_ID FROM {run_table} "
                f"WHERE Validation_Group_ID = ? "
                f"AND Run_Status IN ('Pending Trigger','Running','Pending Approval') "
                f"ORDER BY Run_Start_DateTime DESC",
                (vg_id,),
            )
            existing = cur.fetchone()
            if existing:
                summary["skipped_reason"] = f"run_already_active:{existing[0]}"
                return summary

            # Create a new run
            run_id = _next_run_id(cur, mock_number)
            run_number = _next_run_number_for_group(cur, mock_number, vg_id)
            now = datetime.utcnow()

            cur.execute(
                f"""
                INSERT INTO {run_table}
                (Validation_Run_ID, Validation_Group_ID, Mock_Number, Run_Number,
                 Trigger_Reason, Triggered_By_eTag, Run_Status,
                 Run_Start_DateTime,
                 Last_Updated_By, Last_Updated_DateTime)
                VALUES (?, ?, ?, ?, ?, ?, 'Pending Trigger', ?, 'validation_group_tracker', ?)
                """,
                (run_id, vg_id, mock_number, run_number, trigger_reason, etag, now, now),
            )
            cur.execute(
                f"""
                UPDATE {vg_table} SET
                    Current_Validation_Run_ID = ?,
                    Validation_Run_Count = COALESCE(Validation_Run_Count, 0) + 1,
                    Latest_Validation_Status = 'Pending Trigger',
                    Last_Updated_DateTime = SYSUTCDATETIME()
                WHERE Validation_Group_ID = ?
                """,
                (run_id, vg_id),
            )
            conn.commit()

            summary["run_created"] = run_id
            summary["trigger_reason"] = trigger_reason
            print(f"  Validation run {run_id} ({trigger_reason}) "
                  f"created for {vg_id} in {mock_number}")
    except Exception as e:
        import traceback
        print(f"  WARNING: validation_group_tracker.on_table_load_success failed: {e}")
        traceback.print_exc()
        summary["skipped_reason"] = f"exception:{e}"
    return summary


# ─────────────────────────────────────────────────────────────────────────────
# Run lifecycle entry points (called from lambda_function.py action handlers)
# ─────────────────────────────────────────────────────────────────────────────
def handle_list_runs(connection_str: str, mock_number: str,
                     status_filter: Optional[str] = None) -> dict:
    """List VALIDATION_RUNS rows. Default: only Pending Approval + Pending Trigger + Running."""
    run_table = f"VALIDATION_RUNS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (run_table,))
            if cur.fetchone()[0] == 0:
                return {"ok": True, "runs": [], "note": f"{run_table} does not exist"}

            where = ""
            params = []
            if status_filter:
                where = "WHERE Run_Status = ?"
                params = [status_filter]
            else:
                where = "WHERE Run_Status IN ('Pending Trigger','Running','Pending Approval')"

            cur.execute(
                f"""
                SELECT Validation_Run_ID, Validation_Group_ID, Run_Number,
                       Trigger_Reason, Run_Status,
                       Error_Count, Warning_Count, Informative_Record_Count,
                       Threshold_Exceeded, Reextract_Required,
                       Affected_Members, Run_Start_DateTime, Run_End_DateTime,
                       Approval_Status, Approver_Email, Approval_DateTime
                FROM {run_table}
                {where}
                ORDER BY Run_Start_DateTime DESC
                """,
                params,
            )
            cols = [c[0] for c in cur.description]
            runs = [dict(zip(cols, row)) for row in cur.fetchall()]
            return {"ok": True, "runs": runs}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_run_complete(connection_str: str, mock_number: str, run_id: str,
                        error_count: int = 0, warning_count: int = 0,
                        informative_count: int = 0,
                        validation_file_etag: Optional[str] = None,
                        actor: str = "") -> dict:
    """
    Called by the validation script when a run finishes. Sets
    Run_Status='Pending Approval', captures counts + the output file eTag,
    flags Threshold_Exceeded if error_count > group's Error_Threshold.
    """
    run_table = f"VALIDATION_RUNS_{mock_number}"
    vg_table  = f"VALIDATION_GROUPS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT Validation_Group_ID FROM {run_table} WHERE Validation_Run_ID = ?",
                (run_id,),
            )
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": f"Run {run_id} not found"}
            vg_id = row[0]

            cur.execute(
                f"SELECT Error_Threshold FROM {vg_table} WHERE Validation_Group_ID = ?",
                (vg_id,),
            )
            threshold_row = cur.fetchone()
            threshold = (threshold_row[0] if threshold_row else 0) or 0
            threshold_exceeded = "Y" if error_count > threshold else "N"

            now = datetime.utcnow()
            cur.execute(
                f"""
                UPDATE {run_table} SET
                    Run_Status = 'Pending Approval',
                    Error_Count = ?, Warning_Count = ?, Informative_Record_Count = ?,
                    Threshold_Exceeded = ?,
                    Validation_File_eTag = COALESCE(?, Validation_File_eTag),
                    Run_End_DateTime = ?,
                    Last_Updated_By = ?,
                    Last_Updated_DateTime = ?
                WHERE Validation_Run_ID = ?
                """,
                (error_count, warning_count, informative_count, threshold_exceeded,
                 validation_file_etag, now, actor or "validation-runner", now, run_id),
            )
            cur.execute(
                f"""
                UPDATE {vg_table} SET
                    Latest_Validation_Status = 'Pending Approval',
                    Latest_Validation_DateTime = ?,
                    Threshold_Exceeded = ?,
                    Last_Updated_By = ?,
                    Last_Updated_DateTime = ?
                WHERE Validation_Group_ID = ?
                """,
                (now, threshold_exceeded,
                 actor or "validation-runner", now, vg_id),
            )
            conn.commit()
            return {"ok": True, "run_id": run_id, "vg_id": vg_id,
                    "threshold_exceeded": threshold_exceeded,
                    "next_status": "Pending Approval"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_run_decision(connection_str: str, mock_number: str, run_id: str,
                        decision: str, comments: str = "",
                        reextract_required: bool = False,
                        affected_members: str = "",
                        actor: str = "") -> dict:
    """
    Approver clicks Approve or Reject in the dashboard.
    decision in {'Approved','Rejected'}.
    If Rejected + reextract_required=True, flips File_Expected=Y on the
    Affected_Members via conversion_plan_tracker.handle_reset_file_expected.
    """
    if decision not in ("Approved", "Rejected"):
        return {"ok": False, "error": "decision must be Approved or Rejected"}

    run_table = f"VALIDATION_RUNS_{mock_number}"
    vg_table  = f"VALIDATION_GROUPS_{mock_number}"

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT Validation_Group_ID, Run_Status FROM {run_table} "
                f"WHERE Validation_Run_ID = ?",
                (run_id,),
            )
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": f"Run {run_id} not found"}
            vg_id, current_status = row
            if current_status not in ("Pending Approval", "Pending Trigger", "Running"):
                return {"ok": False, "error": f"Cannot decide a run in status '{current_status}'"}

            now = datetime.utcnow()
            cur.execute(
                f"""
                UPDATE {run_table} SET
                    Run_Status = ?,
                    Approval_Status = ?,
                    Approver_Email = ?,
                    Approval_DateTime = ?,
                    Approval_Comments = ?,
                    Reextract_Required = ?,
                    Affected_Members = ?,
                    Last_Updated_By = ?,
                    Last_Updated_DateTime = ?
                WHERE Validation_Run_ID = ?
                """,
                (decision, decision, actor, now, comments,
                 "Y" if reextract_required else "N",
                 affected_members or None,
                 actor, now, run_id),
            )
            cur.execute(
                f"""
                UPDATE {vg_table} SET
                    Latest_Approval_Status = ?,
                    Latest_Approver = ?,
                    Latest_Approval_DateTime = ?,
                    Latest_Approval_Comments = ?,
                    Reextract_Required = ?,
                    Last_Updated_By = ?,
                    Last_Updated_DateTime = ?
                WHERE Validation_Group_ID = ?
                """,
                (decision, actor, now, comments,
                 "Y" if reextract_required else "N",
                 actor, now, vg_id),
            )
            conn.commit()

            # If rejected with reextract, flip File_Expected on affected entities
            reset_results = []
            if decision == "Rejected" and reextract_required and affected_members:
                from conversion_plan_tracker import handle_reset_file_expected
                for member in [m.strip() for m in affected_members.split(";") if m.strip()]:
                    # affected_members is a list of Table_Names — translate to entity/source
                    # by querying SETUP_CONVERSION_PLAN_{MOCK}
                    cur.execute(
                        f"SELECT TOP 1 Entity, [SOURCE] FROM SETUP_CONVERSION_PLAN_{mock_number} "
                        f"WHERE Table_Name = ?",
                        (member,),
                    )
                    es = cur.fetchone()
                    if es:
                        entity, source = es
                        r = handle_reset_file_expected(
                            connection_str=connection_str,
                            mock_number=mock_number,
                            entity=entity, source=source,
                            reason=f"Auto-reset from run {run_id} rejection: {comments}",
                            actor=actor or "validation-decision",
                        )
                        reset_results.append({"member": member, **r})

            return {
                "ok": True, "run_id": run_id, "vg_id": vg_id,
                "decision": decision,
                "reextract_required": reextract_required,
                "affected_members": affected_members,
                "file_expected_resets": reset_results,
            }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}
