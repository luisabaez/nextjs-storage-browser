"""
vbl_group_tracker.py
=====================
Maintains VBL_GROUPS_{MOCK} + VBL_GROUP_MEMBERS_{MOCK} state.

Lifecycle:

  1. on_validation_group_approved(vg_id, mock) — called from
     validation_group_tracker.handle_run_decision when a VG run is approved
     or unrejected. Finds every VBL group that includes this VG, flips the
     member row, recomputes Val_To_Source_Members_Approved, sets
     All_Val_To_Source_Approved = Y when the count matches Total.

  2. When All_Val_To_Source_Approved goes to Y, the VBL Group's
     Latest_VBL_Status is set to 'Pending Trigger'. The existing button-
     driven Conversion Load + Recon Report + VBL Report scripts then run
     and POST back via handle_vbl_run_complete with the three output
     eTags.

  3. Approver runs through /admin/vbl-approvals → handle_vbl_run_decision
     records Approved | Rejected on the VBL group.

  4. After approval, the Conversion Load file is queued for Sterling
     transmission. handle_mark_sterling_sent flips
     Sterling_Transmission_Status on both the VBL_GROUPS row AND the
     Conversion Load AWS_FILES row (per spec — Sterling is a status
     update, NOT a new S3 event).

  5. Distribution: aws_files_writer.write_distribution_row registers the
     per-BU split files. handle_register_distribution_files exposes that
     to the distribution script via a single batch call.
"""
from datetime import datetime
from typing import Optional

import pyodbc


# ─────────────────────────────────────────────────────────────────────────────
# Phase 4 → 5 handoff
# ─────────────────────────────────────────────────────────────────────────────
def on_validation_group_approved(connection_str: str, mock_number: str,
                                  validation_group_id: str,
                                  approver_email: str = "") -> dict:
    """
    Called from validation_group_tracker.handle_run_decision when a VG run
    is Approved. Updates every VBL group that contains this VG.

    Returns a summary that the caller appends to the response body.
    """
    summary = {
        "validation_group_id": validation_group_id,
        "vbl_groups_touched": [],
    }
    vblm_table = f"VBL_GROUP_MEMBERS_{mock_number}"
    vbl_table  = f"VBL_GROUPS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()

            # Per-Mock tables might not exist (older Mock with no VBL config)
            cur.execute(
                "SELECT COUNT(*) FROM sys.tables WHERE name IN (?, ?)",
                (vblm_table, vbl_table),
            )
            if cur.fetchone()[0] < 2:
                return summary

            # Find VBL groups that include this VG
            cur.execute(
                f"""
                SELECT VBL_Group_ID FROM {vblm_table}
                WHERE Validation_Group_ID = ?
                """,
                (validation_group_id,),
            )
            vbl_ids = [row[0] for row in cur.fetchall()]
            if not vbl_ids:
                return summary

            now = datetime.utcnow()

            for vbl_id in vbl_ids:
                # Mark this member approved
                cur.execute(
                    f"""
                    UPDATE {vblm_table} SET
                        Val_To_Source_Latest_Status = 'Approved',
                        Val_To_Source_Approval_Status = 'Approved',
                        Val_To_Source_Approval_DateTime = ?,
                        Blocks_VBL_Trigger = 'N',
                        Last_Updated_By = ?,
                        Last_Updated_DateTime = ?
                    WHERE VBL_Group_ID = ? AND Validation_Group_ID = ?
                    """,
                    (now, approver_email or "vg-approval", now,
                     vbl_id, validation_group_id),
                )

                # Recount approved members for this VBL group
                cur.execute(
                    f"""
                    SELECT
                        SUM(CASE WHEN Required = 'Y' THEN 1 ELSE 0 END) AS total_req,
                        SUM(CASE WHEN Required = 'Y'
                                  AND Val_To_Source_Approval_Status = 'Approved'
                                  THEN 1 ELSE 0 END) AS approved_req
                    FROM {vblm_table}
                    WHERE VBL_Group_ID = ?
                    """,
                    (vbl_id,),
                )
                total_req, approved_req = cur.fetchone()
                total_req    = int(total_req or 0)
                approved_req = int(approved_req or 0)
                all_approved = total_req > 0 and approved_req >= total_req

                cur.execute(
                    f"""
                    UPDATE {vbl_table} SET
                        Val_To_Source_Members_Total = ?,
                        Val_To_Source_Members_Approved = ?,
                        All_Val_To_Source_Approved = ?,
                        Latest_VBL_Status = CASE
                            WHEN ? = 'Y' AND COALESCE(Latest_VBL_Status, '') NOT IN
                                ('Pending Trigger','Running','Pending Approval','Approved','Sent to Oracle')
                            THEN 'Pending Trigger'
                            ELSE Latest_VBL_Status
                        END,
                        Latest_VBL_DateTime = ?,
                        Last_Updated_By = ?,
                        Last_Updated_DateTime = ?
                    WHERE VBL_Group_ID = ?
                    """,
                    (total_req, approved_req,
                     "Y" if all_approved else "N",
                     "Y" if all_approved else "N",
                     now, approver_email or "vg-approval", now, vbl_id),
                )

                summary["vbl_groups_touched"].append({
                    "vbl_group_id": vbl_id,
                    "members_approved": approved_req,
                    "members_total": total_req,
                    "all_approved": all_approved,
                })

            conn.commit()
    except Exception as e:
        import traceback
        traceback.print_exc()
        summary["error"] = str(e)
    return summary


# ─────────────────────────────────────────────────────────────────────────────
# Action handlers — wired into lambda_function.py
# ─────────────────────────────────────────────────────────────────────────────
def handle_list_vbl_groups(connection_str: str, mock_number: str,
                           status_filter: Optional[str] = None) -> dict:
    """List VBL groups + a member summary for the dashboard table."""
    vbl_table  = f"VBL_GROUPS_{mock_number}"
    vblm_table = f"VBL_GROUP_MEMBERS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT COUNT(*) FROM sys.tables WHERE name IN (?, ?)",
                (vbl_table, vblm_table),
            )
            if cur.fetchone()[0] < 2:
                return {"ok": True, "groups": [],
                        "note": f"Per-Mock VBL tables missing for {mock_number}"}

            where = ""
            params = []
            if status_filter:
                where = "WHERE Latest_VBL_Status = ?"
                params = [status_filter]

            cur.execute(
                f"""
                SELECT VBL_Group_ID, VBL_Group_Name, Pillar, Module,
                       Val_To_Source_Members_Total, Val_To_Source_Members_Approved,
                       All_Val_To_Source_Approved,
                       Latest_VBL_Status, Latest_VBL_DateTime,
                       VBL_File_eTag, Recon_File_eTag, Conversion_Load_File_eTag,
                       Sterling_Transmission_Status, Sterling_Transmission_DateTime,
                       Latest_Approval_Status, Latest_Approver,
                       Latest_Approval_DateTime, Latest_Approval_Comments
                FROM {vbl_table}
                {where}
                ORDER BY VBL_Group_ID
                """,
                params,
            )
            cols = [c[0] for c in cur.description]
            groups = [dict(zip(cols, row)) for row in cur.fetchall()]

            # Fetch members for each group in a single query
            cur.execute(
                f"""
                SELECT VBL_Group_ID, Validation_Group_ID, Required,
                       Val_To_Source_Latest_Status,
                       Val_To_Source_Approval_Status,
                       Val_To_Source_Approval_DateTime,
                       Blocks_VBL_Trigger
                FROM {vblm_table}
                ORDER BY VBL_Group_ID, Validation_Group_ID
                """
            )
            mcols = [c[0] for c in cur.description]
            mrows = [dict(zip(mcols, row)) for row in cur.fetchall()]
            members_by_vbl: dict[str, list[dict]] = {}
            for r in mrows:
                members_by_vbl.setdefault(r["VBL_Group_ID"], []).append(r)
            for g in groups:
                g["members"] = members_by_vbl.get(g["VBL_Group_ID"], [])

            return {"ok": True, "groups": groups}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_vbl_run_complete(connection_str: str, mock_number: str,
                            vbl_group_id: str,
                            vbl_file_etag: Optional[str] = None,
                            recon_file_etag: Optional[str] = None,
                            conversion_load_file_etag: Optional[str] = None,
                            actor: str = "") -> dict:
    """
    Called by the existing Conversion Load / Recon / VBL script after it
    generates the three output files and writes their AWS_FILES rows.
    """
    vbl_table = f"VBL_GROUPS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT COUNT(*) FROM {vbl_table} WHERE VBL_Group_ID = ?",
                        (vbl_group_id,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error": f"VBL group {vbl_group_id} not found"}

            now = datetime.utcnow()
            cur.execute(
                f"""
                UPDATE {vbl_table} SET
                    VBL_File_eTag             = COALESCE(?, VBL_File_eTag),
                    Recon_File_eTag           = COALESCE(?, Recon_File_eTag),
                    Conversion_Load_File_eTag = COALESCE(?, Conversion_Load_File_eTag),
                    VBL_Run_Count             = COALESCE(VBL_Run_Count, 0) + 1,
                    Latest_VBL_Status         = 'Pending Approval',
                    Latest_VBL_DateTime       = ?,
                    Last_Updated_By           = ?,
                    Last_Updated_DateTime     = ?
                WHERE VBL_Group_ID = ?
                """,
                (vbl_file_etag, recon_file_etag, conversion_load_file_etag,
                 now, actor or "vbl-runner", now, vbl_group_id),
            )
            conn.commit()
            return {"ok": True, "vbl_group_id": vbl_group_id,
                    "next_status": "Pending Approval"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_vbl_run_decision(connection_str: str, mock_number: str,
                             vbl_group_id: str, decision: str,
                             comments: str = "", actor: str = "") -> dict:
    """
    Approver clicks Approve/Reject for a VBL run.
    On Approved: Latest_VBL_Status -> 'Approved'. Sterling can now be sent.
    On Rejected: Latest_VBL_Status -> 'Rejected'; manual recovery required.
    """
    if decision not in ("Approved", "Rejected"):
        return {"ok": False, "error": "decision must be Approved or Rejected"}

    vbl_table = f"VBL_GROUPS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT COUNT(*) FROM {vbl_table} WHERE VBL_Group_ID = ?",
                        (vbl_group_id,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error": f"VBL group {vbl_group_id} not found"}

            now = datetime.utcnow()
            cur.execute(
                f"""
                UPDATE {vbl_table} SET
                    Latest_VBL_Status        = ?,
                    Latest_Approval_Status   = ?,
                    Latest_Approver          = ?,
                    Latest_Approval_DateTime = ?,
                    Latest_Approval_Comments = ?,
                    Last_Updated_By          = ?,
                    Last_Updated_DateTime    = ?
                WHERE VBL_Group_ID = ?
                """,
                (decision, decision, actor, now, comments,
                 actor, now, vbl_group_id),
            )
            conn.commit()
            return {"ok": True, "vbl_group_id": vbl_group_id, "decision": decision}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_create_vbl_group(connection_str: str, mock_number: str,
                            payload: dict, actor: str = "") -> dict:
    """
    INSERT a new VBL_GROUPS_{MOCK} row + its VBL_GROUP_MEMBERS rows in
    one transaction.

    payload shape:
      {
        "vbl_group_id":   "VBL-FIN-GL",   # required, must not already exist
        "vbl_group_name": "FIN General Ledger — Before Load",  # required
        "pillar":         "FIN",          # required
        "module":         "GL",           # required
        "members": [                      # required, at least one
          { "validation_group_id": "GLBAL-PRIFAS", "required": True },
          { "validation_group_id": "GLBUDG-PRIFAS", "required": False }
        ]
      }

    Validates that:
      - All required string fields are present and non-empty
      - The vbl_group_id is not already in use
      - Every referenced Validation_Group_ID exists in
        VALIDATION_GROUPS_{MOCK}

    Returns {ok: bool, ...} — never raises.
    """
    vbl_table  = f"VBL_GROUPS_{mock_number}"
    vblm_table = f"VBL_GROUP_MEMBERS_{mock_number}"
    vg_table   = f"VALIDATION_GROUPS_{mock_number}"

    vbl_id   = (payload.get("vbl_group_id") or "").strip()
    vbl_name = (payload.get("vbl_group_name") or "").strip()
    pillar   = (payload.get("pillar") or "").strip()
    module   = (payload.get("module") or "").strip()
    members  = payload.get("members") or []

    missing = []
    if not vbl_id:   missing.append("vbl_group_id")
    if not vbl_name: missing.append("vbl_group_name")
    if not pillar:   missing.append("pillar")
    if not module:   missing.append("module")
    if not members:  missing.append("members (at least one)")
    if missing:
        return {"ok": False, "error": f"Missing required fields: {', '.join(missing)}"}

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            # Tables present?
            cur.execute(
                "SELECT COUNT(*) FROM sys.tables WHERE name IN (?, ?, ?)",
                (vbl_table, vblm_table, vg_table),
            )
            if cur.fetchone()[0] < 3:
                return {"ok": False, "error":
                        f"Per-Mock tables missing for {mock_number} "
                        f"(need {vbl_table}, {vblm_table}, {vg_table})"}

            # VBL_Group_ID unique?
            cur.execute(f"SELECT COUNT(*) FROM {vbl_table} WHERE VBL_Group_ID = ?", (vbl_id,))
            if cur.fetchone()[0] > 0:
                return {"ok": False, "error":
                        f"VBL group '{vbl_id}' already exists in {vbl_table}"}

            # Validate member VG IDs exist
            requested_vgs = [(m.get("validation_group_id") or "").strip() for m in members]
            requested_vgs = [v for v in requested_vgs if v]
            if not requested_vgs:
                return {"ok": False, "error": "No valid member validation_group_id values supplied"}

            placeholders = ",".join(["?"] * len(requested_vgs))
            cur.execute(
                f"SELECT Validation_Group_ID FROM {vg_table} "
                f"WHERE Validation_Group_ID IN ({placeholders})",
                requested_vgs,
            )
            existing_vgs = {row[0] for row in cur.fetchall()}
            missing_vgs = [v for v in requested_vgs if v not in existing_vgs]
            if missing_vgs:
                return {"ok": False, "error":
                        f"These Validation Groups don't exist in {vg_table}: "
                        f"{', '.join(missing_vgs)}"}

            required_count = sum(1 for m in members
                                 if m.get("required") in (True, "Y", "y", "true", "1"))
            now = datetime.utcnow()

            # 1. VBL_GROUPS row
            cur.execute(
                f"""
                INSERT INTO {vbl_table}
                (VBL_Group_ID, VBL_Group_Name, Mock_Number, Pillar, Module,
                 Val_To_Source_Members_Total, Val_To_Source_Members_Approved,
                 All_Val_To_Source_Approved,
                 VBL_Run_Count,
                 Last_Updated_By, Last_Updated_DateTime, Notes)
                VALUES (?, ?, ?, ?, ?, ?, 0, 'N', 0, ?, ?, ?)
                """,
                (vbl_id, vbl_name, mock_number, pillar.upper(), module.upper(),
                 required_count,
                 actor or "vbl_create_ui", now,
                 f"Created via dashboard by {actor or 'unknown'} at {now.isoformat()}Z"),
            )

            # 2. VBL_GROUP_MEMBERS rows
            inserted_members = 0
            for m in members:
                vg = (m.get("validation_group_id") or "").strip()
                if not vg:
                    continue
                required = "Y" if m.get("required") in (True, "Y", "y", "true", "1") else "N"
                cur.execute(
                    f"""
                    INSERT INTO {vblm_table}
                    (VBL_Group_ID, Validation_Group_ID, Required,
                     Blocks_VBL_Trigger, Last_Updated_By, Last_Updated_DateTime)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (vbl_id, vg, required,
                     "Y" if required == "Y" else "N",
                     actor or "vbl_create_ui", now),
                )
                inserted_members += 1

            conn.commit()
            return {
                "ok": True,
                "vbl_group_id": vbl_id,
                "members_inserted": inserted_members,
                "members_required": required_count,
            }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


def handle_update_vbl_members(connection_str: str, mock_number: str,
                              vbl_group_id: str, members: list,
                              actor: str = "") -> dict:
    """
    Replace the entire member list for a VBL group. DELETE then INSERT in
    one transaction, then recompute Val_To_Source_Members_Total +
    Val_To_Source_Members_Approved on the VBL_GROUPS row.

    Safe to call repeatedly. Doesn't touch the VBL group's run state.
    """
    vbl_table  = f"VBL_GROUPS_{mock_number}"
    vblm_table = f"VBL_GROUP_MEMBERS_{mock_number}"
    vg_table   = f"VALIDATION_GROUPS_{mock_number}"

    if not vbl_group_id:
        return {"ok": False, "error": "vbl_group_id required"}
    if not members:
        return {"ok": False, "error": "members list cannot be empty"}

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT COUNT(*) FROM {vbl_table} WHERE VBL_Group_ID = ?",
                        (vbl_group_id,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error":
                        f"VBL group '{vbl_group_id}' not found in {vbl_table}"}

            # Validate member VG IDs exist
            requested_vgs = [(m.get("validation_group_id") or "").strip() for m in members]
            requested_vgs = [v for v in requested_vgs if v]
            placeholders = ",".join(["?"] * len(requested_vgs))
            cur.execute(
                f"SELECT Validation_Group_ID FROM {vg_table} "
                f"WHERE Validation_Group_ID IN ({placeholders})",
                requested_vgs,
            )
            existing_vgs = {row[0] for row in cur.fetchall()}
            missing_vgs = [v for v in requested_vgs if v not in existing_vgs]
            if missing_vgs:
                return {"ok": False, "error":
                        f"These Validation Groups don't exist: {', '.join(missing_vgs)}"}

            now = datetime.utcnow()
            cur.execute(f"DELETE FROM {vblm_table} WHERE VBL_Group_ID = ?",
                        (vbl_group_id,))
            deleted = cur.rowcount

            inserted = 0
            approved_required = 0
            for m in members:
                vg = (m.get("validation_group_id") or "").strip()
                if not vg:
                    continue
                required = "Y" if m.get("required") in (True, "Y", "y", "true", "1") else "N"
                # Carry forward the current approval status if the user is
                # editing an existing membership.
                # For now we re-init to NULL — the next VG approval will set it.
                cur.execute(
                    f"""
                    INSERT INTO {vblm_table}
                    (VBL_Group_ID, Validation_Group_ID, Required,
                     Blocks_VBL_Trigger, Last_Updated_By, Last_Updated_DateTime)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (vbl_group_id, vg, required,
                     "Y" if required == "Y" else "N",
                     actor or "vbl_edit_ui", now),
                )
                inserted += 1
                if required == "Y":
                    approved_required += 1

            # Recompute total on the parent row
            cur.execute(
                f"""
                UPDATE {vbl_table} SET
                    Val_To_Source_Members_Total = ?,
                    Val_To_Source_Members_Approved = 0,
                    All_Val_To_Source_Approved = 'N',
                    Last_Updated_By = ?,
                    Last_Updated_DateTime = ?
                WHERE VBL_Group_ID = ?
                """,
                (approved_required, actor or "vbl_edit_ui", now, vbl_group_id),
            )
            conn.commit()
            return {
                "ok": True,
                "vbl_group_id": vbl_group_id,
                "deleted": deleted,
                "inserted": inserted,
                "required_total": approved_required,
            }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


def handle_update_vbl_group(connection_str: str, mock_number: str,
                             vbl_group_id: str, updates: dict,
                             actor: str = "") -> dict:
    """
    Update metadata fields on a VBL group row. Whitelist-guarded — only the
    fields here can be touched via this endpoint:
        VBL_Group_Name, Notes
    Pillar / Module are derived from VBL_Group_ID and stay frozen; renaming
    a VBL ID is intentionally not supported because eTag references in
    AWS_FILES, VBL_GROUP_MEMBERS, and live runs would dangle.
    """
    vbl_table = f"VBL_GROUPS_{mock_number}"
    editable = {"VBL_Group_Name", "Notes"}
    safe = {k: v for k, v in (updates or {}).items() if k in editable}
    if not safe:
        return {"ok": False, "error": "No editable fields supplied"}

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT COUNT(*) FROM {vbl_table} WHERE VBL_Group_ID = ?",
                        (vbl_group_id,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error":
                        f"VBL group '{vbl_group_id}' not found"}

            now = datetime.utcnow()
            sets = []
            args: list = []
            for k, v in safe.items():
                sets.append(f"[{k}] = ?")
                args.append(v if v != "" else None)
            sets.append("Last_Updated_By = ?")
            args.append(actor or "vbl_edit_ui")
            sets.append("Last_Updated_DateTime = ?")
            args.append(now)

            cur.execute(
                f"UPDATE {vbl_table} SET {', '.join(sets)} WHERE VBL_Group_ID = ?",
                (*args, vbl_group_id),
            )
            conn.commit()
            return {"ok": True, "rows_updated": cur.rowcount,
                    "updated_fields": list(safe.keys())}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


def handle_delete_vbl_group(connection_str: str, mock_number: str,
                             vbl_group_id: str, actor: str = "") -> dict:
    """
    Delete a VBL group: removes all VBL_GROUP_MEMBERS rows first, then the
    parent VBL_GROUPS row. AWS_FILES rows are never touched (they're a
    global event log and may still be needed for audit).

    A warning summary is returned alongside the deletion result so the UI
    can surface what was cascaded.
    """
    vbl_table  = f"VBL_GROUPS_{mock_number}"
    vblm_table = f"VBL_GROUP_MEMBERS_{mock_number}"

    if not vbl_group_id:
        return {"ok": False, "error": "vbl_group_id required"}

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(
                f"""
                SELECT VBL_Group_Name, Pillar, Module,
                       Latest_VBL_Status, Latest_Approval_Status,
                       Sterling_Transmission_Status,
                       VBL_File_eTag, Recon_File_eTag, Conversion_Load_File_eTag
                FROM {vbl_table}
                WHERE VBL_Group_ID = ?
                """,
                (vbl_group_id,),
            )
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error":
                        f"VBL group '{vbl_group_id}' not found"}
            cols = [c[0] for c in cur.description]
            preview = dict(zip(cols, row))

            cur.execute(
                f"SELECT COUNT(*) FROM {vblm_table} WHERE VBL_Group_ID = ?",
                (vbl_group_id,),
            )
            member_count = cur.fetchone()[0]

            cur.execute(
                f"DELETE FROM {vblm_table} WHERE VBL_Group_ID = ?",
                (vbl_group_id,),
            )
            members_deleted = cur.rowcount

            cur.execute(
                f"DELETE FROM {vbl_table} WHERE VBL_Group_ID = ?",
                (vbl_group_id,),
            )
            parent_deleted = cur.rowcount
            conn.commit()

            return {
                "ok": True,
                "vbl_group_id": vbl_group_id,
                "members_deleted": members_deleted,
                "parent_deleted": parent_deleted,
                "deleted_preview": preview,
                "actor": actor or "vbl_delete_ui",
            }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


def handle_mark_sterling_sent(connection_str: str, mock_number: str,
                               vbl_group_id: str,
                               sterling_status: str = "Submitted",
                               actor: str = "",
                               error_notes: str = "") -> dict:
    """
    Per spec: Sterling is NOT a new S3 event. We update:
      1. VBL_GROUPS.Sterling_Transmission_Status + DateTime
      2. The Conversion Load AWS_FILES row pointed at by Conversion_Load_File_eTag

    sterling_status enum: 'Submitted' | 'Error'
    """
    if sterling_status not in ("Submitted", "Error", "Not Submitted"):
        return {"ok": False, "error":
                "sterling_status must be Submitted, Error, or Not Submitted"}

    vbl_table = f"VBL_GROUPS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT Conversion_Load_File_eTag, Latest_Approval_Status "
                f"FROM {vbl_table} WHERE VBL_Group_ID = ?",
                (vbl_group_id,),
            )
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": f"VBL group {vbl_group_id} not found"}
            cl_etag, approval_status = row
            if approval_status != "Approved" and sterling_status == "Submitted":
                return {"ok": False, "error":
                        f"Cannot mark Sterling sent — VBL group is "
                        f"{approval_status or 'not yet approved'}"}

            now = datetime.utcnow()
            # 1. VBL group row
            cur.execute(
                f"""
                UPDATE {vbl_table} SET
                    Sterling_Transmission_Status   = ?,
                    Sterling_Transmission_DateTime = ?,
                    Latest_VBL_Status              = CASE
                        WHEN ? = 'Submitted' THEN 'Sent to Oracle' ELSE Latest_VBL_Status
                    END,
                    Last_Updated_By                = ?,
                    Last_Updated_DateTime          = ?
                WHERE VBL_Group_ID = ?
                """,
                (sterling_status, now, sterling_status,
                 actor, now, vbl_group_id),
            )

            updated_aws = False
            if cl_etag:
                # 2. AWS_FILES row for the Conversion Load file
                cur.execute(
                    """
                    UPDATE AWS_FILES SET
                        Sterling_Transmission_Status   = ?,
                        Sterling_Transmission_DateTime = ?,
                        Sterling_Error_Notes           = NULLIF(?, ''),
                        File_Status = CASE
                            WHEN ? = 'Submitted' THEN 'Sent to Oracle' ELSE File_Status
                        END,
                        Last_Updated_By                = ?,
                        Last_Updated_DateTime          = ?
                    WHERE AWS_eTag = ?
                    """,
                    (sterling_status, now, error_notes or "",
                     sterling_status, actor, now, cl_etag),
                )
                updated_aws = cur.rowcount > 0

            conn.commit()
            return {
                "ok": True,
                "vbl_group_id": vbl_group_id,
                "sterling_status": sterling_status,
                "conversion_load_etag": cl_etag,
                "aws_files_updated": updated_aws,
            }
    except Exception as e:
        return {"ok": False, "error": str(e)}
