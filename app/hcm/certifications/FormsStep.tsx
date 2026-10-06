'use client';

// Step 1 of an agency: the validation team's certification form. The agency
// downloads it with its agency already filled in, completes and signs it in
// Excel and uploads it back (or, once approved, fills it in and signs it in the
// portal: ESignForm). The portal reads the answers, certifies what the form
// covers and keeps the file for later review. Every entity answered as
// incorrect becomes an issue that needs its supporting documents.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiResult, apiGet, fmtDateTime } from '../../lib/symphony';
import { HcmParty, fileTypeLabel, formatSize, useHcm } from '../HcmShell';
import ESignForm from './ESignForm';
import {
  Attachment, Documents, Issue, IssuesResult, ReasonForm, RecordName, Written, agencyProblem, count, day, post,
  recordKey, responseBadgeClass, responseShort,
} from './shared';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_FORM_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export interface FormRow {
  row: number;
  segment?: string | null;
  entity?: string | null;
  folder?: string | null;
  resource?: string | null;
  comment?: string | null;
  code?: string | null;
}
export interface FormInfo {
  id: number;
  source: string;
  agency: string;
  kind: string;
  file_name: string;
  size?: number | null;
  signer_name?: string | null;
  signer_title?: string | null;
  signed_date?: string | null;
  signature_image?: boolean;
  rows?: number | null;
  answered?: number | null;
  uploaded_by?: string | null;
  uploaded_at?: string | null;
  electronic?: boolean;         // signed in the portal rather than uploaded
  method?: string;              // XLSX (Excel form uploaded), PDF (signed PDF, answers recorded) or ESIGN
}
interface FormKind { kind: string; label: string; template: boolean; records: RecordName[]; form: FormInfo | null; rows: FormRow[] }
interface FormStatus extends ApiResult { kinds?: FormKind[]; esign_open?: boolean }
interface LinkResult extends ApiResult { url?: string; key?: string; content_type?: string }
export interface Submitted extends ApiResult { certified?: number; not_certified?: RecordName[]; new_issues?: string[]; warnings?: string[] }
interface DocumentAdded extends ApiResult { id?: number; file_name?: string; size?: number }

export const formTitle = (label: string) => `${label} certification form`;

/** Opens an uploaded form's file. An Excel file downloads in place; a PDF opens in
 * a new tab, which the caller opens before the request so no pop-up blocker stops it. */
export async function openFormFile(id: number, email: string, tab?: Window | null): Promise<string> {
  const d = await apiGet<LinkResult>('certform_file_url', { id, email, view: tab ? 1 : undefined });
  if (!d.ok || !d.url) {
    tab?.close();
    return d.error || 'The file could not be opened';
  }
  if (tab) tab.location.href = d.url;
  else window.location.assign(d.url);
  return '';
}

export const isPdf = (form: FormInfo) => form.method === 'PDF' || form.file_name.toLowerCase().endsWith('.pdf');

/** What the portal read from a form, row by row. */
export function FormRowsTable({ rows }: { rows: FormRow[] }) {
  if (rows.length === 0) return <p className="hcert-note">The form has no rows.</p>;
  return (
    <div className="sy-scroll">
      <table className="sy-table hcert-form-rows">
        <thead>
          <tr><th>Data entity</th><th>Segment</th><th>Folder</th><th>Agency resource</th><th>Comment</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.row}>
              <td>{r.entity}</td>
              <td>{r.segment || '—'}</td>
              <td>{r.folder || '—'}</td>
              <td>{r.resource || '—'}</td>
              <td>
                {r.code ? <span className={responseBadgeClass(r.code)} title={r.comment || undefined}>{responseShort(r.code)}</span>
                  : r.comment ? <span className="sy-badge sy-badge-warn" title={r.comment}>Not one of the options</span>
                    : <span className="sy-muted">No comment</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FormCard({ item, party, locked, esignOpen, focused, onChanged }: {
  item: FormKind;
  party: HcmParty;
  locked: boolean;
  esignOpen: boolean;           // electronic signature is approved for agencies
  focused: boolean;             // the card of the certification the user chose
  onChanged: (message: string) => void;
}) {
  const { mock, email, canWrite, isSuperUser } = useHcm();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Submitted | null>(null);
  const [showRows, setShowRows] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [pdf, setPdf] = useState<{ key: string; name: string } | null>(null);   // uploaded, answers not recorded yet
  const ids = { actor: email, mock, source: party.source, agency: party.agency, kind: item.kind };
  const form = item.form;
  const title = formTitle(item.label);
  const canUpload = canWrite && !locked && item.template;
  const canESign = canUpload && (esignOpen || isSuperUser);

  const download = async () => {
    setBusy('download');
    setError('');
    const d = await post<LinkResult>('certform_download', ids);
    setBusy('');
    if (!d.ok || !d.url) {
      setError(agencyProblem(d, 'The form could not be prepared. Please try again in a moment.'));
      return;
    }
    window.location.assign(d.url);
  };

  const upload = async (file: File) => {
    setError('');
    setResult(null);
    const asPdf = file.name.toLowerCase().endsWith('.pdf');
    if (!asPdf && !file.name.toLowerCase().endsWith('.xlsx')) {
      setError('Upload the completed form as the Excel file (.xlsx) you downloaded, or the signed form as a PDF.');
      return;
    }
    if (file.size === 0 || file.size > MAX_FORM_BYTES) {
      setError(`${file.name} is ${file.size === 0 ? 'empty' : formatSize(file.size)}. The limit is 25 MB.`);
      return;
    }
    setBusy('upload');
    const failed = `${file.name} could not be uploaded. Please try again.`;
    const up = await post<LinkResult>('certform_upload_url', {
      ...ids, file_name: file.name, content_type: asPdf ? 'application/pdf' : XLSX, size: file.size,
    });
    if (!up.ok || !up.url || !up.key) {
      setBusy('');
      setError(agencyProblem(up, failed));
      return;
    }
    try {
      // The link is signed for one content type; send exactly that one.
      const put = await fetch(up.url, { method: 'PUT', headers: { 'Content-Type': up.content_type || XLSX }, body: file });
      if (!put.ok) throw new Error(String(put.status));
    } catch {
      setBusy('');
      setError(failed);
      return;
    }
    if (asPdf) {
      // A PDF can't be read: its answers are recorded next, then it is submitted.
      setBusy('');
      setSigning(false);
      setPdf({ key: up.key, name: file.name });
      return;
    }
    const d = await post<Submitted>('certform_submit', { ...ids, key: up.key, file_name: file.name });
    setBusy('');
    if (!d.ok) {
      setError(agencyProblem(d, 'The form could not be read. Please try again in a moment.'));
      return;
    }
    setResult(d);
    onChanged(`The signed ${title.toLowerCase()} was received.`);
  };

  const open = async () => {
    if (!form) return;
    const tab = isPdf(form) ? window.open('', '_blank') : null;
    setBusy('open');
    setError('');
    const problem = await openFormFile(form.id, email, tab);
    setBusy('');
    if (problem) setError('The file could not be opened. Please try again in a moment.');
  };

  const reject = async (reason: string) => {
    if (!form) return;
    setBusy('reject');
    setError('');
    const d = await post<ApiResult>('certform_revoke', { actor: email, id: form.id, reason });
    setBusy('');
    if (!d.ok) {
      setError(agencyProblem(d, 'The form could not be rejected. Please try again in a moment.'));
      return;
    }
    setRejecting(false);
    onChanged(`The ${title.toLowerCase()} was sent back. The agency uploads a corrected one.`);
  };

  const covers = item.records.length === 1
    ? [item.records[0].module, fileTypeLabel(item.records[0].file_type)].filter(Boolean).join(' · ')
    : count(item.records.length, 'certification', 'certifications');

  return (
    <section className={`hcm-card hcert-record${focused ? ' hcert-focus' : ''}`} id={`hcert-card-${item.kind}`}
      aria-labelledby={`hcert-form-${item.kind}`}>
      <div className="hcert-record-head">
        <h3 className="hcert-record-name" id={`hcert-form-${item.kind}`} tabIndex={-1}>{title}</h3>
        {form ? <span className="sy-badge sy-badge-ok">{form.electronic ? 'Signed electronically' : isPdf(form) ? 'Signed PDF uploaded' : 'Uploaded'}</span>
          : <span className="sy-badge sy-badge-warn">Not uploaded yet</span>}
      </div>
      <p className="hcert-note">Covers {covers}.</p>

      {!item.template ? (
        <div className="sy-note">The validation team has not added this form for {mock} yet.</div>
      ) : form ? (
        <dl className="hcert-facts">
          <dt>File</dt><dd>{form.file_name}{formatSize(form.size) ? ` (${formatSize(form.size)})` : ''}</dd>
          <dt>{form.electronic ? 'Signed in the portal' : 'Uploaded'}</dt>
          <dd>{[form.uploaded_by, form.uploaded_at && fmtDateTime(form.uploaded_at).slice(0, 16)].filter(Boolean).join(' on ')}</dd>
          <dt>Signed by</dt>
          <dd>
            {[form.signer_name, form.signer_title, form.signed_date].filter(Boolean).join(', ') || '—'}
            {form.electronic ? <span className="sy-muted"> · signed electronically</span>
              : isPdf(form) ? <span className="sy-muted"> · signed PDF, answers recorded in the portal</span>
                : !form.signature_image && <span className="sy-muted"> · no signature image in the file</span>}
          </dd>
          <dt>Entities answered</dt><dd>{form.answered ?? 0} of {form.rows ?? 0}</dd>
        </dl>
      ) : null}

      {item.template && (
        <div className="hcert-record-actions">
          <button type="button" className={`btn ${form ? 'btn-secondary' : 'btn-primary'}`} disabled={!!busy} onClick={download}>
            {busy === 'download' ? 'Preparing…' : 'Download the form'}
          </button>
          {canUpload && (
            <label className={`btn ${form ? 'btn-secondary' : 'btn-primary'}${busy ? ' hcert-disabled' : ''}`}>
              {busy === 'upload' ? 'Uploading…' : form ? 'Upload a corrected form' : 'Upload the signed form'}
              <input type="file" accept=".xlsx,.pdf" className="hcert-hidden" disabled={!!busy || !!pdf} onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) upload(file);
              }} />
            </label>
          )}
          {canESign && !signing && !pdf && (
            <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => { setSigning(true); setResult(null); }}>
              {form ? 'Fill in and sign again here' : 'Fill in and sign here'}
              {!esignOpen && <span className="sy-badge sy-badge-info hcert-esign-badge">Pending approval</span>}
            </button>
          )}
          {form && (
            <>
              <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={open}>
                {busy === 'open' ? 'Please wait…' : isPdf(form) ? 'View the signed PDF' : form.electronic ? 'Open the signed file' : 'Open the uploaded file'}
              </button>
              <button type="button" className="btn btn-secondary" aria-expanded={showRows} onClick={() => setShowRows(s => !s)}>
                {showRows ? 'Hide what was read' : 'Show what was read'}
              </button>
              {isSuperUser && !locked && !rejecting && (
                <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setRejecting(true)}>Send back</button>
              )}
            </>
          )}
        </div>
      )}

      {error && <div className="sy-error" role="alert">{error}</div>}
      {result && (
        <div className="sy-success" role="status">
          The form was read: {count(result.certified ?? 0, 'certification was', 'certifications were')} recorded
          {(result.new_issues ?? []).length > 0 && `, and ${count(result.new_issues!.length, 'entity was', 'entities were')} answered as incorrect. Add the supporting documents below`}.
          {(result.warnings ?? []).length > 0 && <ul className="hcert-missing">{result.warnings!.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </div>
      )}
      {rejecting && form && (
        <ReasonForm heading={`Send back the ${title.toLowerCase()}`} action="Send back"
          text="The form and what it certified stop counting. The agency downloads, signs and uploads the form again."
          busy={busy === 'reject'} error={error} onSubmit={reject} onCancel={() => { setRejecting(false); setError(''); }} />
      )}
      {(signing || pdf) && (
        <ESignForm kind={item.kind} formName={title} party={party} pdf={pdf ?? undefined}
          onCancel={() => { setSigning(false); setPdf(null); }}
          onSigned={d => {
            const fromPdf = !!pdf;
            setSigning(false);
            setPdf(null);
            setResult(d);
            onChanged(fromPdf ? `The signed PDF of the ${title} was received.` : `The ${title} was signed electronically.`);
          }} />
      )}
      {showRows && form && <FormRowsTable rows={item.rows} />}
    </section>
  );
}

/** The supporting documents of the entities answered as incorrect. */
function IssueDocuments({ party, locked, refreshKey, onChanged }: {
  party: HcmParty;
  locked: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const { mock, email, canWrite, isSuperUser } = useHcm();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [working, setWorking] = useState<{ id: number; text: string } | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const d = await apiGet<IssuesResult>('cert_issues', { mock, email, source: party.source, agency: party.agency });
    if (request !== latest.current) return;
    setFailed(!d.ok);
    if (d.ok) setIssues(d.issues ?? []);
  }, [mock, email, party.source, party.agency]);

  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load, refreshKey]);

  const mine = (author?: string | null) => isSuperUser || (author || '').toLowerCase() === email.toLowerCase();
  const canAdd = canWrite;   // documents can still be added after the signature

  const addDocuments = async (issue: Issue, files: File[]) => {
    const target = { actor: email, mock, source: party.source, agency: party.agency, cert_type: 'ISSUE', cert_key: String(issue.id) };
    const problems: string[] = [];
    let added = 0;
    setError('');
    for (const file of files) {
      if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
        problems.push(`${file.name} is ${file.size === 0 ? 'empty' : formatSize(file.size)}. The limit is 25 MB.`);
        continue;
      }
      const failedText = `${file.name} could not be uploaded. Please try again.`;
      setWorking({ id: issue.id, text: `Uploading ${file.name}…` });
      const up = await post<LinkResult>('cert_upload_url', {
        ...target, file_name: file.name, content_type: file.type || 'application/octet-stream', size: file.size,
      });
      if (!up.ok || !up.url || !up.key) {
        problems.push(agencyProblem(up, failedText));
        continue;
      }
      try {
        const put = await fetch(up.url, {
          method: 'PUT', headers: { 'Content-Type': up.content_type || file.type || 'application/octet-stream' }, body: file,
        });
        if (!put.ok) throw new Error(String(put.status));
      } catch {
        problems.push(failedText);
        continue;
      }
      const d: Written<DocumentAdded> = await post<DocumentAdded>('cert_attachment_add', { ...target, key: up.key, file_name: file.name });
      if (!d.ok) {
        problems.push(agencyProblem(d, failedText));
        continue;
      }
      added += 1;
    }
    setWorking(null);
    if (problems.length > 0) setError(problems.join(' '));
    if (added > 0) {
      await load();
      onChanged();
    }
  };

  const removeDocument = async (a: Attachment, issue: Issue) => {
    if (!window.confirm(`Remove ${a.file_name}?`)) return;
    setWorking({ id: issue.id, text: `Removing ${a.file_name}…` });
    setError('');
    const d = await post<ApiResult>('cert_attachment_delete', { actor: email, id: a.id });
    setWorking(null);
    if (!d.ok) {
      setError(agencyProblem(d, `${a.file_name} could not be removed. Please try again in a moment.`));
      return;
    }
    await load();
    onChanged();
  };

  if (issues === null) return failed ? <div className="sy-error">The supporting documents could not be loaded. <button type="button" className="sy-link" onClick={load}>Try again</button></div> : null;
  if (issues.length === 0) return null;
  const missing = issues.filter(i => (i.attachments ?? []).length === 0).length;
  return (
    <>
      <h2 className="hcm-section">Supporting documents</h2>
      <p className="hcert-note">
        Every entity answered &quot;Se verificó la data y la misma está parcial o completamente incorrecta&quot; needs at least one supporting document.
        {missing > 0 && ` ${count(missing, 'entity is', 'entities are')} still missing one.`}
      </p>
      {error && <div className="sy-error" role="alert">{error}</div>}
      <ol className="hcert-issues">
        {issues.map(issue => (
          <li key={issue.id} className="hcert-issue">
            <div className="hcert-issue-head">
              <span>{issue.description}</span>
              {(issue.attachments ?? []).length === 0
                ? <span className="sy-badge sy-badge-warn">Document needed</span>
                : <span className="sy-badge sy-badge-ok">{count(issue.attachments!.length, 'document', 'documents')}</span>}
            </div>
            <Documents items={issue.attachments ?? []} email={email} staff={false} disabled={!!working || locked}
              empty="No document yet." canRemove={a => !locked && mine(a.uploaded_by)} onRemove={a => removeDocument(a, issue)} />
            {canAdd && (
              <label className="sy-field">
                <span>Add supporting documents (up to 25 MB each)</span>
                <input type="file" multiple disabled={!!working} onChange={e => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length > 0) addDocuments(issue, files);
                }} />
              </label>
            )}
            {working?.id === issue.id && <p className="hcert-note" role="status">{working.text}</p>}
            {issue.reported_at && <p className="hcert-note">Reported on {day(issue.reported_at)}</p>}
          </li>
        ))}
      </ol>
    </>
  );
}

export default function FormsStep({ party, locked, focus, onChanged, onSigner }: {
  party: HcmParty;
  locked: boolean;
  focus: { record: string; n: number } | null;   // show the form that certifies this record (n: each request)
  onChanged: (message: string) => void;
  onSigner: (signer: { name: string; title: string }) => void;   // what the latest form says in its signature block
}) {
  const { mock, email, canWrite, isSuperUser } = useHcm();
  const [kinds, setKinds] = useState<FormKind[] | null>(null);
  const [esignOpen, setESignOpen] = useState(false);
  const [focusKind, setFocusKind] = useState('');
  const shownFocus = useRef(0);
  const [failed, setFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const d = await apiGet<FormStatus>('certform_status', { mock, email, source: party.source, agency: party.agency });
    if (request !== latest.current) return;
    setFailed(!d.ok);
    if (!d.ok) return;
    const items = d.kinds ?? [];
    setKinds(items);
    setESignOpen(!!d.esign_open);
    const signed = items.map(k => k.form).filter((f): f is FormInfo => !!f && !!f.signer_name)
      .sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''))[0];
    if (signed) onSigner({ name: signed.signer_name || '', title: signed.signer_title || '' });
  }, [mock, email, party.source, party.agency, onSigner]);

  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load]);

  // Bring the card that certifies the chosen record into view, once per request.
  useEffect(() => {
    if (!focus || !kinds || shownFocus.current === focus.n) return;
    shownFocus.current = focus.n;
    const kind = kinds.find(k => k.records.some(r => recordKey(r) === focus.record))?.kind || '';
    setFocusKind(kind);
    const target = document.getElementById(kind ? `hcert-card-${kind}` : 'hcert-forms');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (kind) document.getElementById(`hcert-form-${kind}`)?.focus({ preventScroll: true });
  }, [focus, kinds]);

  const changed = (message: string) => {
    onChanged(message);
    setRefreshKey(k => k + 1);
    load();
  };

  if (!kinds) {
    return failed ? (
      <div className="sy-error">The certification forms could not be loaded. <button type="button" className="sy-link" onClick={load}>Try again</button></div>
    ) : <p className="hcm-loading">Loading…</p>;
  }
  if (kinds.length === 0) return <div className="hcm-empty"><p>No certification form is required from you in this cycle.</p></div>;
  return (
    <>
      <ol className="hcert-howto">
        <li><strong>Download</strong> each form below. Your agency is already filled in.</li>
        <li>In Excel, enter the <strong>Agency Resource</strong> and choose a <strong>Comment</strong> for every data entity.</li>
        <li>Complete the signature block (<strong>Signature, Name, Title, Date</strong>) and save the file.</li>
        <li><strong>Upload</strong> the saved Excel file here. The portal reads your answers and keeps the file. If you signed on paper,
          upload a PDF of the signed form instead; the portal then asks you to record its answers.</li>
      </ol>
      {canWrite && !locked && (esignOpen || isSuperUser) && (
        <p className="hcert-note">
          Or choose <strong>Fill in and sign here</strong> on a form: answer the same rows in the portal and sign electronically
          with your name and title, without Excel.{!esignOpen && ' Pending approval: only the validation team sees this option for now.'}
        </p>
      )}
      {kinds.map(k => (
        <FormCard key={k.kind} item={k} party={party} locked={locked} esignOpen={esignOpen} focused={k.kind === focusKind}
          onChanged={changed} />
      ))}
      <IssueDocuments party={party} locked={locked} refreshKey={refreshKey} onChanged={() => onChanged('')} />
    </>
  );
}
