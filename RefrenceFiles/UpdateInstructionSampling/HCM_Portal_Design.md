# HCM Portal — design and API contract

Requirements: `HCM_Portal_Requirements_2026-09-21.md` (same folder). This document is the contract between the Lambda feature modules and the pages. Anything not listed here stays as it is.

## 0. Principles
- The portal is a separate section at `/hcm/*` with its own shell. Portal users never see the file browser or the file-processing screens.
- **Source + agency is the key everywhere.** Agency may be blank (source-level). BU is informational only.
- Clean UI for agency users and for the non-development super users: a home page with a few large tiles, one task per page, plain language, no developer details (no database names, view names, keys).
- Server enforces every rule; the pages only hide what a user cannot do.
- All agency files, attachments and guides live under the private S3 root `SymphonyPrivate/` and are reached only through role-checked presigned URLs (15 minutes).
- Existing conventions stay: feature module = `ACTIONS` + `handle(action, event, bucket, headers, conn_str)`; reads are GET with `email`, writes are POST JSON with `actor`; `api_util.ok/fail/guarded`; all SQL objects fully qualified `[{DB}].dbo.[Name]` with `DB = validation_seed.TARGET_DB`; team setup objects are cloned into a test target with `validation_seed.Seeder(conn).ensure(name)`; never drop or alter team tables.

## 1. Who sees what
| User | How identified | Lands on | Sees |
|---|---|---|---|
| Developer / administrator | `ADMIN_EMAILS` or `isAdmin` | `/` file browser (unchanged) | everything, plus a link to the HCM portal and "view as agency" inside it |
| Super user, non-development (Arlene, Fransheska, Hector) | role `super_user`, not admin | `/hcm` | portal only: all files by source and agency, certifications (pending / completed with issues / status), data cleanse log, validation rules, recon report tools, publish files, user guides |
| Certification review | role `certification_reviewer`, not admin | `/hcm` | same as super user but read-only, no publish |
| Agency user | role `agency_user` | `/hcm` | portal only: my files, certifications, validations and path forward, user guide |

`portal_only = role != '' and not is_admin`. Portal-only users are redirected to `/hcm` from `/`, `/ap-invoices`, `/validations`, `/data-validation`, `/config`, `/admin*`.
The admin user page no longer ties `isAdmin` to `super_user`: `isAdmin` still implies super user on the server, but role `super_user` can be given without `isAdmin`.

### Party scoping
- Permission record gains `parties: string[]`, each `"SOURCE|AGENCY"` upper-cased, agency may be empty (`"RHUM|"` = the source-level certifier).
- `authz.agency_code(value)`: strip; when the value starts with three digits followed by end or a non-digit, return those three digits; else upper-case.
- `authz.party_key(source, agency) -> (SOURCE, AGENCY_CODE)`.
- `authz.parties(email) -> set[(SOURCE, AGENCY_CODE)] | None` — `None` means unrestricted (super user, reviewer). Empty set when an agency user has no `parties`.
- `authz.can_act_on_party(email, source, agency, bu="") -> bool`: unrestricted → True. When the record has `parties` → exact `(source, agency_code(agency or bu))` membership. When it has none → the old `can_act_on(email, source, agency, bu, bu[:3])`.
- A party with blank agency sees the whole source in the data cleanse log (source-level view) and certifies only the blank-agency records.

## 2. app_settings
- `app_config_get` adds: `is_admin` (bool), `portal_only` (bool), `parties` (list of `{source, agency}` for agency users, else `[]`), `recon_tool_url` (string, may be empty).
- `app_config_set` accepts any of `current_mock`, `recon_tool_url` (empty or `https://…`, ≤ 500 chars). Same history table. Response echoes the new values.

## 3. certifications (module `certifications.py`)
Party = `(source, agency)`. `bu` is returned for display. Record key = `(mock, source, agency, module, file_type, entity)`.

Response codes (`RESPONSES`):
- `AGREE` — "Estoy de acuerdo con los errores presentados y se estarán corrigiendo los mismos, de lo contrario las transacciones asociadas a estos errores se convertirán en error."
- `ISSUES` — "Se verificó la data y la misma está parcial o completamente incorrecta. Se incluye un anejo con documentación de soporte."
- `NO_ERRORS` — "Se verificó la data y no contiene errores."

Tables (in `[DB].dbo`, created / extended by the module, never dropped):
- `DATA_CLEANSE_CERT_FILE` + columns `Module VARCHAR(50)`, `Response_Code VARCHAR(20)`, `Resource_Name NVARCHAR(200)`.
- `DATA_CLEANSE_CERT_VALIDATION` + columns `Reviewed BIT`, `Target_Date DATE`. `Path_Forward` now stores the rule's path forward as shown when the agency committed.
- `DATA_CLEANSE_CERT_ISSUE` (new): `ID, MOCK, Source, Agency, Module, File_Type, Entity, Description NVARCHAR(MAX), Reported_By, Reported_DTTM, Deleted BIT`.
- `DATA_CLEANSE_CERT_SIGNOFF` (new): `ID, MOCK, Source, Agency, Signer_Name, Signer_Title, Signed_By, Signed_DTTM, Statement NVARCHAR(MAX), Is_Current BIT, Revoked_By, Revoked_DTTM, Revoke_Reason`.
- `DATA_CLEANSE_CERT_ATTACHMENT`: `Cert_Type` gains `ISSUE` (`Cert_Key` = issue ID as text). Existing upload / add / list / download / delete actions work for it unchanged.

Reads (GET, `email`; roles agency_user, certification_reviewer, super_user; every party checked with `can_act_on_party`):
- `cert_expected {mock}` → `{available, mock, responses:[{code,label}], parties:[{source, agency, bu, party, required, certified, with_issues, validations_reported, validations_committed, signed_off:{name,title,by,at}|null, status}], rows:[{source, agency, bu, party, module, file_type, entity, file_path, certified, response_code, resource_name, notes, certified_by, certified_at, issues, attachments}], warnings}`. `status` ∈ `Signed off | Ready to sign | In progress | Not started`. Rows are the `CertificationRequired='Y'` rows of `SETUP_DATA_CLEANSE_FILE_LOCATION_<mock>`.
- `cert_validations {mock, source, agency}` → `{party, validations:[{validation_code, count, message, message_spa, entity, type, severity, path_forward, committed, reviewed, target_date, notes, committed_by, committed_at}], warnings}`. Codes: catalog rows with `AgencyReports='Y'` (party with an agency) or `Sourcereports='Y'` (blank agency) that have log rows for the party. `path_forward` comes from the rules table. In a test target with no log rows for the cycle, counts are read from the main database (counts only) and a warning says so.
- `cert_issues {mock, source?, agency?, module?, file_type?, entity?}` → `{issues:[{id, source, agency, party, module, file_type, entity, description, reported_by, reported_at, certified, attachments:[{id,file_name,size,uploaded_by,uploaded_at}]}]}`. Without `source` (super user / reviewer only) it lists every issue of the cycle.
- `cert_records {mock, state}` (`state` = `pending | completed | issues`; super user / reviewer; agency users get only their parties) → `{records:[{source, agency, party, module, file_type, entity, response_code, resource_name, certified_by, certified_at, issues}]}`.
- `cert_status {mock}` — as today plus per party `with_issues`, `signed_off`, `signed_by`, `signed_at`, and totals `signed_off`, `with_issues`.
- `cert_attachments`, `cert_download_url` — unchanged (party check by source + agency).

Writes (POST, `actor`; agency_user for own parties, super_user; reviewers cannot write):
- `cert_certify_file {mock, source, agency, module, file_type, entity, response_code, resource_name, notes?}` → record must be expected. `ISSUES` requires at least one issue on the record and at least one attachment on every issue, else 400 naming what is missing. Re-certifying keeps history. A party that is signed off cannot change records until the sign-off is revoked (409).
- `cert_issue_save {mock, source, agency, module, file_type, entity, id?, description}` → `{id}`. `cert_issue_delete {id}` (reporter or super user; soft delete).
- `cert_certify_validation {mock, source, agency, validation_code, reviewed, target_date?, notes?}` → at least one of `reviewed=true`, `target_date`, `notes`. Stores the rule's current path forward.
- `cert_signoff {mock, source, agency, signer_name, signer_title}` → 409 with `{missing_records:[…], missing_validations:[…]}` unless every expected record is certified and every reported validation is committed. Stores the statement text shown to the signer.
- `cert_revoke` — also accepts `cert_type = SIGNOFF` (super user).
- `cert_upload_url`, `cert_attachment_add`, `cert_attachment_delete`, `cert_status_report` — unchanged apart from the party check; the status report gains the response, issues and sign-off columns.

## 4. published files (new module `portal_files.py`)
S3:
- published: `SymphonyPrivate/Published/<MOCK>/<SOURCE>/<AGENCY or _SOURCE>/<MODULE>/<FILE_TYPE>/<ENTITY>/<file name>` (each segment through `api_util.safe_segment`)
- inbox: `SymphonyPrivate/PublishInbox/<MOCK>/<batch>/<file name>`
- guides: `SymphonyPrivate/UserDocs/<MOCK>/<file name>`

Table `DATA_CLEANSE_PUBLISHED_FILE`: `ID, MOCK, Source, Agency, BU, Module, File_Type, Entity, File_Name, S3_Key, Size_Bytes, Published_By, Published_DTTM, Deleted BIT, Deleted_By, Deleted_DTTM`. Publishing a file name again to the same location replaces the earlier row.

Resolution (the team's publishing rule): the longest `FileName` in `SETUP_DATA_CLEANSE_FILE_DISTRIBUTION_<mock>` that the file name starts with (case-insensitive) gives `pillar, File_Type, entity, Agency, source`; `SETUP_DATA_CLEANSE_FILE_LOCATION_<mock>` rows with the same `Source, Agency, File_Type, Entity` give `MODULE`, `BU`. `MultipleLocations='Y'` publishes to every matching location.

Reads (GET, `email`):
- `pub_parties {mock}` → `{parties:[{source, agency, bu, party, files, required, certified}]}` (only the caller's parties).
- `pub_tree {mock, source, agency}` → `{party, modules:[{module, file_types:[{file_type, entities:[{entity, certification_required, certified, files:[{id, name, size, published_by, published_at}]}]}]}], total_files}`. The structure comes from the file-location rows, so empty folders show too.
- `pub_download_url {id}` → `{url, file_name}` after the party check.
- `guide_list {mock}` → `{guides:[{name, size, last_modified}]}`; `guide_url {mock, name}` → `{url}`. Any role.

Writes (POST, `actor`, super user only):
- `pub_preview {mock, names:[…]}` → `{results:[{name, matched, targets:[{source, agency, party, module, file_type, entity}], reason}]}` — no S3 access.
- `pub_upload_urls {mock, batch?, files:[{name, size, content_type}]}` (≤ 50) → `{batch, uploads:[{name, key, url, content_type}]}`.
- `pub_publish {mock, batch, names:[…]}` (≤ 25 per call) → `{published:[{name, targets:[…]}], unmatched:[{name, reason}]}`; published inbox objects are removed.
- `pub_publish_report {mock, key}` — publishes a workbook the app generated under `SymphonyPrivate/Reports/`.
- `pub_delete {id}` — soft delete.
- `guide_upload_url {mock, file_name, content_type, size}` → `{url, key, content_type}`; `guide_delete {mock, name}`.

## 5. data cleanse log and rules
- `cleanse_log` adds optional `source`, `agency`, `bu` filters (server side), party-aware row filtering, and a `rules` object in the response: `{ "<code>": {message, message_spa, path_forward, severity, entity, type} }` for the codes in the returned rows (never `InternalNote` / `Notes`). In a test target whose log has no rows for the cycle it reads the main database automatically and says so in `warnings`.
- `rules_sync` (POST, super user, test target only): fills blank `PATH_FORWARD` values in the test copy from the main rules table. Response `{updated}`.
- Agency users never call `rules_list`; their read-only rules view is the `rules` object above.

## 6. Pages
All under `app/hcm/`, all wrapped in `HcmShell` (brand, HCM-only mock cycle selector, party selector when the user has more than one party, user, role, sign out, "view as agency" for super users and admins).
- `/hcm` home tiles. Agency: My Files · Certifications · Validations & Path Forward · User Guide, with a progress line. Super user / reviewer: Files · Certifications · Data Cleanse Log · Validation Rules · Recon Report Tools · (super) Publish Files · User Guides.
- `/hcm/files`, `/hcm/certifications`, `/hcm/validations`, `/hcm/cleanse-log`, `/hcm/rules`, `/hcm/guide`, `/hcm/publish`.
- `/data-cleanse-log` and `/certifications` redirect to their portal pages.

## 7. Shell interface (for page authors)
`app/hcm/HcmShell.tsx`:
```ts
export interface HcmParty {
  source: string; agency: string; bu?: string; party?: string;
  required?: number; certified?: number; with_issues?: number;
  validations_reported?: number; validations_committed?: number;
  signed_off?: { name: string; title: string; by: string; at: string } | null;
  status?: string }                       // Signed off | Ready to sign | In progress | Not started
export interface HcmContext {
  session: SymphonySession; email: string; mock: string; mocks: string[];   // HCM cycles only
  view: 'agency' | 'staff'; party: HcmParty | null; parties: HcmParty[];
  partiesLoading: boolean; cycleAvailable: boolean;
  isSuperUser: boolean;                   // isAdmin || role === 'super_user'
  isReviewer: boolean;                    // role === 'certification_reviewer' && !isAdmin
  canWrite: boolean;                      // isSuperUser || role === 'agency_user'
  reloadParties: () => void }
export function useHcm(): HcmContext
export const partyKey: (p: { source: string; agency: string }) => string     // "SOURCE|AGENCY"
export function partyLabel(p: { source: string; agency: string; bu?: string; party?: string }): string
export function statusBadgeClass(status?: string): string
export function formatSize(bytes?: number | null): string
export interface HcmShellProps { title: string; subtitle?: string; children: React.ReactNode;
  staffOnly?: boolean; agencyOnly?: boolean; superOnly?: boolean; wide?: boolean }
export default function HcmShell(props: HcmShellProps): JSX.Element
```
- A page: `'use client'`, `Amplify.configure(config)` at module top, imports `@aws-amplify/ui-react/styles.css`, `export default withAuthenticator(Page)`; `Page` renders `<HcmShell title=…><Inner/></HcmShell>` and `Inner` calls `useHcm()`. See `app/hcm/guide/page.tsx`.
- Children mount once the session and the cycle's parties are loaded, remount when the Mock Cycle changes, and stay mounted through `reloadParties()` and through a party change (key effects on `party` and `view`).
- `superOnly` = super user in staff view; `staffOnly` fails while staff view as an agency.
- Errors: show the server's text only when `view === 'staff'`; agency view gets a plain sentence.
- Reusable classes (`app/hcm/hcm.css`): `hcm-tiles`, `hcm-tiles-small`, `hcm-tile` (+ `-icon`, `-body`, `-title`, `-text`, `-badge`, `-disabled`), `hcm-summary` (+ `-party`, `-text`), `hcm-section` (h2), `hcm-card`, `hcm-card-head`, `hcm-banner` (blue; `sy-note` amber, `sy-error` red, `sy-success` green), `hcm-empty`, `hcm-message`, `hcm-message-actions`, `hcm-loading`, `ul.hcm-list > li.hcm-row` (+ `-icon`, `-main`, `-title`, `-meta`, `-actions`), `hcm-upload`, badges `sy-badge` + `-ok | -info | -warn | -bad`. `.btn` inside the shell renders as a button on links too.

## 8. Signed certification forms (module `cert_forms.py`, 2026-09-29)
Agencies certify on the validation team's own Excel form instead of choosing a response per record in the portal.
- Templates per cycle and kind at `SymphonyPrivate/CertForms/<MOCK>/templates/<KIND>.xlsx`; kinds `HR`, `PAYROLL` (agencies that certify only Validations, one form per module) and `SOURCES` (parties that also certify Converted Files / Pre-Load Recon; one form covers all their records) — `certifications.form_kind`.
- Download fills the Agency cell and the "Certifico que el sistema fuente…" line in the XML itself (the form's dropdowns survive).
- Upload (.xlsx only) is read: table under Segment / Data Entity / Folder|Archivo / Agency Resource / Comments, plus Agency, Name, Title, Date. Refused when no row has a form comment, Name is empty, or the agency number differs. Comments match the form's lists ignoring accents/case/spacing (`RESPONSES` gains `CONVERTED_OK`, `COST_ALLOCATION`).
- Each covered record is certified (`DATA_CLEANSE_CERT_FILE.Form_ID`) with the row of the same data entity, else the most serious answer of its folder + segment. Rows answered as incorrect become issues (`DATA_CLEANSE_CERT_ISSUE.Form_ID`) that need a supporting document before sign-off. A new upload replaces the earlier form; a super user can send a form back (`certform_revoke`).
- Tables `DATA_CLEANSE_CERT_FORM`, `DATA_CLEANSE_CERT_FORM_ROW`. Actions: `certform_templates`, `certform_template_upload_url|url|delete`, `certform_status`, `certform_list`, `certform_rows`, `certform_file_url`, `certform_download`, `certform_upload_url`, `certform_submit`, `certform_revoke`.

## 9. Recon reports for sources (module `recon_reports.py`, 2026-09-29)
- Source-level recon views in the conversion database: `HCM_<ENTITY>_<MOCK>_<SOURCE>_RECON_SUMMARY_VW` / `_RECON_VW` / `_RECON2_VW` (tokens starting with a cycle agency number are agency-level and left out).
- `recon_list {mock}` (super user, reviewer) lists them with where the distribution list sends them; `recon_generate {mock, entity, token}` (super user) writes `PR_<ENTITY>_<SOURCE>_ReconReport_<MOCK>_<stamp>.xlsx` (Summary, Detail, By BU), publishes it through `portal_files` and retires the earlier report of the same entity and source. Replaces the old Recon Report Tools link (`recon_tool_url` removed).

## 10. Users & Permissions (page `/hcm/users`, 2026-09-29)
Super users run the portal's accounts themselves; administrators keep the Admin pages.
- Runs on the permission service (`user-approval-handler`), actions `portal_users`, `portal_user_save {email, name, role, parties, invite}`, `portal_user_remove {email}`, `portal_user_resend {email}`. Callers must be an administrator or a super user.
- Super users manage Agency Users and Certification Reviewers; administrators also manage Super Users. Nobody changes their own account or an administrator's here.
- Adding a user with no sign-in account invites them (Cognito `AdminCreateUser`: e-mail with a temporary password, e-mail marked verified). The permission record is written with `approved: true`, so the sign-in check lets them in without the admin approval step. Pre-signup skips its approval e-mail for invitations.
- Removing a user disables the sign-in account and clears role and assignments (`approved: false`, `disabled: true`). Giving access again re-enables it.
- Status shown: Active, Invited (has not set a password yet), Removed, Registered with no access (self-registered, no role), No account (a record without a sign-in account).
- Invitations use the sign-in service's own e-mail, 50 a day. Moving the pool to SES lifts that and allows a custom invitation text with the portal link.

### Caller verification
Every portal action on the processor and every user-management action checks the caller's Cognito access token (`Authorization: Bearer`, verified with `GetUser`, remembered 5 minutes). The e-mail and actor in the request are replaced with the verified e-mail (`authz.verified_email`, `api_util.set_caller`). The Admin pages' `list`, `list_permissions` and `set_permissions` now also need an administrator's token. `get_permissions` and the approve/deny links in the approval e-mail still use the shared token.

## 11. Electronic signature of the forms (2026-09-30, pending approval)
An alternative to download, sign and upload: the agency answers the same form in the portal and signs with its details.
- "Fill in and sign here" on each form card shows the rows of the cycle's template (`certform_esign_form`) with the comments each folder offers, pre-filled from the party's current form. The signer enters Name and Title and accepts the consent text. The signed-in account's e-mail, verified by its token, is part of the signature.
- `certform_esign` writes the answers and the signature block into the template (Name, Title, Date, and "Firmado electrónicamente por … (e-mail) … fecha y hora de Puerto Rico" next to Signature), stores it as `<form name>_eSigned.xlsx` beside uploaded forms, reads it back with the same reader, and records it with `_record`, the same path as an upload.
- Audit columns on `DATA_CLEANSE_CERT_FORM`: `Sign_Method` (ESIGN; NULL = uploaded), `Signer_IP`, `Signer_Agent`, `Content_SHA256` of the stored file, `Consent_Text`.
- Setting `esign_agencies` (APP_SETTINGS, with history): while it is off, only super users can sign this way (e.g. while viewing as an agency, for demos). A super user turns it on under User Guides → Certification forms → Electronic signature (`certform_esign_setting`).
- The consent wording is a draft for the approvers.
