# HCM Data Validation portal — MOCK03HCM test run

Develop site: https://develop.d1weje07uqmri2.amplifyapp.com/hcm (test database `Hacienda_ERP_Test`).

## What the test environment holds (updated 2026-10-06, evening)

| Area | State |
|---|---|
| Data | Real MOCK03HCM data for **RHUM** and **HACIENDA**, plus the tables every source shares: 146 tables, 20.7 million rows, row counts equal to `Hacienda_ERP`. Production's 110 indexes on those tables were recreated. Other sources (DOE, 911, FIMAS, …) were not copied, so their validations come back empty. |
| Setup | File locations (3,870 rows), distribution list (2,231) and rule catalog (1,220) refreshed from production. The earlier test copies are kept as `*_BAK_20261006`. |
| Validation results | **HACIENDA**: all 9 HCM/PAY programs run in the test database. **RHUM**: HCM(01-50) and HCM(151-200) run in the test database in the background (49 and 61 minutes); the other RHUM programs are production's results. Other sources: production's results copied on 2026-09-22. |
| Certification forms | HR, PAYROLL and SOURCES templates are in place (blank copies of the team's forms, names removed). |
| Published | HACIENDA · 024: its HR and Payroll validation workbooks and the 11 HACIENDA recon reports the distribution list routes. |
| **HACIENDA · 024** | **Completed by the full run below**: 27 path-forward commitments, the Sources form uploaded (52 of 52 certified, 1 issue with a document), signed off. Use it as the worked example; a super user can *Revoke signature* to run it again. |
| RHUM · 010 | 1 path-forward commitment left from earlier testing (not part of this run). |
| Electronic signature | Off for agencies (pending approval). Super users can use it while viewing as an agency. |

The test database now holds real personal data. Give portal access only to people allowed to see it.

### Validation results compared with production

| Program | Source | Test | Production | Note |
|---|---|---:|---:|---|
| HCM(01-50) | HACIENDA | 7,684 | 7,684 | same |
| HCM(51-100) | HACIENDA | 299 | 291 | HCM-073 |
| HCM(101-150) | HACIENDA | 10,387 | 10,214 | HCM-114, HCM-139 |
| HCM(151-200) | HACIENDA | 38 | 38 | same |
| HCM(201-250) | HACIENDA | 1,034 | 4,095 | HCM-218, HCM-229, HCM-ENTITIES-008 |
| HCM_Entities | HACIENDA | 16 | 16 | same |
| PAY / PAY(01-25) / PAY(26-99) | HACIENDA | 28 / 1 / 147 | 28 / 1 / 147 | same |
| HCM(01-50) | RHUM | 53,398 | 53,553 | HCM-030 (545 / 700) |
| HCM(151-200) | RHUM | 18,231 | 18,231 | same |

Production's results are from **2026-08-07/08**. Rules changed after that (for example HCM-218 was limited to active assignments on 2026-08-26) and several tables were reloaded, so the differences are expected: the test reflects today's rules and data. Worth confirming with the team that HCM-229 (0 today, 2,849 in August) and HCM-030 are meant to have dropped.

## Full workflow run — HACIENDA · 024 (2026-10-06)

Run as a super user, viewing as the agency where the agency acts. Record values were not read: only counts, files and statuses were checked.

| # | Step | Result |
|---|---|---|
| 1 | Validations: HACIENDA's 9 programs, run in the background, up to 4 at a time | Pass. All finished on their own; results as in the table above. |
| 2 | Agency workbooks: *Generate agency workbooks* for HACIENDA / 024 | Pass. `HACIENDA_FileValidation_HCM_…` (16,061 rows) and `HACIENDA_FileValidation_PAY_…` (1 row). |
| 3 | *Publish to the agency* | Pass. HR workbook → 024 / Validations / HR; Payroll → 024 / Validations / Payroll and Compensation. |
| 4 | Recon reports: *Generate and publish HACIENDA* | Pass for 11 reports (about 30 seconds). 8 are not in the distribution list (see the gaps below). |
| 5 | Agency home | Pass. "Not started · 0 of 52 certifications · 27 validations awaiting your path forward". |
| 6 | My Files: folders, files, downloads | Pass. 13 files in the right folders; a workbook and a recon report downloaded as valid Excel files. |
| 7 | Validations & Path Forward: open a validation, view its records, commit | Pass. Detail, record count and paging (200 a page) work; commitment saved through the form; the other 26 committed. 27 of 27. |
| 8 | Certification form: *Download the form* | Pass. The Sources form comes with the agency filled in. |
| 9 | Form filled in Excel (52 rows; one recon row answered incorrect) and uploaded | Pass after a fix (bug 1 below): 52 of 52 certified, 1 issue on Person Address. |
| 10 | Supporting document on the issue | Pass. |
| 11 | Final signature | Pass after the fix. Signed; the page and the server both refuse changes afterwards (commitment, upload and e-signature all refused). |
| 12 | Staff: home, Status by agency, Signed forms, Reported issues, Completed | Pass. 1 of 83 signed off, 389 pending, 1 with issues; the tabs agree. |
| 13 | Staff: status report | Pass. `Certification_Status_MOCK03HCM_…xlsx` (175 KB). |
| 14 | Staff: *Revoke signature* (with reason), then sign again | Pass. Back to "Ready to sign", then signed off again. |
| 15 | User Guide for the agency | Pass. The Mock 3 HCM user guide is listed. |

### Issues found

**Fixed during the run**

1. **The final signature was refused although the page showed 52 of 52 certified.** Two causes in matching the form's rows to the setup's records:
   - The setup files the payroll recon entities (Salary, Federal Taxes, State Taxes, Involuntary Deductions, Element Entries with Costing) under the **HR** module, while the form lists them under **HCM-Payroll**. Their own rows were therefore not found, and they took the most serious answer of the whole folder: another entity's "incorrect".
   - The "incorrect" answer's issue went to the first record that used that row (HCM / Bank), not to Person Address.

   Now a record takes its own entity's row in its folder whatever the segment. A record without a row takes the folder's answer but never another entity's "incorrect", and every record answered incorrect gets its own issue. Uploading the form again re-linked the existing issue and its document.

**Open — application** (smaller; say which to fix)

2. In Validations & Path Forward, the records view shows the extra columns as **"Col1", "Col2"**, so an agency can't tell what each column holds.
3. The My Files intro still says to "choose Certify next to the entity to record your response…"; certifying is now done with the form.
4. Some messages lowercase the form's name: "The signed **sources** certification form was received." (also "hcm-hr").
5. The "signed off" refusal names the party by its number: "**024** has signed off MOCK03HCM…" instead of "HACIENDA · 024 Departamento De Hacienda".
6. The certifications page can show "Loading…" for 10–18 seconds on a first visit.

**Open — the team's data and setup** (the portal shows what the tables say)

7. **No path forward text** for any of HACIENDA · 024's 27 validations: every one reads "The path forward for this validation has not been published yet."
8. **Recon reports missing for entities the agency must certify.** HACIENDA has 13 HR recon entities without a published report:
   - 6 have recon views but no distribution-list row: Federal Taxes, Grade, Grade Rate Values, Involuntary Deductions, Salary, State Taxes.
   - 7 have no recon view at all: Element Entries with Costing, Job Grade, Person Legislative, Person Phone, Position Hierarchy, Position Valid Grade, Positions.
   - Two more HACIENDA recon views (AsgEITDestaque, Position Grade) aren't routed either.
9. **Converted Files**: 24 converted-data certifications are required, but no converted files are published, so the agency certifies data it can't open.
10. **Setup vs form**: the setup asks HACIENDA · 024 to certify "Bank" recon and converted data (module HCM), which the Sources form has no row for; they take the folder's answer. The setup's "Payroll and Compensation" validation record matches the form's "Payroll" row only through that same rule.

**Not covered by this run** (needs real logins; please do these)

- Sign in as an **agency user**: sees only its own source/agency, can't open staff pages (Data Cleanse Log, Rules, Publish, Recon, Users), and staff-only actions are refused.
- Sign in as a **certification reviewer**: sees everything, can't change anything.
- Invitation e-mail, first sign-in and password change; removing a user stops their sign-in.

## Before you start (your own run)

1. **Accounts** — Users & Permissions (portal home → Manage). Invite test users with aliases of your own e-mail (`you+018@…`):
   - Agency User for **RHUM · 018 Junta De Planificacion** (HR and Payroll forms): suggested for your run, as HACIENDA · 024 is already completed.
   - Agency User for **HACIENDA · 024** to check what a finished agency sees.
   - Certification Reviewer.
2. Sign in once as each to set the password from the invitation e-mail (50 invitations a day).

## Walkthrough

Tick each step and note anything unexpected.

### A. Validations (main app → Data Validation)
- [ ] Mock MOCK03HCM, program **PAY**, source **RHUM** → *Run validation*. It runs in the background: follow it under *Validation runs* (you can leave the page).
- [ ] Start a few runs at once; no more than 4 run together, the rest wait their turn; a second run of the same program and source is refused.
- [ ] *Generate agency workbooks* for RHUM with BU `018`: an HR and a Payroll workbook. Open them and check the Summary, File Validation Error and Error Messages sheets.

### B. Publish the workbooks to the agency
- [ ] *Publish to the agency* next to each workbook. The page says which folder it went to.
- [ ] As the RHUM 018 user: **My Files** shows them under Validations, and they download.
- [ ] Portal → Publish still takes files you upload by hand.

### C. Data Cleanse Log and Rules (staff)
- [ ] As a super user: the Data Cleanse Log lists every source and agency; Export works; the Rules page opens a rule.
- [ ] As the RHUM 018 user these pages are not available: agencies see their validations under Validations & Path Forward.

### D. Validations & Path Forward (as the agency user)
- [ ] Open a validation, then *View the records*: the count matches the workbook.
- [ ] Commit to the path forward (reviewed, target date or note) for every validation reported to the agency.

### E. Certification forms (as the agency user)
- [ ] HR form: *Download the form* → in Excel enter Agency Resource and a Comment for each entity → Name, Title, Date, signature → save → *Upload the signed form*. The portal reports what it certified.
- [ ] Payroll form as a **signed PDF**: print it to PDF (or scan a signed copy), *Upload the signed form*, record its answers and who signed it, submit. *View the signed PDF* opens it.
- [ ] Answer one entity "…parcial o completamente incorrecta…": it appears under Supporting documents. Add a document.
- [ ] As a super user viewing as the agency: *Fill in and sign here* (electronic signature, pending approval).

Staff view:
- [ ] Pending tab: click a pending certification and confirm it opens that agency's form card.
- [ ] Signed forms, Reported issues and Status by agency tabs; download the status report.
- [ ] *Send back* a form and confirm what it certified returns to pending.

### F. Final signature
- [ ] When everything is certified and committed, sign as the agency: the cycle locks.
- [ ] As a super user: *Revoke signature* (Status by agency) or *Reopen* (the agency's page) unlocks it.

### G. Pre-load recon reports (portal → Recon Reports)
- [ ] Choose a source, *Generate and publish*, and confirm the reports land in its Pre-Load Recon folder.
- [ ] As the agency user, download one.

### H. Users
- [ ] Remove a test user (they can't sign in), give access again, and change their source/agency.

## Starting over

The portal activity of MOCK03HCM can be cleared again, archived, without touching the copied data. A single agency can be reopened with *Revoke signature* and its forms sent back.
