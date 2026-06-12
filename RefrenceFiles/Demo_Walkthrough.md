# Demo Walkthrough — APINV-PRIFAS Full Lifecycle

Reproduces the **Sample Data** scenario from the spec end-to-end so you can
demo the dashboard against deterministic, easy-to-explain rows.

## Setup

Run the demo seed once:

```bash
# from C:\nextjs-storage-browser-main
# (uses the same SSM-to-EC2 pattern as the Phase 1 migrations)
aws s3 cp scripts/sql/demo_lifecycle_seed.sql s3://hacienda-erp-dev/_admin/demo_lifecycle_seed.sql
# Then run via SSM as we've done before — see scripts/sql/phase1_migration.sql for the pattern.
```

The seed inserts:
- **11 AWS_FILES rows** covering every File_Category in the spec (Extract,
  Validation to Source, Conversion Load, Recon, VBL, Distribution)
- **2 VALIDATION_RUNS** rows (VAL-DEMO-0001 rejected, VAL-DEMO-0002 approved)
- Updates `VBL-FIN-AP` to reflect the completed lifecycle (Sterling Submitted)
- Marks both VBL members approved

Every demo row carries `Reason_for_Upload = 'DEMO-LIFECYCLE'` so you can
filter them out in the dashboard's AWS Files tab and delete them in two
SQL statements when you're done.

## The Demo Script

### Step 1 — Show the pipeline metrics strip
Open the **File Processing Dashboard**. The metrics strip at the top
shows the live counts (queue depth, in-flight, success rate, etc.).
Point out the **Sterling pending** tile — it'll drop by 1 because the demo
seed marks one VBL group as Submitted.

### Step 2 — Find the demo files in the event log
Click the **AWS Files** tab. In the **Search filename** filter box, type
`MOCK12_PRIFAS`. You'll see the 11 demo rows mixed in with any real
loads. Mention that every event in the system lands in this table — gate
failures, successful loads, validation outputs, distribution splits, all
of it.

> **Optional**: explain the color-coded status pills. `Invalid Headers`
> and `TSQL Load Error` are red; `Superseded` is gray; `Table Load Success`
> is green; `Distributed` is teal.

### Step 3 — Open a failed upload to show the gate-check trail
Click the row named `FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260101_0900.csv`
(File_Status = `Invalid Headers`). The detail panel slides in showing:
- **Gate Checks** — `Check_File_Name = Pass`, `Check_File_Expected = Pass`,
  `Check_Column_Headers = Fail`, then `Not Run`, `Not Run`. This is the
  spec's strict-order cascade.
- **Error_Owner = Source Team** (per spec rule: checks 1-3 = Source Team).
- **Reason for Upload** — editable dropdown. Pick "Initial Load" and Save.

### Step 4 — Walk the version chain
Scroll the detail panel to **Version Chain**. The original HDR upload
(amber-highlighted) is followed by its successful re-upload row. Click
the re-upload row to navigate the chain — you'll see the second row was
later superseded too by `FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260102_1400.csv`
(the post-rejection correction).

### Step 5 — Show the BU split lineage
Find `VBL-FIN-AP_ConversionLoad_MOCK12.csv` (the consolidated Conversion
Load). Open it → **Split Lineage** section shows:
- Anchor: the consolidated Conversion Load
- 1 child: `VBL-FIN-AP_ConversionLoad_MOCK12_BU14.csv` for Business Unit 14

Mention that distribution children inherit the FK chain (Validation
Group, VBL Group, Mock) from the parent automatically.

### Step 6 — Show the Validation Group detail
Click the **Validation Groups** tab → find `APINV-PRIFAS` → click
**View members**. You'll see:
- Stats chips: `2 members · 2 loaded`
- The HDR and LINES rows both green
- Each row shows the eTag prefix, status, and Received/Processed times

### Step 7 — Show the Validation Runs history
Click the **Validation Runs** tab. `VAL-DEMO-0001` (rejected, Threshold
Exceeded = Y) and `VAL-DEMO-0002` (approved) are both there. Click
`VAL-DEMO-0001` to show the side panel with the error count and
**Affected_Members** populated.

### Step 8 — Open the VBL Group detail page
Click the **VBL Groups** tab → click anywhere on the **VBL-FIN-AP** card.
You'll navigate to the full detail page:
- **Run state** card — Latest_VBL_Status = `Sent to Oracle`,
  Sterling_Transmission_Status = `Submitted`, all three generated-file
  eTags populated, Distribution rows = 1.
- **Members** card — both VGs Approved, neither Blocks.
- **Metadata** card — editable Name + Notes.
- **Danger zone** — type-the-ID delete (don't actually delete!).

### Step 9 — Show the admin consoles (separate users would handle this)
- `/admin/validation-approvals` — Pending Approval queue (empty after
  the demo; mention this is where the approver would click Decide)
- `/admin/vbl-approvals` — VBL + Sterling console
- `/admin/promote-mock` — show the PRE syntax (point out `13PRE` for the
  dev team running a parallel test track)

### Step 10 — Wrap with the Gantt View
Click the **Gantt View** tab. Each entity row's four stages are now driven
by `Current_Process_Stage` (post Phase 6.9 fix). For the demo entities,
all four columns should be green (Pass) reflecting the completed
lifecycle.

## Cleanup

After the demo, drop the synthetic rows:

```sql
DELETE FROM AWS_FILES WHERE Reason_for_Upload = 'DEMO-LIFECYCLE';
DELETE FROM VALIDATION_RUNS_MOCK12 WHERE Notes LIKE 'DEMO%';

-- Optional: revert the VBL group state if you want it back to its real value
UPDATE VBL_GROUPS_MOCK12 SET
    VBL_File_eTag = NULL, Recon_File_eTag = NULL,
    Conversion_Load_File_eTag = NULL,
    Latest_VBL_Status = NULL, Sterling_Transmission_Status = NULL,
    Latest_Approval_Status = NULL, Latest_Approver = NULL,
    All_Val_To_Source_Approved = 'N',
    Val_To_Source_Members_Approved = 0
WHERE VBL_Group_ID = 'VBL-FIN-AP';

UPDATE VBL_GROUP_MEMBERS_MOCK12 SET
    Val_To_Source_Latest_Status = NULL,
    Val_To_Source_Approval_Status = NULL,
    Val_To_Source_Approval_DateTime = NULL,
    Blocks_VBL_Trigger = 'Y'
WHERE VBL_Group_ID = 'VBL-FIN-AP';
```

---

That's the full lifecycle from the spec's Sample Data section, reproduced
faithfully and reversibly. Total demo run-time: about 8 minutes.
