# HCM Data Validation portal — MOCK03HCM test run

Develop site: https://develop.d1weje07uqmri2.amplifyapp.com/hcm (test database `Hacienda_ERP_Test`).

## What the test environment holds (prepared 2026-10-06)

| Area | State |
|---|---|
| Data | Real MOCK03HCM data for **RHUM** and **HACIENDA**, plus the tables every source shares: 146 tables, 20.7 million rows, row counts equal to `Hacienda_ERP`. Production's 110 indexes on those tables were recreated. Other sources (DOE, 911, FIMAS, …) were not copied, so their validations come back empty. |
| Setup | File locations (3,870 rows), distribution list (2,231) and rule catalog (1,220) refreshed from production. The earlier test copies are kept as `*_BAK_20261006`. |
| Validation results | **HACIENDA**: all 9 HCM/PAY programs run in the test database today. **RHUM**: production's results (1.9 million rows), because RHUM's programs take longer than the 15 minutes the app allows per run. Other sources: production's results copied on 2026-09-22. |
| Certification forms | HR, PAYROLL and SOURCES templates are in place (blank copies of the team's forms, names removed). |
| Portal activity | Cleared for MOCK03HCM: no certifications, commitments, issues, forms, sign-offs, published files or recon reports. The earlier test items are archived under `SymphonyPrivate/_Archive/20261006-182713/` and the `*_ARCHIVE_20261006_182713` tables. |
| Electronic signature | Off for agencies (pending approval). Super users can use it while viewing as an agency. |

The test database now holds real personal data. Give portal access only to people allowed to see it.

### Validation results compared with production

| HACIENDA program | Test | Production | Note |
|---|---:|---:|---|
| HCM(01-50) | 7,684 | 7,684 | same |
| HCM(51-100) | 299 | 291 | HCM-073 |
| HCM(101-150) | 10,387 | 10,214 | HCM-114, HCM-139 |
| HCM(151-200) | 38 | 38 | same |
| HCM(201-250) | 1,034 | 4,095 | HCM-218, HCM-229, HCM-ENTITIES-008 |
| HCM_Entities | 16 | 16 | same |
| PAY / PAY(01-25) / PAY(26-99) | 28 / 1 / 147 | 28 / 1 / 147 | same |

Production's HACIENDA results are from **2026-08-08**. The rules changed after that (for example HCM-218 was limited to active assignments on 2026-08-26) and several HACIENDA tables were reloaded, so the differences are expected: the test reflects today's rules and data. Worth confirming with the team that HCM-229 (0 today, 2,849 in August) is meant to be clean now.

## Before you start

1. **Accounts** — Users & Permissions (portal home → Manage). Invite test users with aliases of your own e-mail (`you+018@…`):
   - Agency User for **RHUM · 018 Junta De Planificacion** (HR and Payroll forms)
   - Agency User for **HACIENDA · 024 Departamento De Hacienda** (Sources form: converted data, pre-load recon, validations)
   - Certification Reviewer
2. Sign in once as each to set the password from the invitation e-mail (50 invitations a day).

## Walkthrough

Tick each step and note anything unexpected.

### A. Validations (main app → Data Validation)
- [ ] Mock MOCK03HCM, program **PAY**, source **HACIENDA** → *Run validation*. Expect 28 rows, 9 codes, and an HCM workbook under Client reports.
- [ ] *Generate agency workbook* for HACIENDA, and for RHUM with BU `018`. Open each and check the Summary, File Validation Error and Error Messages sheets.
- [ ] Don't run RHUM programs from the app: they stop at 15 minutes and leave partial results.

### B. Publish the workbooks to the agencies (portal → Publish)
- [ ] Upload the RHUM 018 agency workbook. Check where the page says it will go, then publish.
- [ ] If it says the name isn't in the distribution list, note the name. Generated workbooks have no one-click publish yet.
- [ ] As the RHUM 018 user: **Files by Source & Agency** shows it under Validations, and it downloads.

### C. Data Cleanse Log and Rules
- [ ] As the RHUM 018 user: Data Cleanse Log shows only RHUM · 018 rows; Export works.
- [ ] As a super user: all agencies; the Rules page opens a rule and shows its path forward.

### D. Validations & Path Forward (as an agency user)
- [ ] Open a validation, then *View failing records*: the rows match the workbook.
- [ ] Commit to the path forward (reviewed, target date or note) for every validation reported to the agency.

### E. Certification forms
RHUM · 018 (HR and Payroll):
- [ ] *Download the form* → in Excel enter Agency Resource and a Comment for each entity → Name, Title, Date, signature → save → *Upload the signed form*. The portal reports what it certified.
- [ ] Answer one entity "…parcial o completamente incorrecta…": it appears under Supporting documents. Add a document.

HACIENDA · 024 (Sources):
- [ ] As a super user viewing as HACIENDA · 024: *Fill in and sign here* on the Sources form. Answer some converted, recon and validation rows and sign electronically. Open the signed file.

Staff view:
- [ ] Pending tab: click a pending certification and confirm it opens that agency's form card.
- [ ] Signed forms, Reported issues and Status by agency tabs; download the status report.
- [ ] *Send back* a form and confirm what it certified returns to pending.

### F. Final signature
- [ ] When everything is certified and committed, sign as the agency: the cycle locks.
- [ ] As a super user: *Reopen (revoke signature)* unlocks it.

### G. Pre-load recon reports (portal → Recon Reports)
- [ ] Generate a report for a HACIENDA entity and confirm it publishes to HACIENDA's Pre-Load Recon folder.
- [ ] As the HACIENDA user, download it.
- [ ] Reports the distribution list doesn't know are listed as not routed. The team still has to add those rows.

### H. Users
- [ ] Remove a test user (they can't sign in), give access again, and change their source/agency.

## Known gaps to decide on

1. **RHUM validations can't run from the app.** Each run is limited to 15 minutes; RHUM's HCM programs need longer. A background run is needed before the team runs RHUM from the app.
2. **Signed PDFs.** In Mock 3, RHUM · 018 uploaded its signed form as a PDF, and HACIENDA certified with a signed PDF letter plus a Word issues document. The portal reads only the Excel form, or the electronic signature.
3. **Publishing generated workbooks** needs a download and re-upload; a *Publish to the agency* button would remove that step.

## Starting over

The portal activity of MOCK03HCM can be cleared again, archived as above, without touching the copied data.
