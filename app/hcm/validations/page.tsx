'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import Link from 'next/link';
import { ApiResult, LAMBDA_URL, apiGet, fmtDateTime } from '../../lib/symphony';
import HcmShell, { partyLabel, useHcm } from '../HcmShell';
import RecordsTable from '../RecordsTable';
import './validations.css';

Amplify.configure(config);

interface Validation {
  validation_code: string;
  count?: number | null;
  message?: string | null; message_spa?: string | null;
  entity?: string | null; type?: string | null; severity?: string | null;
  path_forward?: string | null;
  committed?: boolean; reviewed?: boolean;
  target_date?: string | null; notes?: string | null;
  committed_by?: string | null; committed_at?: string | null;
}
interface ValidationList extends ApiResult { validations?: Validation[]; warnings?: string[] }
interface Commitment { reviewed: boolean; targetDate: string; notes: string }
type Filter = 'pending' | 'all';

const COLUMNS = 7;
const clean = (v: string | null | undefined) => (v ?? '').trim();
// Many rules carry the same wording in both columns; show it once.
const spanish = (v: Validation) => (clean(v.message_spa).toLowerCase() !== clean(v.message).toLowerCase() ? clean(v.message_spa) : '');
const day = (v: string | null | undefined) => clean(v).slice(0, 10);
const commitmentOf = (v: Validation): Commitment => ({ reviewed: !!v.reviewed, targetDate: day(v.target_date), notes: v.notes ?? '' });

// apiPost does not report the HTTP status, and this page needs it: a 400 or a 409
// carries a message the user can act on, anything else is a fault.
async function postCommitment(body: Record<string, unknown>): Promise<ApiResult & { status: number }> {
  try {
    const resp = await fetch(`${LAMBDA_URL}?action=cert_certify_validation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ...((await resp.json()) as ApiResult), status: resp.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

const Severity = ({ value }: { value?: string | null }) =>
  (clean(value) ? <span className={`sy-sev sy-sev-${clean(value).toLowerCase()}`}>{clean(value)}</span> : <>—</>);

function Validations() {
  const { mock, email, party, canWrite, session, reloadParties } = useHcm();
  const source = party?.source ?? '';
  const agency = party?.agency ?? '';
  const signedOff = party?.signed_off ?? null;
  const readOnly = !canWrite || !!signedOff;

  const [rows, setRows] = useState<Validation[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [filterChoice, setFilterChoice] = useState<Filter | ''>('');
  const [search, setSearch] = useState('');
  const [openCode, setOpenCode] = useState('');
  const [form, setForm] = useState<Commitment>({ reviewed: false, targetDate: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);   // the open validation's records are shown
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const latest = useRef(0);
  const scope = useRef(0);   // one per source / agency on screen; a refresh of the list does not change it

  const load = useCallback(async () => {
    const id = ++latest.current;
    const d = await apiGet<ValidationList>('cert_validations', { mock, source, agency, email });
    if (id !== latest.current) return;   // another source / agency is already loading
    setLoadFailed(!d.ok);
    if (d.ok) {
      setRows(Array.isArray(d.validations) ? d.validations : []);
      setWarnings(Array.isArray(d.warnings) ? d.warnings : []);
    }
  }, [mock, source, agency, email]);

  // A different source / agency starts from an empty page.
  useEffect(() => {
    scope.current += 1;
    setRows(null);
    setWarnings([]);
    setLoadFailed(false);
    setFilterChoice('');
    setSearch('');
    setOpenCode('');
    setSaving(false);
    setSaveError('');
    setNotice('');
    load();
  }, [load]);

  const total = rows?.length ?? 0;
  const committed = useMemo(() => (rows ?? []).filter(v => v.committed).length, [rows]);
  const pending = total - committed;
  const filter: Filter = filterChoice || (pending > 0 ? 'pending' : 'all');

  const open = useMemo(() => (rows ?? []).find(v => v.validation_code === openCode), [rows, openCode]);
  const stored = open ? commitmentOf(open) : null;
  const dirty = !!stored && (form.reviewed !== stored.reviewed || form.targetDate !== stored.targetDate
    || form.notes.trim() !== stored.notes.trim());
  const complete = form.reviewed || !!form.targetDate || !!form.notes.trim();

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (rows ?? []).filter(v =>
      // the open validation stays in place after it is committed
      (filter === 'all' || !v.committed || v.validation_code === openCode)
      && (!needle || [v.validation_code, v.message, v.message_spa, v.entity].some(t => clean(t).toLowerCase().includes(needle))));
  }, [rows, filter, search, openCode]);

  const toggle = (v: Validation) => {
    if (saving) return;
    if (!readOnly && dirty && !window.confirm(`Leave ${openCode} without saving your changes?`)) return;
    setSaveError('');
    setNotice('');
    setRecordsOpen(false);
    if (v.validation_code === openCode) {
      setOpenCode('');
      return;
    }
    setOpenCode(v.validation_code);
    setForm(commitmentOf(v));
  };

  const save = async () => {
    if (!open || readOnly || saving || !dirty || !complete) return;
    const started = scope.current;
    const code = open.validation_code;
    const notes = form.notes.trim();
    setSaving(true);
    setSaveError('');
    setNotice('');
    const d = await postCommitment({
      actor: email, mock, source, agency, validation_code: code,
      reviewed: form.reviewed, target_date: form.targetDate || undefined, notes: notes || undefined,
    });
    if (started !== scope.current) return;   // another source / agency is on screen now
    setSaving(false);
    if (!d.ok) {
      setSaveError((d.status === 400 || d.status === 409) && d.error
        ? d.error
        : 'Your commitment could not be saved. Please try again in a moment.');
      if (d.status === 409) reloadParties();   // the final certification was signed meanwhile
      return;
    }
    setRows(prev => prev && prev.map(v => (v.validation_code === code ? {
      ...v, committed: true, reviewed: form.reviewed, target_date: form.targetDate || null, notes: notes || null,
      committed_by: email, committed_at: new Date().toISOString(),
    } : v)));
    setForm(f => ({ ...f, notes }));
    setNotice(`Your commitment for ${code} was saved.`);
    load();
    reloadParties();
  };

  if (!party) return null;

  if (rows === null) {
    return loadFailed ? (
      <div className="hcm-message">
        <h2>The validations could not be loaded</h2>
        <p>Please try again in a moment.</p>
        <div className="hcm-message-actions">
          <button type="button" className="btn btn-primary" onClick={load}>Try again</button>
        </div>
      </div>
    ) : <p className="hcm-loading">Loading…</p>;
  }

  const finish = (
    <p className="hval-next">
      When every validation has a commitment, finish in{' '}
      <Link href="/hcm/certifications" className={`btn ${pending === 0 && !signedOff ? 'btn-primary' : 'btn-secondary'}`}>Certifications</Link>
    </p>
  );

  if (total === 0) {
    return (
      <>
        <div className="hcm-empty">
          <h2>Nothing to review</h2>
          <p>No validations were reported for {partyLabel(party)} in {mock}.</p>
        </div>
        {finish}
      </>
    );
  }

  const committedLine = (v: Validation) =>
    `Committed by ${clean(v.committed_by) || 'your agency'} on ${fmtDateTime(v.committed_at).slice(0, 16)}`;

  const panel = (v: Validation, id: string) => (
    <div className="hval-panel" id={id}>
      <div className="hval-panel-grid">
        <section aria-label="Validation rule">
          <h3>About this validation</h3>
          <dl className="hval-facts">
            {spanish(v) && <div className="hval-fact-wide"><dt>Mensaje</dt><dd lang="es">{spanish(v)}</dd></div>}
            <div className="hval-fact-wide"><dt>Message</dt><dd>{clean(v.message) || '—'}</dd></div>
            <div><dt>Entity</dt><dd>{clean(v.entity) || '—'}</dd></div>
            <div><dt>Type</dt><dd>{clean(v.type) || '—'}</dd></div>
            <div><dt>Severity</dt><dd><Severity value={v.severity} /></dd></div>
            <div><dt>Records</dt><dd>{(v.count ?? 0).toLocaleString()}</dd></div>
          </dl>
        </section>
        <section aria-label="Path Forward">
          <h3>Path Forward</h3>
          {clean(v.path_forward)
            ? <p className="hval-forward">{clean(v.path_forward)}</p>
            : <p className="hval-forward hval-forward-empty">The path forward for this validation has not been published yet.</p>}
        </section>
      </div>

      <section className="hval-records" aria-label="Records">
        <div className="hval-actions">
          <button type="button" className="btn btn-secondary" aria-expanded={recordsOpen} onClick={() => setRecordsOpen(o => !o)}>
            {recordsOpen ? 'Hide the records' : `View the ${(v.count ?? 0).toLocaleString()} records`}
          </button>
          <span className="sy-muted">The records of your agency that this validation found.</span>
        </div>
        {recordsOpen && <RecordsTable validationCode={v.validation_code} source={party.source} agency={party.agency} />}
      </section>

      <section className="hval-commit" aria-label="Commitment">
        <h3>{readOnly ? 'Commitment' : 'Your commitment'}</h3>
        {readOnly ? (
          v.committed ? (
            <dl className="hval-facts">
              <div><dt>Path forward reviewed</dt><dd>{v.reviewed ? 'Yes, and we are working on it' : 'Not confirmed'}</dd></div>
              <div><dt>Target date</dt><dd>{day(v.target_date) || '—'}</dd></div>
              <div className="hval-fact-wide"><dt>Comment</dt><dd className="hval-comment-text">{clean(v.notes) || '—'}</dd></div>
              <div className="hval-fact-wide"><dt>Recorded</dt><dd>{committedLine(v)}</dd></div>
            </dl>
          ) : <p className="sy-muted">No commitment has been recorded for this validation yet.</p>
        ) : (
          <form onSubmit={e => { e.preventDefault(); save(); }}>
            <label className="hval-check">
              <input type="checkbox" checked={form.reviewed} disabled={saving}
                onChange={e => setForm(f => ({ ...f, reviewed: e.target.checked }))} />
              <span>We reviewed the path forward and are working on it</span>
            </label>
            <div className="hval-fields">
              <label className="sy-field">
                <span>Target date (optional)</span>
                <input type="date" value={form.targetDate} disabled={saving}
                  onChange={e => setForm(f => ({ ...f, targetDate: e.target.value }))} />
              </label>
              <label className="sy-field hval-comment">
                <span>Comment (optional)</span>
                <textarea value={form.notes} disabled={saving}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </label>
            </div>
            {saveError && <div className="sy-error" role="alert">{saveError}</div>}
            {notice && <div className="sy-success" role="status">{notice}</div>}
            <div className="hval-actions">
              <button type="submit" className="btn btn-primary" disabled={saving || !dirty || !complete}>
                {saving ? 'Saving…' : v.committed ? 'Update commitment' : 'Save commitment'}
              </button>
              {!complete && <span className="sy-muted">Tick the box, or give a target date or a comment.</span>}
              {v.committed && <span className="sy-muted">{committedLine(v)}</span>}
            </div>
          </form>
        )}
      </section>
    </div>
  );

  return (
    <>
      {signedOff && (
        <div className="hcm-banner">
          The final certification of {partyLabel(party)} was signed by {signedOff.name} on {fmtDateTime(signedOff.at).slice(0, 10)}.
          {' '}The commitments below can no longer be changed.
        </div>
      )}
      {!signedOff && !canWrite && <div className="hcm-banner">You can read this page. Your account cannot save commitments.</div>}
      {loadFailed && (
        <div className="sy-error" role="alert">
          The list could not be refreshed. <button type="button" className="sy-link" onClick={load}>Try again</button>
        </div>
      )}
      {session.isAdmin && warnings.length > 0 && (
        <div className="sy-note"><ul className="hval-notes">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}

      <div className="hcm-summary">
        <span className="hcm-summary-party">{partyLabel(party)}</span>
        <p className="hcm-summary-text">{committed} of {total} validations have a commitment</p>
        <div className="sy-progress hval-progress" aria-hidden="true"><span style={{ width: `${(100 * committed) / total}%` }} /></div>
      </div>

      <div className="hval-tools">
        <div className="hval-filter" role="group" aria-label="Validations to show">
          <button type="button" className={`hval-filter-btn${filter === 'pending' ? ' active' : ''}`} aria-pressed={filter === 'pending'}
            onClick={() => setFilterChoice('pending')}>Pending ({pending})</button>
          <button type="button" className={`hval-filter-btn${filter === 'all' ? ' active' : ''}`} aria-pressed={filter === 'all'}
            onClick={() => setFilterChoice('all')}>All ({total})</button>
        </div>
        <label className="sy-field hval-search">
          <span>Search</span>
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Code, message or entity" />
        </label>
      </div>
      <p className="sy-muted hval-hint">
        {readOnly
          ? 'Select a validation to read its path forward and the commitment.'
          : 'Select a validation to read its path forward and record your commitment.'}
      </p>

      {shown.length === 0 ? (
        <div className="hcm-empty">
          <p>{search.trim() ? 'No validation matches your search.' : 'Every validation has a commitment. Choose All to see them.'}</p>
        </div>
      ) : (
        <table className="sy-table hval-table">
          <thead>
            <tr>
              <th scope="col">Validation code</th><th scope="col">Message</th><th scope="col">Entity</th><th scope="col">Type</th>
              <th scope="col">Severity</th><th scope="col" className="num">Records</th><th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((v, n) => {
              const isOpen = v.validation_code === openCode;
              const panelId = `hval-panel-${n}`;
              return (
                <React.Fragment key={v.validation_code}>
                  <tr className={`hval-row${isOpen ? ' hval-row-open' : ''}`} onClick={() => toggle(v)}>
                    <td data-label="Validation code">
                      <button type="button" className="sy-link hval-code" aria-expanded={isOpen} aria-controls={isOpen ? panelId : undefined}
                        onClick={e => { e.stopPropagation(); toggle(v); }}>
                        {v.validation_code}
                      </button>
                    </td>
                    <td data-label="Message" className="hval-message">
                      {spanish(v) && <span lang="es">{spanish(v)}</span>}
                      <span className={spanish(v) ? 'hval-english' : undefined}>{clean(v.message) || (spanish(v) ? '' : '—')}</span>
                    </td>
                    <td data-label="Entity">{clean(v.entity) || '—'}</td>
                    <td data-label="Type">{clean(v.type) || '—'}</td>
                    <td data-label="Severity"><Severity value={v.severity} /></td>
                    <td data-label="Records" className="num">{(v.count ?? 0).toLocaleString()}</td>
                    <td data-label="Status">
                      {v.committed
                        ? <><span className="sy-badge sy-badge-ok">Committed</span><span className="hval-when">{fmtDateTime(v.committed_at).slice(0, 10)}</span></>
                        : <span className="sy-badge sy-badge-warn">Pending</span>}
                    </td>
                  </tr>
                  {isOpen && <tr className="hval-detail"><td colSpan={COLUMNS}>{panel(v, panelId)}</td></tr>}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {finish}
    </>
  );
}

function HcmValidationsPage() {
  return (
    <HcmShell title="Validations & Path Forward" agencyOnly
      subtitle="The validations found in your data. Read the path forward of each one and tell us how your agency will handle it.">
      <Validations />
    </HcmShell>
  );
}

export default withAuthenticator(HcmValidationsPage);
