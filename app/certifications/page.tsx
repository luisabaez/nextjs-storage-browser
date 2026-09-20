'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import '../lib/symphony.css';
import './certifications.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import { apiGet, apiPost, ApiResult, fmtDateTime, ROLE_LABEL, useSymphonySession } from '../lib/symphony';

Amplify.configure(config);

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type CertType = 'FILE' | 'VALIDATION';
type PartyStatus = 'Complete' | 'In progress' | 'Not started';

interface Party { source: string; agency: string; bu: string; party: string }
interface ExpectedRow extends Party {
  pillar: string; file_type: string; entity: string; module: string; response: string; comments: string;
  certification_applicable: string; certified: boolean; certified_by: string | null; certified_at: string | null;
  notes: string | null; attachments: number;
}
interface Unavailable { available: boolean; mock: string; db: string; message?: string; mocks_with_table?: string[]; warnings?: string[] }
interface ExpectedResponse extends ApiResult, Unavailable { parties?: Party[]; rows?: ExpectedRow[] }
interface ValidationRow {
  validation_code: string; count: number; message: string | null; message_spa: string | null; entity: string | null;
  type: string | null; severity: string | null; guidance: string | null; certified: boolean;
  path_forward: string | null; notes: string | null; certified_by: string | null; certified_at: string | null;
  certified_count: number | null; attachments: number;
}
interface ValidationsResponse extends ApiResult { mock: string; party: string; validations: ValidationRow[]; warnings: string[] }
interface Attachment { id: number; file_name: string; size: number | null; uploaded_by: string | null; uploaded_at: string | null }
interface AttachmentsResponse extends ApiResult { attachments: Attachment[] }
interface UploadUrlResponse extends ApiResult { key: string; url: string; content_type: string }
interface AttachmentAddResponse extends ApiResult { id: number; file_name: string; size: number }
interface DownloadUrlResponse extends ApiResult { id: number; file_name: string; url: string }
interface StatusTotals {
  parties: number; files_required: number; files_certified: number; validations_reported: number;
  validations_certified: number; pct_complete: number;
}
interface StatusParty extends Party {
  files_required: number; files_certified: number; validations_reported: number; validations_certified: number;
  pct: number; last_activity: string | null; status: PartyStatus;
}
interface StatusResponse extends ApiResult, Unavailable { totals?: StatusTotals; parties?: StatusParty[] }
interface ReportResponse extends ApiResult { key: string; name: string; url: string }
interface UploadState { name: string; state: string; error?: string }

// Case-insensitive, like the server's party grouping.
const partyKey = (p: Party) => [p.source, p.agency, p.bu].map(s => (s || '').trim().toUpperCase()).join('|');
const partyLabel = (p: Party) => `${p.party} · ${p.source} · BU ${p.bu || '—'}`;
const fmtSize = (n: number | null) =>
  n == null ? '' : n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const statusBadge = (s: PartyStatus) => (s === 'Complete' ? 'sy-badge-ok' : s === 'In progress' ? 'sy-badge-warn' : 'sy-badge-bad');

function NotAvailable({ info, onSwitch }: { info: Unavailable; onSwitch: (mock: string) => void }) {
  return (
    <section className="sy-card">
      <h2>Certifications are not available for {info.mock}</h2>
      <p className="sy-muted">{info.message}</p>
      {!!info.warnings?.length && <ul className="sy-warnings">{info.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {!!info.mocks_with_table?.length && (
        <>
          <p className="small sy-muted">Cycles that have certifications set up:</p>
          <div className="cert-switch">
            {info.mocks_with_table.map(m => (
              <button key={m} className="btn btn-secondary" onClick={() => onSwitch(m)}>{m}</button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Attachments({ email, isSuperUser, mock, party, certType, certKey, onChanged }: {
  email: string; isSuperUser: boolean; mock: string; party: Party; certType: CertType; certKey: string; onChanged: () => void;
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { source, agency, bu } = party;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiGet<AttachmentsResponse>('cert_attachments', {
      mock, email, source, agency, bu, cert_type: certType, cert_key: certKey,
    });
    if (res.ok) { setItems(res.attachments); setError(''); } else setError(res.error || 'Could not load the attachments');
    setLoading(false);
  }, [mock, email, source, agency, bu, certType, certKey]);

  useEffect(() => { load(); }, [load]);

  const addFiles = async (files: File[]) => {
    const ids = { actor: email, mock, source, agency, bu, cert_type: certType, cert_key: certKey };
    const mark = (i: number, state: string, err?: string) =>
      setUploads(prev => prev.map((u, j) => (j === i ? { ...u, state, error: err } : u)));
    setBusy(true);
    setUploads(files.map(f => ({ name: f.name, state: 'Waiting' })));
    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_ATTACHMENT_BYTES) { mark(i, 'Failed', 'Larger than the 25 MB limit'); continue; }
      mark(i, 'Requesting upload…');
      const up = await apiPost<UploadUrlResponse>('cert_upload_url', {
        ...ids, file_name: file.name, content_type: file.type || 'application/octet-stream', size: file.size,
      });
      if (!up.ok) { mark(i, 'Failed', up.error); continue; }
      mark(i, 'Uploading…');
      try {
        const put = await fetch(up.url, { method: 'PUT', headers: { 'Content-Type': up.content_type }, body: file });
        if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      } catch (e) {
        mark(i, 'Failed', (e as Error).message);
        continue;
      }
      mark(i, 'Saving…');
      const add = await apiPost<AttachmentAddResponse>('cert_attachment_add', { ...ids, key: up.key, file_name: file.name });
      if (!add.ok) { mark(i, 'Failed', add.error); continue; }
      mark(i, 'Attached');
      added++;
    }
    setBusy(false);
    if (added) { await load(); onChanged(); }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) addFiles(files);
  };

  const download = async (a: Attachment) => {
    const res = await apiGet<DownloadUrlResponse>('cert_download_url', { id: a.id, email });
    // Served as an attachment: downloads in place, no pop-up to block.
    if (res.ok) window.location.assign(res.url); else setError(res.error || 'Could not open the attachment');
  };

  const remove = async (a: Attachment) => {
    if (!window.confirm(`Remove ${a.file_name} from this certification?`)) return;
    const res = await apiPost<ApiResult>('cert_attachment_delete', { actor: email, id: a.id });
    if (!res.ok) { setError(res.error || 'Could not remove the attachment'); return; }
    await load();
    onChanged();
  };

  const canRemove = (a: Attachment) => isSuperUser || (a.uploaded_by || '').toLowerCase() === email.toLowerCase();

  return (
    <div className="cert-attach">
      <div className="cert-attach-head">
        <span>Documents and attachments ({items.length})</span>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading…' : 'Add files'}
        </button>
        <input ref={inputRef} type="file" multiple hidden onChange={onPick} />
      </div>
      {error && <div className="sy-error">{error}</div>}
      {loading ? <p className="sy-muted small">Loading…</p> : items.length === 0 ? (
        <p className="sy-muted small">Nothing attached yet. Files up to 25 MB each.</p>
      ) : (
        <ul className="cert-attach-list">
          {items.map(a => (
            <li key={a.id}>
              <button type="button" className="sy-link" onClick={() => download(a)}>{a.file_name}</button>
              <span className="sy-muted small">{fmtSize(a.size)} · {a.uploaded_by || '—'} · {fmtDateTime(a.uploaded_at)}</span>
              {canRemove(a) && <button type="button" className="sy-link small" onClick={() => remove(a)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {uploads.length > 0 && (
        <ul className="cert-attach-list">
          {uploads.map((u, i) => (
            <li key={i} className={u.error ? 'cert-upload-err' : u.state === 'Attached' ? 'cert-upload-ok' : 'sy-muted'}>
              <span>{u.name}</span><span className="small">{u.state}{u.error ? ` — ${u.error}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CertifyTab({ email, isSuperUser, mock, onSwitchMock }: {
  email: string; isSuperUser: boolean; mock: string; onSwitchMock: (mock: string) => void;
}) {
  const [data, setData] = useState<ExpectedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState('');
  const [validations, setValidations] = useState<ValidationsResponse | null>(null);
  const [loadingValidations, setLoadingValidations] = useState(false);
  const [openFile, setOpenFile] = useState<number | null>(null);
  const [openCode, setOpenCode] = useState('');
  const [notes, setNotes] = useState('');
  const [pathForward, setPathForward] = useState('');
  const [saving, setSaving] = useState(false);

  const expectedSeq = useRef(0);
  const validationsSeq = useRef(0);

  const loadExpected = useCallback(async () => {
    const mine = ++expectedSeq.current;
    setLoading(true);
    const res = await apiGet<ExpectedResponse>('cert_expected', { mock, email });
    if (mine !== expectedSeq.current) return;   // a newer request (another cycle) superseded this one
    if (res.ok) { setData(res); setError(''); } else { setData(null); setError(res.error || 'Could not load the certifications'); }
    setLoading(false);
  }, [mock, email]);

  useEffect(() => {
    setData(null); setOpenFile(null); setOpenCode(''); setMessage(''); setValidations(null);
    loadExpected();
  }, [loadExpected]);

  const parties = data?.parties || [];
  const party: Party | undefined = parties.find(p => partyKey(p) === selected) || parties[0];
  const source = party?.source || '';
  const agency = party?.agency || '';
  const bu = party?.bu || '';

  const loadValidations = useCallback(async () => {
    const mine = ++validationsSeq.current;
    if (!source) { setValidations(null); return; }
    setLoadingValidations(true);
    const res = await apiGet<ValidationsResponse>('cert_validations', { mock, email, source, agency, bu });
    if (mine !== validationsSeq.current) return;
    if (res.ok) setValidations(res); else { setValidations(null); setError(res.error || 'Could not load the validations'); }
    setLoadingValidations(false);
  }, [mock, email, source, agency, bu]);

  useEffect(() => { loadValidations(); }, [loadValidations]);

  if (!data) return error ? <div className="sy-error">{error}</div> : <p className="sy-muted">Loading…</p>;
  if (!data.available) return <NotAvailable info={data} onSwitch={onSwitchMock} />;

  const files = party ? (data?.rows || []).filter(r => partyKey(r) === partyKey(party)) : [];
  const reported = validations?.validations || [];
  const warnings = [...(data?.warnings || []), ...(validations?.warnings || [])];
  const ids = { actor: email, mock, source, agency, bu };

  // The previous party's validations leave the screen at once, so nothing can be
  // certified against them while the new party loads.
  const pickParty = (key: string) => { setSelected(key); setValidations(null); setOpenFile(null); setOpenCode(''); setMessage(''); setError(''); };
  const closeForms = () => { setOpenFile(null); setOpenCode(''); };

  const certifyFile = async (row: ExpectedRow) => {
    setSaving(true); setMessage(''); setError('');
    const res = await apiPost<ApiResult>('cert_certify_file', { ...ids, entity: row.entity, file_type: row.file_type, notes });
    setSaving(false);
    if (!res.ok) { setError(res.error || 'The certification was not saved'); return; }
    setMessage(`${row.entity} (${row.file_type}) certified for ${party?.party}.`);
    closeForms();
    loadExpected();
  };

  // Super users can withdraw a certification made by mistake; the record stays
  // as history with who revoked it and why.
  const revoke = async (certType: CertType, certKey: string, label: string) => {
    const reason = window.prompt(`Revoke the certification of ${label} for ${party?.party}?

Reason (required):`);
    if (!reason || !reason.trim()) return;
    setSaving(true); setMessage(''); setError('');
    const res = await apiPost<ApiResult>('cert_revoke', { ...ids, cert_type: certType, cert_key: certKey, reason: reason.trim() });
    setSaving(false);
    if (!res.ok) { setError(res.error || 'The certification was not revoked'); return; }
    setMessage(`Certification of ${label} revoked.`);
    closeForms();
    if (certType === 'FILE') loadExpected(); else loadValidations();
  };

  const certifyValidation = async (row: ValidationRow) => {
    setSaving(true); setMessage(''); setError('');
    const res = await apiPost<ApiResult>('cert_certify_validation', {
      ...ids, validation_code: row.validation_code, path_forward: pathForward, notes,
    });
    setSaving(false);
    if (!res.ok) { setError(res.error || 'The certification was not saved'); return; }
    setMessage(`${row.validation_code} certified for ${party?.party}.`);
    closeForms();
    loadValidations();
  };

  return (
    <>
      <section className="sy-controls">
        <label>
          Source / Agency
          <select value={party ? partyKey(party) : ''} onChange={e => pickParty(e.target.value)} disabled={parties.length === 0}>
            {parties.length === 0 && <option value="">No certifications assigned to you</option>}
            {parties.map(p => <option key={partyKey(p)} value={partyKey(p)}>{partyLabel(p)}</option>)}
          </select>
        </label>
        {party && (
          <span className="sy-total">
            {files.filter(f => f.certified).length} of {files.length} files · {reported.filter(v => v.certified).length} of {reported.length} validations certified
          </span>
        )}
      </section>

      {error && <div className="sy-error">{error}</div>}
      {message && <div className="sy-success">{message}</div>}
      {warnings.length > 0 && <ul className="sy-warnings">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {data && parties.length === 0 && (
        <div className="sy-note">No certification is required from the sources, agencies or business units you are allowed to act for in {mock}.</div>
      )}

      {party && (
        <section className="sy-card">
          <div className="sy-card-head">
            <h2>Files requiring certification</h2>
            <span className="sy-total">{files.length} required</span>
          </div>
          <div className="sy-scroll">
            <table className="sy-table">
              <thead>
                <tr>
                  <th>Entity</th><th>File type</th><th>Pillar</th><th>Module</th><th>Response</th><th>Status</th>
                  <th>Certified by</th><th className="num">Attachments</th><th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f, i) => (
                  <React.Fragment key={`${f.entity}|${f.file_type}|${i}`}>
                    <tr className={openFile === i ? 'sy-selected' : undefined}>
                      <td className="mono">{f.entity}</td>
                      <td>{f.file_type}</td>
                      <td>{f.pillar}</td>
                      <td>{f.module}</td>
                      <td title={f.comments || undefined}>{f.response || '—'}</td>
                      <td><span className={`sy-badge ${f.certified ? 'sy-badge-ok' : 'sy-badge-warn'}`}>{f.certified ? 'Certified' : 'Pending'}</span></td>
                      <td className="small">{f.certified ? <>{f.certified_by}<br /><span className="sy-muted">{fmtDateTime(f.certified_at)}</span></> : '—'}</td>
                      <td className="num">{f.attachments}</td>
                      <td>
                        <button className="sy-link" onClick={() => {
                          if (openFile === i) { closeForms(); return; }
                          setOpenCode(''); setOpenFile(i); setNotes(f.notes || ''); setMessage('');
                        }}>{openFile === i ? 'Close' : f.certified ? 'Re-certify' : 'Certify'}</button>
                        {isSuperUser && f.certified && (
                          <> · <button className="sy-link" disabled={saving}
                            onClick={() => revoke('FILE', `${f.entity}|${f.file_type}`, `${f.entity} (${f.file_type})`)}>Revoke</button></>
                        )}
                      </td>
                    </tr>
                    {openFile === i && (
                      <tr className="cert-form-row">
                        <td colSpan={9}>
                          <div className="cert-form">
                            {f.comments && <div className="cert-form-meta">Comments from the validation team: {f.comments}</div>}
                            <label className="sy-field">
                              Notes (required)
                              <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="What was reviewed and what is being certified" />
                            </label>
                            <Attachments email={email} isSuperUser={isSuperUser} mock={mock} party={party} certType="FILE"
                              certKey={`${f.entity}|${f.file_type}`} onChanged={loadExpected} />
                            <div className="sy-actions">
                              <button className="btn btn-secondary" onClick={closeForms} disabled={saving}>Cancel</button>
                              <button className="btn btn-primary" disabled={saving || !notes.trim()} onClick={() => certifyFile(f)}>
                                {saving ? 'Saving…' : f.certified ? 'Re-certify file' : 'Certify file'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {party && (
        <section className="sy-card">
          <div className="sy-card-head">
            <h2>Validations reported to the agency</h2>
            <span className="sy-total">{reported.reduce((n, v) => n + v.count, 0).toLocaleString()} records across {reported.length} validation codes</span>
          </div>
          {loadingValidations && !validations ? <p className="sy-muted">Loading…</p> : reported.length === 0 ? (
            <p className="sy-muted">The Data Cleanse Log reports no validations to {party.party} for {mock}.</p>
          ) : (
            <div className="sy-scroll">
              <table className="sy-table">
                <thead>
                  <tr>
                    <th>Code</th><th>Message</th><th>Type</th><th>Severity</th><th className="num">Count</th><th>Guidance</th>
                    <th>Status</th><th className="num">Attachments</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {reported.map(v => (
                    <React.Fragment key={v.validation_code}>
                      <tr className={openCode === v.validation_code ? 'sy-selected' : undefined}>
                        <td className="mono">{v.validation_code}</td>
                        <td className="cert-message" title={v.message_spa || undefined}>{v.message || '—'}</td>
                        <td>{v.type || '—'}</td>
                        <td>{v.severity ? <span className={`sy-sev sy-sev-${v.severity.toLowerCase()}`}>{v.severity}</span> : '—'}</td>
                        <td className="num">
                          {v.count.toLocaleString()}
                          {v.certified && v.certified_count != null && v.certified_count !== v.count && (
                            <div className="sy-muted small">{v.certified_count.toLocaleString()} when certified</div>
                          )}
                        </td>
                        <td className="cert-guidance small">{v.guidance || '—'}</td>
                        <td>
                          <span className={`sy-badge ${v.certified ? 'sy-badge-ok' : 'sy-badge-warn'}`}>{v.certified ? 'Certified' : 'Pending'}</span>
                          {v.certified && <div className="sy-muted small">{v.certified_by} · {fmtDateTime(v.certified_at)}</div>}
                        </td>
                        <td className="num">{v.attachments}</td>
                        <td>
                          <button className="sy-link" onClick={() => {
                            if (openCode === v.validation_code) { closeForms(); return; }
                            setOpenFile(null); setOpenCode(v.validation_code); setMessage('');
                            setPathForward(v.path_forward || ''); setNotes(v.notes || '');
                          }}>{openCode === v.validation_code ? 'Close' : v.certified ? 'Re-certify' : 'Certify'}</button>
                          {isSuperUser && v.certified && (
                            <> · <button className="sy-link" disabled={saving}
                              onClick={() => revoke('VALIDATION', v.validation_code, v.validation_code)}>Revoke</button></>
                          )}
                        </td>
                      </tr>
                      {openCode === v.validation_code && (
                        <tr className="cert-form-row">
                          <td colSpan={9}>
                            <div className="cert-form">
                              {v.message_spa && <div className="cert-form-meta">{v.message_spa}</div>}
                              <div className="sy-form-grid">
                                <label className="sy-field">
                                  Path forward (required)
                                  <textarea value={pathForward} onChange={e => setPathForward(e.target.value)}
                                    placeholder={v.guidance || 'How the agency will resolve or accept the records reported by this validation'} />
                                </label>
                                <label className="sy-field">
                                  Note (required)
                                  <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Certification note" />
                                </label>
                              </div>
                              <Attachments email={email} isSuperUser={isSuperUser} mock={mock} party={party} certType="VALIDATION"
                                certKey={v.validation_code} onChanged={loadValidations} />
                              <div className="sy-actions">
                                <button className="btn btn-secondary" onClick={closeForms} disabled={saving}>Cancel</button>
                                <button className="btn btn-primary" disabled={saving || !notes.trim() || !pathForward.trim()} onClick={() => certifyValidation(v)}>
                                  {saving ? 'Saving…' : v.certified ? 'Re-certify validation' : 'Certify validation'}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function StatusTab({ email, mock, onSwitchMock }: { email: string; mock: string; onSwitchMock: (mock: string) => void }) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'' | PartyStatus>('');
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState<ReportResponse | null>(null);

  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const res = await apiGet<StatusResponse>('cert_status', { mock, email });
    if (mine !== seq.current) return;
    if (res.ok) { setData(res); setError(''); } else { setData(null); setError(res.error || 'Could not load the certification status'); }
    setLoading(false);
  }, [mock, email]);

  useEffect(() => { setData(null); setReport(null); load(); }, [load]);

  const generate = async () => {
    setGenerating(true); setError('');
    const res = await apiPost<ReportResponse>('cert_status_report', { actor: email, mock });
    setGenerating(false);
    if (!res.ok) { setError(res.error || 'The status report was not generated'); return; }
    setReport(res);
    window.location.assign(res.url);
  };

  if (!data) return error ? <div className="sy-error">{error}</div> : <p className="sy-muted">Loading…</p>;
  if (!data.available) return <NotAvailable info={data} onSwitch={onSwitchMock} />;

  const totals = data?.totals;
  const parties = (data?.parties || []).filter(p => !filter || p.status === filter);

  return (
    <>
      {error && <div className="sy-error">{error}</div>}
      {!!data?.warnings?.length && <ul className="sy-warnings">{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {report && (
        <div className="sy-success">
          Status report generated: <a href={report.url} target="_blank" rel="noopener noreferrer">{report.name}</a>
        </div>
      )}
      {totals && (
        <div className="sy-stats">
          <div className="sy-stat"><div className="sy-stat-num">{totals.pct_complete}%</div><div className="sy-stat-label">Complete</div></div>
          <div className="sy-stat"><div className="sy-stat-num">{totals.parties}</div><div className="sy-stat-label">Sources / agencies</div></div>
          <div className="sy-stat"><div className="sy-stat-num">{totals.files_certified} / {totals.files_required}</div><div className="sy-stat-label">Files certified</div></div>
          <div className="sy-stat"><div className="sy-stat-num">{totals.validations_certified} / {totals.validations_reported}</div><div className="sy-stat-label">Validations certified</div></div>
        </div>
      )}
      <section className="sy-card">
        <div className="sy-card-head">
          <h2>Certification status by source / agency</h2>
          <div className="sy-card-tools">
            <label className="sy-check">
              Status
              <select className="sy-input" value={filter} onChange={e => setFilter(e.target.value as '' | PartyStatus)}>
                <option value="">All</option>
                <option value="Complete">Complete</option>
                <option value="In progress">In progress</option>
                <option value="Not started">Not started</option>
              </select>
            </label>
            <button className="btn btn-secondary" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
            <button className="btn btn-primary" onClick={generate} disabled={generating || !data}>{generating ? 'Generating…' : 'Generate status report'}</button>
          </div>
        </div>
        <div className="sy-scroll">
          <table className="sy-table">
            <thead>
              <tr>
                <th>Source / Agency</th><th>Source</th><th>BU</th><th className="num">Files</th><th className="num">Validations</th>
                <th>Progress</th><th>Status</th><th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {parties.map(p => (
                <tr key={partyKey(p)}>
                  <td>{p.party}</td>
                  <td className="mono">{p.source}</td>
                  <td className="mono">{p.bu || '—'}</td>
                  <td className="num">{p.files_certified} / {p.files_required}</td>
                  <td className="num">{p.validations_certified} / {p.validations_reported}</td>
                  <td><div className="cert-progress"><div className="sy-progress"><span style={{ width: `${p.pct}%` }} /></div><span className="small">{p.pct}%</span></div></td>
                  <td><span className={`sy-badge ${statusBadge(p.status)}`}>{p.status}</span></td>
                  <td className="small">{fmtDateTime(p.last_activity)}</td>
                </tr>
              ))}
              {parties.length === 0 && <tr><td colSpan={8} className="sy-muted">Nothing to show.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function CertificationsPage() {
  const session = useSymphonySession();
  const [tab, setTab] = useState<'' | 'certify' | 'status'>('');

  if (!session.ready) return <main className="sy-page"><p className="sy-muted">Loading…</p></main>;

  if (!session.canCertify && !session.canReview) {
    return (
      <main className="sy-page">
        <div className="sy-denied">
          <h2>Certifications</h2>
          {session.error && <div className="sy-error">{session.error}</div>}
          <p>Your account has no security role for certifications. Ask a super user to assign Agency User or Certification Review to {session.email || 'your account'}.</p>
          <Link href="/" className="btn btn-secondary">← File Browser</Link>
        </div>
      </main>
    );
  }

  const active = tab || (session.canCertify ? 'certify' : 'status');
  const mocks = session.mocks.includes(session.mock) || !session.mock ? session.mocks : [session.mock, ...session.mocks];

  return (
    <main className="sy-page">
      <header className="sy-header">
        <div>
          <h1>Certifications <span className="sy-mock">{session.mock}</span> <span className="sy-pill sy-pill-role">{ROLE_LABEL[session.role]}</span></h1>
          <p className="sy-sub">Certify the files and the validations reported to your source or agency, attach the supporting documents, and follow the certification status of the cycle.</p>
        </div>
        <div className="sy-links">
          <Link href="/" className="btn btn-secondary">← File Browser</Link>
        </div>
      </header>

      {session.error && <div className="sy-error">{session.error}</div>}

      <section className="sy-controls">
        <label>
          Mock cycle
          <select value={session.mock} onChange={e => session.setMock(e.target.value)}>
            {mocks.map(m => <option key={m} value={m}>{m}{m === session.config?.current_mock ? ' (current)' : ''}</option>)}
          </select>
        </label>
      </section>

      <nav className="sy-tabs">
        {session.canCertify && <button className={`sy-tab${active === 'certify' ? ' active' : ''}`} onClick={() => setTab('certify')}>Certify</button>}
        <button className={`sy-tab${active === 'status' ? ' active' : ''}`} onClick={() => setTab('status')}>Certification status</button>
      </nav>

      {session.mock && active === 'certify' && (
        <CertifyTab email={session.email} isSuperUser={session.isSuperUser} mock={session.mock} onSwitchMock={session.setMock} />
      )}
      {session.mock && active === 'status' && <StatusTab email={session.email} mock={session.mock} onSwitchMock={session.setMock} />}
    </main>
  );
}

export default withAuthenticator(CertificationsPage);
