# ERP Migration Tracking System — Implementation Plan v1

> Source documents: `Full Specification for Development.docx`, `Database_Schema_v9.xlsx`
> Drafted: 2026-06-03

---

## 1. Goal

Instrument the existing file-processing pipeline so every file event — upload, move, gate check, table load, validation, approval, conversion, Sterling transmission, BU distribution — writes a row to a SQL Server tracking schema. The dashboard surfaces that schema as a live, filterable Gantt + drill-down view. AWS S3 tags are too limited (10 tags × 256 chars); the database becomes the system of record for everything S3 can't natively hold.

The existing automation scripts (gate checks, TSQL load, validation runners, conversion-load generators) **continue to do the work**. Our additions wrap each step with tracking writes; we do not rewrite the script bodies.

## 2. Decisions Already Captured

| Topic | Decision |
|---|---|
| New-Mock population | Admin clicks **"Promote to Mock N+1"** button; previews a diff before confirming |
| AWS_FILES table | **Single global table** (eTags are globally unique; cross-Mock queries are trivial) |
| Build scope | Tracking + monitoring of existing scripts. Validation/conversion logic untouched. |
| Versioning trigger | Any **new eTag for same entity** auto-supersedes the prior eTag but tracks previous file and supersedes file |
| Version file retention | Previous file is **never deleted** on supersede — it stays in its current S3 location. Both `AWS_FILES` rows keep their own `File_URL`, so the client can open either version for comparison. |

## 3. Architecture in One Picture

```
S3 PUT / move event
        │
        ▼
┌──────────────────────────────────────────┐
│  AP-Invoice-Processor Lambda (existing)  │   ← instrumented to write tracking rows
│  ┌──────────────────────────────────────┐│
│  │ 1. Parse filename → resolve entity   ││─→ AWS_FILES seq 1 (Received)
│  │ 2. Gate checks 1-5                   ││─→ AWS_FILES Check_* columns
│  │ 3. TSQL load                         ││─→ AWS_FILES seq 2 (move to ConversionFiles)
│  │ 4. Update Validation Group counts    ││─→ VALIDATION_GROUPS.Members_Currently_Loaded++
│  │ 5. Check VG_DEPENDENCIES             ││─→ VALIDATION_RUNS row if all conditions met
│  │ 6. Notify validation runner script   ││
│  └──────────────────────────────────────┘│
└──────────────────────────────────────────┘
        │
        ▼ (rows written)
┌──────────────────────────────────────────┐
│        SQL Server (Hacienda_ERP_Test)     │
│   SETUP_CONVERSION_PLAN_MOCK{N}  (92 col) │
│   AWS_FILES                       (45 col)│
│   VALIDATION_GROUPS                       │
│   VALIDATION_RUNS                         │
│   VBL_GROUPS                              │
│   VBL_GROUP_MEMBERS                       │
│   VG_DEPENDENCIES                         │
│   SCHEMA_REFERENCE                        │
└──────────────────────────────────────────┘
        │
        ▼ (read-only)
┌──────────────────────────────────────────┐
│       Next.js Dashboard (existing)        │
│   Gantt View    — overall stage per entity│
│   Hierarchy     — Pillar→Module→Entity    │
│   AWS Files     — event log (NEW)         │
│   Val Groups    — group state (NEW)       │
│   Val Runs      — run history (NEW)       │
│   VBL Groups    — VBL state (NEW)         │
│   File Detail   — version chain, lineage  │
│   Approvals     — VG + VBL approver UI    │
└──────────────────────────────────────────┘
```

## 4. Phased Plan

Six phases. Each ends with a verifiable artifact and a demo. No phase starts until the previous is signed off.

### Phase 1 — Database schema (~1.5 weeks)

**What:** Create the seven new tables; extend `SETUP_CONVERSION_PLAN_MOCK{N}` from 62 → 92 columns to match the spec; build the "Promote to Mock N+1" admin tool.

**Tables to create:**

| Table | Notes |
|---|---|
| `AWS_FILES` | Single global table. Composite PK (`AWS_eTag`, `Movement_Sequence`). All 45 columns. FK to `SETUP_CONVERSION_PLAN_MOCK{N}` via `WBS_ID` + `Mock_Number`. |
| `VALIDATION_GROUPS_MOCK{N}` | Per-Mock. PK `Validation_Group_ID`. |
| `VALIDATION_RUNS_MOCK{N}` | Per-Mock. PK `Validation_Run_ID` (`VAL-NNNN`). FK to `VALIDATION_GROUPS`. |
| `VBL_GROUPS_MOCK{N}` | Per-Mock. PK `VBL_Group_ID` (`VBL-{PILLAR}-{MODULE}`). |
| `VBL_GROUP_MEMBERS_MOCK{N}` | Per-Mock. Composite PK (`VBL_Group_ID`, `Validation_Group_ID`). |
| `VG_DEPENDENCIES_MOCK{N}` | Per-Mock. PK `Dependency_ID` (`DEP-NNNN`). |
| `SCHEMA_REFERENCE` | Single global table. Read-only data dictionary, loaded from Schema Reference sheet. |

**Conversion Plan extension** — 30 new columns from the spreadsheet, mapped 1-to-1 from sheet rows. Existing 8 tracking columns (LoadedAt, LoadedBy, FileTimestamp, RowCount, LoadVersion, PreviousLoadedAt, S3SourceKey, FileSize) preserved.

**Promote-Mock button (`/admin/promote-mock`):**
1. User selects source Mock (e.g. 13) and target Mock (e.g. 14).
2. UI runs a dry-run: shows count of rows that will be copied, plus any column-shape changes detected between Mock 13 and the latest spec version.
3. On confirm, runs as a transaction:
   - `CREATE TABLE SETUP_CONVERSION_PLAN_MOCK14 (...)` matching latest spec.
   - `INSERT INTO ... SELECT ... FROM SETUP_CONVERSION_PLAN_MOCK13` — column-aligned, with `Mock_Number` rewritten and all *_Loaded/*_Status/*_DateTime tracking columns cleared.
   - Same pattern for VALIDATION_GROUPS, VG_DEPENDENCIES, VBL_GROUPS, VBL_GROUP_MEMBERS.
4. Audit row written to a new `MOCK_PROMOTIONS` table (source mock, target mock, performed_by, performed_at, row_counts JSON).

**Deliverables:**
- 7 new tables in `Hacienda_ERP_Test` (idempotent migration script).
- 30-column extension to `SETUP_CONVERSION_PLAN_MOCK{N}`.
- `/admin/promote-mock` page in Next.js.
- `MOCK_PROMOTIONS` audit table.

**Verify:** Run promotion Mock 13 → Mock 14 in a test environment. Row counts match. `Latest_*` tracking columns are null in MOCK14.

---

### Phase 2 — AWS_FILES event capture (~2 weeks)

**What:** Lambda writes an `AWS_FILES` row at every meaningful S3 event. This is the heart of the system — it's where all the "tags" S3 can't hold get captured.

**Events that write rows:**

| Trigger | What's written |
|---|---|
| File lands in `InitialUpload/` | `AWS_FILES` row with `Movement_Sequence=1`, `File_Status='Received'`, all File Identity + Conversion Plan Link + S3 Location columns populated, gate-check columns initialized to `Not Run`. |
| File moves to `ConversionFiles/` | New row with `Movement_Sequence=2`, gate-check columns set to `N/A`, `Parent_Folder` / `File_URL` updated to destination. |
| File moves to `Errors/` (gate fail) | `Movement_Sequence=1` row's `Moved_To_Folder` populated; no seq 2. `File_Status` set to specific error enum. |
| Validation script writes Validation-to-Source Excel | New row, `File_Category='Validation to Source'`, gate-check columns all `N/A`, `Validation_Group_ID` populated. |
| Conversion Load file generated | New row, `File_Category='Conversion Load'`, `VBL_Group_ID` populated. |
| Sterling transmission completes | UPDATE on the Conversion Load row: `Sterling_Transmission_Status`, `Sterling_Transmission_DateTime`, `File_Status='Sent to Oracle'`. No new row. |
| Distribution file generated (per-BU split) | New row, `File_Category='Distribution - {Category}'`, `Split_From_eTag` linked to consolidated parent, `Business_Unit` populated. |

**Lambda module: `aws_files_writer.py`** (~300 LOC)
- `write_initial_upload_row(s3_event, parsed_filename) → eTag`
- `write_seq2_move_row(eTag, dest_folder)`
- `update_gate_check_results(eTag, results_dict)`
- `update_sterling_status(eTag, status, datetime)`
- `write_distribution_row(parent_eTag, bu, dest_folder)`
- `_resolve_conversion_plan_fk(parsed_filename, mock_number) → wbs_id, validation_group_id, etc.`

**Backfill switch:** A one-shot script (`backfill_aws_files.py`) that walks the entire bucket via `aws s3api list-objects-v2`, populates seq 1 rows for everything already present (eTag from S3 metadata, best-effort `Created_DateTime`, `File_Status='Archived'` for legacy files). Run once at cutover, then disabled.

**Deliverables:**
- `aws_files_writer.py` Lambda module.
- Backfill script run once against `hacienda-erp-dev`.
- Integration test: drop a file into `InitialUpload/`, verify seq 1 + seq 2 rows appear with correct columns.

**Verify:** Upload a file via the browser; within 30 seconds two rows appear in `AWS_FILES` (seq 1 Received, seq 2 in ConversionFiles). Re-upload the same logical file; new eTag, `Supersedes_eTag` chain populated.

---

### Phase 3 — Gate checks + versioning instrumentation (~1.5 weeks)

**What:** The existing 5-step gate check pipeline already runs in Lambda. We instrument it to write all five `Check_*` columns and the version chain.

**Changes to `file_validator.py` and `lambda_function.py`:**

1. Each of the 5 gate checks calls `aws_files_writer.update_gate_check_results(eTag, {'Check_File_Name': 'Pass'})` after running. On first `Fail`, remaining checks log `Not Run` (existing behavior; just capture it).
2. `Error_Type` and `Error_Owner` set from the failed check:
   - Checks 1-3 → `Error_Owner = 'Source Team'`
   - Checks 4-5 → `Error_Owner = 'Pipeline Team'`
3. On successful Table Load: `File_Expected` in `SETUP_CONVERSION_PLAN_MOCK{N}` flipped from Y → N (existing behavior, preserved).
4. **Version chain:** Before inserting seq 1, query `AWS_FILES` for prior eTag with same `Conversion_Plan_Entity` + `Source` + `Mock_Number` where `Superseded_By_eTag IS NULL`. If found:
   - New row's `Supersedes_eTag` = that prior eTag.
   - UPDATE prior row's `Superseded_By_eTag` = new eTag and `File_Status` = `Superseded`.

**Existing flag preserved:** `File_Expected=N` after successful load. To re-upload, an authorized user flips it back to Y via the existing admin tool. (Already implemented today.)

**Deliverables:**
- Updated `file_validator.py` + `lambda_function.py` (gate-check instrumentation).
- New `version_chain.py` helper (~80 LOC).
- Integration test: upload, fail-on-headers, re-upload corrected file; verify the chain.

**Verify:** Upload bad-headers file → `AWS_FILES` row has `Check_File_Name=Pass, Check_File_Expected=Pass, Check_Column_Headers=Fail, Check_TSQL_File_Found=Not Run, Check_TSQL_Load=Not Run, Error_Owner=Source Team`. Upload corrected version → new row with `Supersedes_eTag` pointing to the bad-headers row, which now shows `Superseded_By_eTag` populated.

---

### Phase 4 — Validation Group + dependency tracking (~2 weeks)

**What:** As files load, Validation Groups auto-update; when conditions are met, the existing validation runner script is invoked.

**Logic added to Lambda after each successful Table Load:**

```python
def on_table_load_success(etag, validation_group_id, mock_number):
    # 1. Increment Members_Currently_Loaded
    update_validation_group_count(validation_group_id, mock_number)

    # 2. Check completion
    if all_members_loaded(validation_group_id, mock_number):
        # 3. Check cross-group dependencies (VG_DEPENDENCIES)
        if all_dependencies_satisfied(validation_group_id, mock_number):
            # 4. Trigger validation
            run_id = create_validation_run(validation_group_id, mock_number, etag)
            invoke_existing_validation_script(run_id)
```

**`VG_DEPENDENCIES` enforcement:** Pre-loaded from the spec (23 rows for SUP-* dependencies). Each row's `Dependency_Status` is recomputed every time a Table Load Success happens against the depends-on table. `Blocks_Validation_Trigger` is a computed/triggered column.

**Validation run lifecycle:**
1. Lambda inserts `VALIDATION_RUNS` row with `Run_Status='Running'`, `Trigger_Reason`, `Triggered_By_eTag`.
2. Validation runner script (existing) executes, produces output Excel, uploads to S3 → Phase 2 writes a `Validation to Source` AWS_FILES row.
3. Validation runner UPDATE's the run row: `Error_Count`, `Warning_Count`, `Informative_Record_Count`, `Run_End_DateTime`, `Run_Status='Pending Approval'`, `Validation_File_eTag`.
4. Dashboard surfaces `Pending Approval` runs; approver clicks Approve or Reject in new UI.
5. On Reject + `Reextract_Required=Y`: Lambda flips `File_Expected=Y` on each `Affected_Members` row of `SETUP_CONVERSION_PLAN_MOCK{N}`.

**Re-validation behavior (free for the cost of dependency-checking):** When a re-uploaded file reaches Table Load Success, the same trigger logic runs. Since other members are already loaded, the group is immediately complete → new run fires automatically. Matches spec exactly.

**Deliverables:**
- `validation_group_tracker.py` Lambda module.
- `vg_dependencies_check.py` (cross-group dependency evaluation).
- Approval UI under `/admin/validation-approvals`.
- Migration: seed `VG_DEPENDENCIES` from spec for the current Mock.

**Verify:** Upload all members of `APINV-PRIFAS`. After the last one, a `VAL-0001` row appears with `Run_Status='Running'`. After the validation script completes, `Run_Status='Pending Approval'`. Approve via dashboard → `Approval_Status='Approved'`. Re-upload one member → new `VAL-0002` row triggers automatically.

---

### Phase 5 — VBL + Sterling + Distribution (~2 weeks)

**What:** Once every Validation Group in a VBL Group is approved, the existing Conversion Load + Recon Report + VBL Report generators fire; Sterling status flows; Distribution files are split by BU.

**VBL trigger logic:**

```python
def on_validation_group_approved(validation_group_id, mock_number):
    # Find every VBL Group that includes this VG
    for vbl_group in vbl_groups_containing(validation_group_id, mock_number):
        # Update member's approval
        update_vbl_member_status(vbl_group, validation_group_id)

        # If all required members now approved → trigger VBL
        if all_required_members_approved(vbl_group):
            invoke_existing_conversion_load_script(vbl_group)
            invoke_existing_recon_report_script(vbl_group)
            invoke_existing_vbl_report_script(vbl_group)
```

**Sterling transmission:** Per the spec, Sterling is **not a new S3 event**. When the Conversion Load file is approved for transmission, the existing Sterling integration UPDATEs the AWS_FILES row:
- `Sterling_Transmission_Status='Submitted'`
- `Sterling_Transmission_DateTime=<now>`
- `File_Status='Sent to Oracle'`

If your team uses a manual Sterling portal, this becomes a "Mark as Sent" button in the dashboard's VBL Groups tab for the appropriate role. **Open question — see §6.**

**Distribution (BU split):** After all outputs are approved, for each File_Category in `{Extract, Validation to Source, Conversion Load, Recon Report, Validation Before Load}`, the existing distribution script splits the consolidated file by BU. Each split file lands in `Distribution/MOCK{N}/{PILLAR}/{MODULE} {ENTITY}/{BU}/` and gets a new AWS_FILES row with:
- `File_Category = 'Distribution - {original category}'`
- `Split_From_eTag = <parent eTag>`
- `Business_Unit = <BU code>`

**Deliverables:**
- `vbl_group_tracker.py` Lambda module.
- "Mark as Sent to Sterling" UI in VBL Groups dashboard tab (if needed — see §6).
- Distribution row writer (extends `aws_files_writer.py`).
- Migration: seed `VBL_GROUPS` and `VBL_GROUP_MEMBERS` for current Mock.

**Verify:** Approve every required VG in `VBL-FIN-AP`. Conversion Load + Recon + VBL files appear in S3 within minutes (existing scripts), each with corresponding AWS_FILES rows. Sterling status flips. Distribution rows appear, one per BU.

---

### Phase 6 — Dashboard expansion (~2.5 weeks)

**What:** Surface everything Phases 1-5 captured. Most existing tabs (Gantt, Hierarchy) get richer data; four new tabs added.

**Updates to existing tabs:**

| Tab | Update |
|---|---|
| Gantt View | `Current_Process_Stage` now drives bar color across all 14 stages. Each bar drills into the file detail overlay. |
| Hierarchy View | Adds `Validation_Group_ID`, `VBL_Group_ID` chips per entity. |
| File detail overlay | Adds **Version Chain** (Supersedes → Superseded_By walk), **Lineage Tree** (parent + distribution children via Split_From), and a **5-step gate check timeline**. |

**New tabs:**

1. **AWS Files** — sortable/filterable event log. Filters: eTag, Mock, Validation Group, File Category, File Status, Date range. Each row drills into File Detail.
2. **Validation Groups** — one card per group with member progress (`5 of 7 loaded`), latest run status, dependency status (`SUP-PRIFAS: Loaded ✓`), pending approval badge.
3. **Validation Runs** — table of every run (`VAL-NNNN`). Click → detail showing error/warning/informative counts with direct link to the Validation-to-Source Excel.
4. **VBL Groups** — card per VBL group with member matrix (which VGs are Approved / Pending / Blocking), generated-file rollup (Conversion Load + Recon + VBL eTags), Sterling status, distribution rollup.

**Approval UIs:**
- `/admin/validation-approvals` — list of `Pending Approval` runs. Approve / Reject form. On Reject, optionally check `Reextract_Required=Y` and select affected members (multi-select from group).
- `/admin/vbl-approvals` — list of VBL groups where Sterling transmission is awaiting confirmation.

**Deliverables:**
- 4 new tabs in `app/ap-invoices/page.tsx`.
- Approval pages under `app/admin/`.
- Updated file detail overlay component.
- BU permission enforcement applied to all new views (existing pattern from `app/admin/types.ts`).

**Verify:** Walk through the entire sample-data lifecycle from the spec (the 15 AWS Files rows for APINV-PRIFAS plus 3 Validation Runs) and confirm every step is visible in the UI.

---

## 5. Cross-cutting concerns

| Concern | Plan |
|---|---|
| BU permissions | All new tables include `Business_Unit` or are joinable through Conversion Plan; `canAccessBU()` filter applied to every query in the new tabs. Admin users bypass via `isAdminUser()` (existing). |
| Audit | Every table has `Created_By`, `Last_Updated_By`, `Last_Updated_DateTime`. Lambda writes `Last_Updated_By='ap-invoice-processor-lambda'`. Dashboard writes the Cognito email. |
| PII safety | Per `CLAUDE.md`, no SELECT against any PII row data; all dashboard queries are aggregates / metadata only. Validation/conversion file contents stay in S3, never read by the dashboard. |
| Idempotency | Lambda may re-run on transient failures. All writes use `MERGE` or `IF NOT EXISTS` on the composite key. |
| Backfill | One-shot script in Phase 2; legacy files marked `Archived` so they don't break group counts. |
| Existing automation | None of the script bodies change; only their wrapping calls our `aws_files_writer` / `validation_group_tracker` after each step. |

## 6. Open questions (need answers before each phase starts)

1. **Phase 1:** Should `SCHEMA_REFERENCE` be authored manually in SQL, or generated programmatically from the Schema Reference sheet on each promotion?
2. **Phase 2:** For backfill, what `Created_DateTime` should legacy files get — file's S3 LastModified, or `NULL`?
3. **Phase 3:** Are filename `_V2/_V3` suffixes still relevant once eTag-based versioning is in place? I'd recommend deprecating but not removing (read-only display in detail panel).
4. **Phase 4:** Who can approve a Validation Run? Hardcoded admin list, a new Cognito group, or per-BU approver list in a new `APPROVERS` table?
5. **Phase 5:** Sterling — is it an API the script calls automatically (status update is fully system-driven), or is it a portal where someone clicks Send and the dashboard needs a "Mark as Sent" button?
6. **Phase 6:** Should the operations panel (the one we just built) also surface long-running validation runs and conversion-load generation, or does that stay in the new Validation Runs tab only?

## 7. Out of scope (explicit)

- Rewriting any existing validation / conversion / Sterling script bodies.
- Pulling row data (PII) from any source table into the tracking tables.
- A new orchestration engine — Lambda + button-triggered scripts stay as the orchestration layer.
- Real-time push to the browser (Server-Sent Events / WebSockets). Dashboard polls on a refresh interval.

## 8. Timeline (rough)

| Phase | Effort | Cumulative |
|---|---|---|
| Phase 1 — Schema | ~1.5 weeks | 1.5 w |
| Phase 2 — AWS_FILES capture | ~2 weeks | 3.5 w |
| Phase 3 — Gate + versioning | ~1.5 weeks | 5 w |
| Phase 4 — Validation tracking | ~2 weeks | 7 w |
| Phase 5 — VBL + Sterling + Distribution | ~2 weeks | 9 w |
| Phase 6 — Dashboard | ~2.5 weeks | 11.5 w |

**Approx 11–12 weeks of focused work.** Phases 1-3 ship as a self-contained "everything tracked through table load" milestone if you want to go live early.

## 9. What I need from you before kicking off Phase 1

1. Sign-off on this plan, or marked-up changes.
2. Answers to the four open questions tagged `Phase 1` and `Phase 2` in §6 (the others can wait).
3. Confirmation of the Mock currently in flight (Mock 13? Mock 12?) so the first migration targets the right table.
4. The existing validation/conversion/Sterling script entry points (file paths or Lambda ARNs) — so Phase 4-5 knows what to invoke after writing the trigger rows.

---

*End of plan. Edit this file directly and tell me what to change; I'll regenerate v2 before we touch any code.*
