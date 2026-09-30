'use client';

// What the validation team sees on the certifications page: every pending and
// completed certification, the reported issues and the status of each agency.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiResult, apiGet, apiPost, fmtDateTime } from '../../lib/symphony';
import { fileTypeLabel, partyKey, partyLabel, statusBadgeClass, useHcm } from '../HcmShell';
import { FormInfo, FormRow, FormRowsTable, formTitle, openFormFile } from './FormsStep';
import {
  CertRecord, Documents, FOCUS_KEY, Issue, IssuesResult, ReasonForm, ResponseBadge, count, day, partyId, recordKey, recordName,
  responseShort,
} from './shared';

type Tab = 'pending' | 'issues' | 'completed' | 'forms' | 'status';
const TABS: { id: Tab; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'issues', label: 'Reported issues' },
  { id: 'completed', label: 'Completed' },
  { id: 'forms', label: 'Signed forms' },
  { id: 'status', label: 'Status by agency' },
];
const FORM_LABELS: Record<string, string> = { HR: 'HCM-HR', PAYROLL: 'HCM-Payroll', SOURCES: 'Sources' };

interface Records extends ApiResult { records?: CertRecord[] }

interface StatusParty {
  source: string;
  agency: string;
  bu?: string;
  party?: string;
  files_required?: number;
  files_certified?: number;
  with_issues?: number;
  validations_reported?: number;
  validations_certified?: number;
  pct?: number;
  last_activity?: string | null;
  status?: string;               // Complete | In progress | Not started
  signed_off?: boolean;
  signed_by?: string | null;
  signed_at?: string | null;
}
interface StatusTotals {
  parties?: number;
  signed_off?: number;
  with_issues?: number;
  files_required?: number;
  files_certified?: number;
  validations_reported?: number;
  validations_certified?: number;
}
interface Status extends ApiResult { totals?: StatusTotals; parties?: StatusParty[] }
interface Report extends ApiResult { url?: string; name?: string }
interface Forms extends ApiResult { forms?: FormInfo[] }
interface FormRows extends ApiResult { rows?: FormRow[] }

/** One list of the cycle, reloadable; a newer request always wins over an older one. */
function useList<T extends ApiResult>(action: string, state?: string) {
  const { mock, email } = useHcm();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const d = await apiGet<T>(action, { mock, email, state });
    if (request !== latest.current) return;
    setError(d.ok ? '' : d.error || 'The list could not be loaded');
    if (d.ok) setData(d);
  }, [action, mock, email, state]);

  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load]);

  return { data, error, reload: load };
}

/** "RHUM · 018 Junta De Planificacion" for a row, worded like the rest of the portal. */
function usePartyLabels() {
  const { parties } = useHcm();
  const known = useMemo(() => {
    const map = new Map<string, string>();
    parties.forEach(p => map.set(partyId(p), partyLabel(p)));
    return map;
  }, [parties]);
  return useCallback((p: { source: string; agency: string; party?: string }) => known.get(partyId(p)) ?? partyLabel(p), [known]);
}

function LoadProblem({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="sy-error" role="alert">
      {error} <button type="button" className="sy-link" onClick={onRetry}>Try again</button>
    </div>
  );
}

const matches = (search: string, ...values: (string | null | undefined)[]) => {
  const wanted = search.trim().toLowerCase();
  return !wanted || values.some(v => (v || '').toLowerCase().includes(wanted));
};

function RecordsTab({ state }: { state: 'pending' | 'completed' }) {
  const { parties, openParty } = useHcm();
  const { data, error, reload } = useList<Records>('cert_records', state);
  const labelOf = usePartyLabels();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');

  const records = useMemo(() => data?.records ?? [], [data]);
  const sources = useMemo(() => Array.from(new Set(records.map(r => (r.source || '').toUpperCase()))).filter(Boolean).sort(), [records]);
  const completed = state === 'completed';
  const shown = records.filter(r => (!source || (r.source || '').toUpperCase() === source)
    && matches(search, labelOf(r), r.module, r.file_type, r.entity, r.resource_name, r.certified_by,
      completed ? responseShort(r.response_code) : ''));

  // A pending certification opens its agency's view at the form that certifies it (AgencyView reads FOCUS_KEY).
  // Not a query string: changing it remounts the page and would lose the view.
  const openForm = (r: CertRecord) => {
    const p = parties.find(x => partyId(x) === partyId(r));
    if (!p) return;
    try {
      window.sessionStorage.setItem(FOCUS_KEY, recordKey(r));
    } catch {
      // storage unavailable: the agency view opens at its top
    }
    openParty(partyKey(p));
    window.scrollTo(0, 0);
  };

  if (!data) return error ? <LoadProblem error={error} onRetry={reload} /> : <p className="hcm-loading">Loading…</p>;
  return (
    <>
      {error && <LoadProblem error={error} onRetry={reload} />}
      {!completed && records.length > 0 && <p className="hcert-note">Choose a certification to open its agency&apos;s form, where it is signed.</p>}
      <div className="hcert-filters">
        <label className="sy-field">
          <span>Search</span>
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Agency, module, file type, entity…" />
        </label>
        <label className="sy-field">
          <span>Source</span>
          <select value={source} onChange={e => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <p className="hcert-count" role="status">Showing {shown.length.toLocaleString()} of {count(records.length, 'certification', 'certifications')}</p>
      </div>
      {shown.length === 0 ? (
        <div className="hcm-empty">
          <p>
            {records.length > 0 ? 'No certification matches the search.'
              : completed ? 'No certification has been completed in this cycle yet.'
                : 'Nothing is pending. Every certification of this cycle is complete.'}
          </p>
        </div>
      ) : (
        <div className="hcm-card sy-scroll">
          <table className="sy-table">
            <thead>
              <tr>
                <th>Source / Agency</th><th>Module</th><th>File type</th><th>Entity</th>
                {completed && <><th>Response</th><th>Agency resource</th><th>Certified by</th><th>Date</th><th className="num">Issues</th></>}
                {!completed && <th><span className="hcert-hidden">Form</span></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={`${partyId(r)}|${recordKey(r)}`} className={completed ? undefined : 'sy-clickable'}
                  onClick={completed ? undefined : () => openForm(r)}>
                  <td>{labelOf(r)}</td>
                  <td>{r.module || '—'}</td>
                  <td>{fileTypeLabel(r.file_type)}</td>
                  <td>{r.entity}</td>
                  {completed && (
                    <>
                      <td><ResponseBadge code={r.response_code} /></td>
                      <td>{r.resource_name || '—'}</td>
                      <td>{r.certified_by || '—'}</td>
                      <td>{day(r.certified_at) || '—'}</td>
                      <td className="num">{r.issues ?? 0}</td>
                    </>
                  )}
                  {!completed && (
                    <td>
                      <button type="button" className="sy-link hcert-nowrap" onClick={e => { e.stopPropagation(); openForm(r); }}
                        aria-label={`Open the form of ${labelOf(r)} for ${recordName(r)}`}>
                        Open the form
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function IssuesTab() {
  const { email } = useHcm();
  const { data, error, reload } = useList<IssuesResult>('cert_issues');
  const labelOf = usePartyLabels();
  const [search, setSearch] = useState('');

  const issues = useMemo(() => data?.issues ?? [], [data]);
  const shown = issues.filter(i => matches(search, labelOf(i), i.module, i.file_type, i.entity, i.description, i.reported_by,
    ...(i.attachments ?? []).map(a => a.file_name)));
  // One card per certification, its issues inside
  const groups: { id: string; issues: Issue[] }[] = [];
  shown.forEach(i => {
    const id = `${partyId(i)}|${recordKey(i)}`;
    const group = groups.find(g => g.id === id);
    if (group) group.issues.push(i); else groups.push({ id, issues: [i] });
  });

  if (!data) return error ? <LoadProblem error={error} onRetry={reload} /> : <p className="hcm-loading">Loading…</p>;
  return (
    <>
      {error && <LoadProblem error={error} onRetry={reload} />}
      <div className="hcert-filters">
        <label className="sy-field">
          <span>Search</span>
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Agency, entity, description, reporter…" />
        </label>
        <p className="hcert-count" role="status">
          {count(shown.length, 'issue', 'issues')} on {count(groups.length, 'certification', 'certifications')}
        </p>
      </div>
      {groups.length === 0 ? (
        <div className="hcm-empty">
          <p>{issues.length > 0 ? 'No issue matches the search.' : 'No issue has been reported in this cycle.'}</p>
        </div>
      ) : groups.map(g => {
        const first = g.issues[0];
        return (
          <section key={g.id} className="hcm-card">
            <div className="hcm-card-head">
              <h2>{labelOf(first)}</h2>
              <span className={`sy-badge ${first.certified ? 'sy-badge-ok' : 'sy-badge-warn'}`}>
                {first.certified ? 'Certification submitted' : 'Certification not submitted yet'}
              </span>
            </div>
            <p className="hcert-record-name">{recordName(first)}</p>
            <ol className="hcert-issues">
              {g.issues.map((issue, n) => (
                <li key={issue.id} className="hcert-issue">
                  <div className="hcert-issue-head"><span>Issue {n + 1}</span></div>
                  <p className="hcert-text">{issue.description}</p>
                  <p className="hcert-note">
                    {[issue.reported_by && `Reported by ${issue.reported_by}`, day(issue.reported_at)].filter(Boolean).join(' · ')}
                  </p>
                  <Documents items={issue.attachments ?? []} email={email} staff empty="No supporting document." />
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </>
  );
}

/** Every signed form the agencies uploaded: open the file, or read what the portal took from it. */
function FormsTab() {
  const { email } = useHcm();
  const { data, error, reload } = useList<Forms>('certform_list');
  const labelOf = usePartyLabels();
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(0);
  const [rows, setRows] = useState<FormRow[] | null>(null);
  const [busy, setBusy] = useState(0);
  const [problem, setProblem] = useState('');

  const forms = useMemo(() => [...(data?.forms ?? [])].sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || '')), [data]);
  const shown = forms.filter(f => matches(search, labelOf(f), FORM_LABELS[f.kind], f.file_name, f.signer_name, f.uploaded_by));

  const toggle = async (f: FormInfo) => {
    if (openId === f.id) {
      setOpenId(0);
      return;
    }
    setOpenId(f.id);
    setRows(null);
    const d = await apiGet<FormRows>('certform_rows', { id: f.id, email });
    setRows(d.ok ? d.rows ?? [] : []);
    if (!d.ok) setProblem(d.error || 'The rows of the form could not be loaded');
  };
  const open = async (f: FormInfo) => {
    setBusy(f.id);
    setProblem(await openFormFile(f.id, email));
    setBusy(0);
  };

  if (!data) return error ? <LoadProblem error={error} onRetry={reload} /> : <p className="hcm-loading">Loading…</p>;
  return (
    <>
      {error && <LoadProblem error={error} onRetry={reload} />}
      {problem && <div className="sy-error" role="alert">{problem}</div>}
      <div className="hcert-filters">
        <label className="sy-field">
          <span>Search</span>
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Agency, form, signer…" />
        </label>
        <p className="hcert-count" role="status">Showing {shown.length.toLocaleString()} of {count(forms.length, 'signed form', 'signed forms')}</p>
      </div>
      {shown.length === 0 ? (
        <div className="hcm-empty"><p>{forms.length > 0 ? 'No form matches the search.' : 'No signed form has been uploaded in this cycle yet.'}</p></div>
      ) : (
        <ul className="hcm-list">
          {shown.map(f => (
            <li key={f.id} className="hcm-row hcert-record">
              <div className="hcm-row-main">
                <div className="hcm-row-title">{labelOf(f)} · {formTitle(FORM_LABELS[f.kind] || f.kind)}</div>
                <div className="hcm-row-meta">
                  {[
                    f.signer_name && `Signed by ${[f.signer_name, f.signer_title].filter(Boolean).join(', ')}`,
                    f.signed_date,
                    `${f.answered ?? 0} of ${f.rows ?? 0} entities answered`,
                    f.uploaded_by && `${f.electronic ? 'Signed electronically in the portal' : 'Uploaded'} by ${f.uploaded_by} on ${day(f.uploaded_at)}`,
                    !f.signature_image && !f.electronic && 'no signature image',
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="hcm-row-actions">
                <button type="button" className="btn btn-secondary" disabled={busy === f.id} onClick={() => open(f)}
                  aria-label={`Open the file ${f.file_name}`}>
                  {busy === f.id ? 'Please wait…' : 'Open file'}
                </button>
                <button type="button" className="btn btn-secondary" aria-expanded={openId === f.id} onClick={() => toggle(f)}>
                  {openId === f.id ? 'Hide rows' : 'Show rows'}
                </button>
              </div>
              {openId === f.id && (
                <div className="hcert-row-more">
                  {rows === null ? <p className="hcm-loading">Loading…</p> : <FormRowsTable rows={rows} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function StatusTab() {
  const { mock, email, parties, isSuperUser, reloadParties } = useHcm();
  const { data, error, reload } = useList<Status>('cert_status');
  const labelOf = usePartyLabels();
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [revoking, setRevoking] = useState<StatusParty | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState('');

  const download = async () => {
    setDownloading(true);
    setProblem('');
    setNotice('');
    const d = await apiPost<Report>('cert_status_report', { actor: email, mock });
    setDownloading(false);
    if (!d.ok || !d.url) {
      setProblem(d.error || 'The status report could not be created');
      return;
    }
    setNotice(`${d.name || 'The status report'} is downloading.`);
    window.location.assign(d.url);
  };

  const revoke = async (reason: string) => {
    if (!revoking) return;
    setBusy(true);
    setRevokeError('');
    const d = await apiPost<ApiResult>('cert_revoke', {
      actor: email, mock, source: revoking.source, agency: revoking.agency, cert_type: 'SIGNOFF', reason,
    });
    setBusy(false);
    if (!d.ok) {
      setRevokeError(d.error || 'The signature could not be revoked');
      return;
    }
    setNotice(`The signature of ${labelOf(revoking)} was revoked. The agency can change its certifications and sign again.`);
    setRevoking(null);
    reload();
    reloadParties();
  };

  if (!data) return error ? <LoadProblem error={error} onRetry={reload} /> : <p className="hcm-loading">Loading…</p>;

  const t = data.totals ?? {};
  const rows = data.parties ?? [];
  // Who signed (name and title) comes with the parties of the cycle
  const signer = (p: StatusParty) => parties.find(x => partyId(x) === partyId(p))?.signed_off;
  const tiles = [
    { label: 'Sources and agencies', value: `${t.parties ?? rows.length}` },
    { label: 'Signed off', value: `${t.signed_off ?? 0}` },
    { label: 'Certifications with issues', value: `${t.with_issues ?? 0}` },
    { label: 'Certifications done of required', value: `${t.files_certified ?? 0} / ${t.files_required ?? 0}` },
    { label: 'Validations committed of reported', value: `${t.validations_certified ?? 0} / ${t.validations_reported ?? 0}` },
  ];

  return (
    <>
      {error && <LoadProblem error={error} onRetry={reload} />}
      {problem && <div className="sy-error" role="alert">{problem}</div>}
      <div role="status">{notice && <div className="sy-success">{notice}</div>}</div>

      <div className="sy-stats">
        {tiles.map(tile => (
          <div key={tile.label} className="sy-stat">
            <div className="sy-stat-num">{tile.value}</div>
            <div className="sy-stat-label">{tile.label}</div>
          </div>
        ))}
      </div>

      {revoking && (
        <ReasonForm heading={`Revoke the signature of ${labelOf(revoking)}`} action="Revoke signature"
          text="The agency can change its certifications again and signs again when it is done."
          busy={busy} error={revokeError} onSubmit={revoke} onCancel={() => { setRevoking(null); setRevokeError(''); }} />
      )}

      <section className="hcm-card">
        <div className="hcm-card-head">
          <h2>Status by source and agency</h2>
          <button type="button" className="btn btn-primary" disabled={downloading} onClick={download}>
            {downloading ? 'Preparing…' : 'Download status report'}
          </button>
        </div>
        {rows.length === 0 ? <p className="hcert-note">No source or agency has certifications in this cycle.</p> : (
          <div className="sy-scroll">
            <table className="sy-table">
              <thead>
                <tr>
                  <th>Source / Agency</th><th className="num">Certifications</th><th className="num">With issues</th>
                  <th className="num">Validations</th><th>Progress</th><th>Status</th><th>Signature</th><th>Last activity</th>
                  {isSuperUser && <th><span className="hcert-hidden">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(p => {
                  const pct = Math.round(p.pct ?? 0);
                  const status = p.signed_off ? 'Signed off' : p.status === 'Complete' ? 'Ready to sign' : p.status || 'Not started';
                  const who = signer(p);
                  return (
                    <tr key={partyId(p)}>
                      <td>{labelOf(p)}</td>
                      <td className="num">{p.files_certified ?? 0} / {p.files_required ?? 0}</td>
                      <td className="num">{p.with_issues ?? 0}</td>
                      <td className="num">{p.validations_certified ?? 0} / {p.validations_reported ?? 0}</td>
                      <td>
                        <div className="hcert-progress">
                          <div className="sy-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
                            aria-label={`Progress of ${labelOf(p)}`}>
                            <span style={{ width: `${pct}%` }} />
                          </div>
                          <span>{pct}%</span>
                        </div>
                      </td>
                      <td><span className={statusBadgeClass(status)}>{status}</span></td>
                      <td>
                        {p.signed_off ? (
                          <>
                            {who?.name || p.signed_by || '—'}{who?.title ? `, ${who.title}` : ''}
                            <div className="sy-muted">{fmtDateTime(p.signed_at).slice(0, 16)}</div>
                          </>
                        ) : '—'}
                      </td>
                      <td>{p.last_activity ? fmtDateTime(p.last_activity).slice(0, 16) : '—'}</td>
                      {isSuperUser && (
                        <td>
                          {p.signed_off && (
                            <button type="button" className="sy-link" onClick={() => { setRevoking(p); setRevokeError(''); setNotice(''); }}
                              aria-label={`Revoke the signature of ${labelOf(p)}`}>
                              Revoke signature
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export default function StaffView() {
  const [tab, setTab] = useState<Tab>('pending');
  return (
    <>
      <nav className="sy-tabs" aria-label="Certification lists">
        {TABS.map(t => (
          <button key={t.id} type="button" className={`sy-tab${tab === t.id ? ' active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'pending' && <RecordsTab key="pending" state="pending" />}
      {tab === 'completed' && <RecordsTab key="completed" state="completed" />}
      {tab === 'issues' && <IssuesTab />}
      {tab === 'forms' && <FormsTab />}
      {tab === 'status' && <StatusTab />}
    </>
  );
}
