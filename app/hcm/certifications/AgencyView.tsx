'use client';

// What one source / agency does on the certifications page: certify each file,
// follow the validations step and sign the cycle once everything is done.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiResult, apiGet, fmtDateTime } from '../../lib/symphony';
import { HcmParty, partyLabel, useHcm } from '../HcmShell';
import CertifyForm from './CertifyForm';
import {
  CertRecord, Documents, Issue, IssuesResult, ReasonForm, RecordName, ResponseBadge, ResponseOption, agencyProblem, count, day,
  filesHref, partyId, post, recordKey, recordName,
} from './shared';

interface Expected extends ApiResult { responses?: ResponseOption[]; rows?: CertRecord[] }
interface SignResult extends ApiResult { missing_records?: RecordName[]; missing_validations?: string[] }

const domId = (key: string) => `hcert-${key.replace(/[^A-Z0-9]+/g, '-')}`;

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12l5 5 9-10" />
  </svg>
);

function Steps({ party, certified, required }: { party: HcmParty; certified: number; required: number }) {
  const reported = party.validations_reported ?? 0;
  const committed = party.validations_committed ?? 0;
  const signed = party.signed_off;
  const steps = [
    { title: 'Certify your files', text: `${certified} of ${required} certified`, done: required > 0 && certified >= required },
    {
      title: 'Commit to the path forward of your validations',
      text: reported > 0 ? `${committed} of ${reported} committed` : 'No validations were reported to you',
      done: committed >= reported,
    },
    { title: 'Final signature', text: signed ? `Signed by ${signed.name} on ${day(signed.at)}` : 'Not signed yet', done: !!signed },
  ];
  const current = steps.findIndex(s => !s.done);

  return (
    <ol className="hcert-steps" aria-label="Steps of the certification">
      {steps.map((s, i) => (
        <li key={s.title} aria-current={i === current ? 'step' : undefined}
          className={`hcert-step${s.done ? ' hcert-step-done' : ''}${i === current ? ' hcert-step-current' : ''}`}>
          <span className="hcert-step-num">{s.done ? <CheckIcon /> : i + 1}</span>
          <span className="hcert-step-body">
            <span className="hcert-step-title">{s.title}</span>
            <span className="hcert-step-text">
              {s.text}{s.done ? ' · Done' : i === current ? ' · Current step' : ''}
            </span>
            {i === 1 && reported > 0 && <Link href="/hcm/validations">Open validations</Link>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A completed record opened: the full response, who certified it and the issues with their documents. */
function RecordDetails({ record, party, responses, siblings, canRevoke, onRevoked }: {
  record: CertRecord;
  party: HcmParty;
  responses: ResponseOption[];
  siblings: CertRecord[];        // other completed records a revoke also withdraws
  canRevoke: boolean;
  onRevoked: (message: string) => void;
}) {
  const { mock, email } = useHcm();
  const { source, agency } = party;
  const { module, file_type: fileType, entity } = record;
  const reportedIssues = record.issues ?? 0;
  const [issues, setIssues] = useState<Issue[] | null>(reportedIssues > 0 ? null : []);
  const [failed, setFailed] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (reportedIssues === 0) return;
    let stale = false;
    apiGet<IssuesResult>('cert_issues', { mock, email, source, agency, module, file_type: fileType, entity }).then(d => {
      if (stale) return;
      setFailed(!d.ok);
      setIssues(d.ok && Array.isArray(d.issues) ? d.issues : []);
    });
    return () => { stale = true; };
  }, [mock, email, source, agency, module, fileType, entity, reportedIssues]);

  const revoke = async (reason: string) => {
    setBusy(true);
    setError('');
    const d = await post<ApiResult>('cert_revoke', {
      actor: email, mock, source, agency, cert_type: 'FILE', cert_key: `${entity}|${fileType}`, reason,
    });
    setBusy(false);
    if (!d.ok) {
      setError(agencyProblem(d, 'The certification could not be revoked. Please try again in a moment.'));
      return;
    }
    onRevoked(`The certification of ${recordName(record)} was revoked.`);
  };

  const label = responses.find(r => r.code === record.response_code)?.label;
  return (
    <div className="hcert-details">
      <dl className="hcert-facts">
        {label && <><dt>Response</dt><dd lang="es">{label}</dd></>}
        <dt>Agency resource</dt><dd>{record.resource_name || '—'}</dd>
        <dt>Certified by</dt><dd>{record.certified_by || '—'}{record.certified_at ? ` on ${fmtDateTime(record.certified_at).slice(0, 16)}` : ''}</dd>
        {record.notes && <><dt>Notes</dt><dd className="hcert-text">{record.notes}</dd></>}
      </dl>
      {failed && <div className="sy-error">The issues of this record could not be loaded. Please try again in a moment.</div>}
      {issues === null ? <p className="hcert-note">Loading…</p> : issues.length > 0 && (
        <>
          <h4>Reported issues</h4>
          <ol className="hcert-issues">
            {issues.map((issue, i) => (
              <li key={issue.id} className="hcert-issue">
                <div className="hcert-issue-head"><span>Issue {i + 1}</span></div>
                <p className="hcert-text">{issue.description}</p>
                <p className="hcert-note">
                  {[issue.reported_by && `Reported by ${issue.reported_by}`, day(issue.reported_at)].filter(Boolean).join(' · ')}
                </p>
                <Documents items={issue.attachments ?? []} email={email} staff={false} empty="No supporting document." />
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="hcert-record-actions">
        <Link href={filesHref(record)} className="btn btn-secondary">View files</Link>
        {canRevoke && !revoking && (
          <button type="button" className="btn btn-secondary" onClick={() => setRevoking(true)}>Revoke certification</button>
        )}
      </div>
      {revoking && (
        <ReasonForm heading={`Revoke the certification of ${recordName(record)}`} action="Revoke certification"
          text={'The record goes back to the "To certify" list and the agency certifies it again.'
            + (siblings.length > 0 ? ` This also revokes ${siblings.map(recordName).join(', ')}.` : '')}
          busy={busy} error={error} onSubmit={revoke} onCancel={() => { setRevoking(false); setError(''); }} />
      )}
    </div>
  );
}

function Signature({ party, pending, unbacked, onChanged, onOutdated }: {
  party: HcmParty;
  pending: CertRecord[];
  unbacked: RecordName[];        // certified with issues, but the server no longer finds an issue with a document
  onChanged: (message: string) => void;
  onOutdated: (missing: RecordName[]) => void;   // the server knows of something missing that the page does not show yet
}) {
  const { mock, email, canWrite, isSuperUser, partiesLoading } = useHcm();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<string[]>([]);   // validations the server named as still open

  const signed = party.signed_off;
  const awaiting = Math.max(0, (party.validations_reported ?? 0) - (party.validations_committed ?? 0));
  const statement = `Certifico que la agencia completó la revisión de todos los archivos y validaciones del ciclo ${mock} `
    + 'y que las respuestas registradas representan la posición oficial de la agencia.';
  const ids = { actor: email, mock, source: party.source, agency: party.agency };

  const sign = async () => {
    setBusy(true);
    setError('');
    const d = await post<SignResult>('cert_signoff', { ...ids, signer_name: name.trim(), signer_title: title.trim() });
    setBusy(false);
    setConfirming(false);
    if (!d.ok) {
      setError(agencyProblem(d, 'The signature could not be saved. Please try again in a moment.'));
      if (d.status === 409) {
        setCodes(d.missing_validations ?? []);
        onOutdated(d.missing_records ?? []);
      }
      return;
    }
    onChanged(`The certification of ${mock} was signed by ${name.trim()}.`);
  };

  const reopen = async (reason: string) => {
    setBusy(true);
    setError('');
    const d = await post<ApiResult>('cert_revoke', { ...ids, cert_type: 'SIGNOFF', reason });
    setBusy(false);
    if (!d.ok) {
      setError(agencyProblem(d, 'The signature could not be revoked. Please try again in a moment.'));
      return;
    }
    setReopening(false);
    onChanged(`The signature of ${partyLabel(party)} was revoked. The certifications can be changed again.`);
  };

  if (signed) {
    return (
      <section className="hcm-card">
        <p className="hcert-statement" lang="es">{statement}</p>
        <p>
          <strong>Signed by {signed.name}</strong>{signed.title ? `, ${signed.title}` : ''} on {fmtDateTime(signed.at).slice(0, 16)}.
        </p>
        <p>
          Everything for {mock} is now locked: the certifications and the validations can no longer be changed.
          {!isSuperUser && ' If something must change, contact the validation team.'}
        </p>
        {isSuperUser && (reopening ? (
          <ReasonForm heading={`Reopen ${partyLabel(party)}`} action="Revoke signature"
            text="The signature is revoked and the agency can change its certifications again. It signs again when it is done."
            busy={busy} error={error} onSubmit={reopen} onCancel={() => { setReopening(false); setError(''); }} />
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => setReopening(true)}>Reopen (revoke signature)</button>
        ))}
      </section>
    );
  }

  const attention = unbacked.length > 0 && (
    <div className="sy-note">
      These files were certified with issues, but an issue or its supporting document is no longer there.
      Use &quot;Change response&quot; on each one, then sign again:
      <ul className="hcert-missing">{unbacked.map(r => <li key={recordKey(r)}>{recordName(r)}</li>)}</ul>
    </div>
  );

  if (party.status !== 'Ready to sign') {
    const shown = pending.slice(0, 8);
    return (
      <section className="hcm-card">
        {error && <div className="sy-error" role="alert">{error}</div>}
        {attention}
        {pending.length === 0 && awaiting === 0 ? (
          <p className="hcert-note">{partiesLoading ? 'Checking what is left…' : 'The final signature is not available yet.'}</p>
        ) : (
          <>
            <p>You can sign once everything below is done.</p>
            <ul className="hcert-missing">
              {pending.length > 0 && (
                <li>
                  {count(pending.length, 'file still needs', 'files still need')} a certification:
                  <ul>
                    {shown.map(r => <li key={recordKey(r)}>{recordName(r)}</li>)}
                    {pending.length > shown.length && (
                      <li>and {pending.length - shown.length} more in the <a href="#hcert-to-certify">To certify</a> list</li>
                    )}
                  </ul>
                </li>
              )}
              {awaiting > 0 && (
                <li>
                  {count(awaiting, 'validation still needs', 'validations still need')} your commitment to the path forward
                  {codes.length > 0 && ` (${codes.join(', ')})`}. <Link href="/hcm/validations">Open Validations &amp; Path Forward</Link>
                </li>
              )}
            </ul>
          </>
        )}
      </section>
    );
  }

  if (!canWrite) {
    return <section className="hcm-card"><p>Everything is complete. The agency can now sign the certification of {mock}.</p></section>;
  }

  const why = !name.trim() ? 'Enter your full name.' : !title.trim() ? 'Enter your title.' : '';
  return (
    <section className="hcm-card">
      <p>Everything is complete. One signature delivers the whole certification of {partyLabel(party)} for {mock}.</p>
      <p className="hcert-statement" lang="es">{statement}</p>
      <div className="sy-form-grid">
        <label className="sy-field">
          <span>Name</span>
          <input type="text" value={name} maxLength={200} required autoComplete="name" disabled={busy || confirming}
            onChange={e => setName(e.target.value)} />
        </label>
        <label className="sy-field">
          <span>Title</span>
          <input type="text" value={title} maxLength={200} required autoComplete="organization-title" disabled={busy || confirming}
            onChange={e => setTitle(e.target.value)} />
        </label>
      </div>
      {error && <div className="sy-error" role="alert">{error}</div>}
      {attention}
      {confirming ? (
        <div className="hcert-confirm" role="group" aria-label="Confirm the signature">
          <p>
            You are signing for <strong>{partyLabel(party)}</strong> as {name.trim()}, {title.trim()}.
            After you sign, nothing in {mock} can be changed.
          </p>
          <div className="sy-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Go back</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={sign}>{busy ? 'Signing…' : 'Yes, sign and submit'}</button>
          </div>
        </div>
      ) : (
        <div className="hcert-submit">
          {why && <p className="hcert-why" id="hcert-sign-why">{why}</p>}
          <button type="button" className="btn btn-primary" disabled={!!why || partiesLoading} onClick={() => setConfirming(true)}
            aria-describedby={why ? 'hcert-sign-why' : undefined}>
            Sign and submit
          </button>
        </div>
      )}
    </section>
  );
}

export default function AgencyView({ party, deepLink }: { party: HcmParty; deepLink: React.MutableRefObject<boolean> }) {
  const { mock, email, canWrite, isSuperUser, reloadParties } = useHcm();
  const key = partyId(party);
  const [data, setData] = useState<{ rows: CertRecord[]; responses: ResponseOption[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [openKey, setOpenKey] = useState('');         // the record whose form is open
  const [detailKey, setDetailKey] = useState('');     // the completed record whose details are open
  const [scrollTo, setScrollTo] = useState('');
  const [notice, setNotice] = useState('');
  const [refused, setRefused] = useState<RecordName[]>([]);   // records the server named when it refused the signature
  const latest = useRef(0);
  const outdated = useRef(false);                     // issues or documents changed since the rows were loaded
  const noticeBox = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const request = ++latest.current;
    outdated.current = false;
    const d = await apiGet<Expected>('cert_expected', { mock, email });
    if (request !== latest.current) return;
    setLoadFailed(!d.ok);
    if (d.ok) setData({ rows: (d.rows ?? []).filter(r => partyId(r) === key), responses: d.responses ?? [] });
  }, [mock, email, key]);

  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load]);

  const locked = !!party.signed_off;
  const canChange = canWrite && !locked;

  // A link from My Files names the record to certify.
  useEffect(() => {
    if (!data || deepLink.current) return;
    deepLink.current = true;
    const q = new URLSearchParams(window.location.search);
    if (!q.get('file_type') || !q.get('entity')) return;
    const wanted = recordKey({ module: q.get('module') || '', file_type: q.get('file_type') || '', entity: q.get('entity') || '' });
    const hit = data.rows.find(r => recordKey(r) === wanted);
    if (!hit) return;
    if (canChange) setOpenKey(wanted); else if (hit.certified) setDetailKey(wanted);
    setScrollTo(wanted);
  }, [data, deepLink, canChange]);

  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(domId(scrollTo))?.scrollIntoView({ block: 'start' });
    setScrollTo('');
  }, [scrollTo]);

  useEffect(() => {
    if (notice) noticeBox.current?.scrollIntoView({ block: 'nearest' });
  }, [notice]);

  if (!data) {
    return loadFailed ? (
      <div className="hcm-message">
        <h2>Your certifications could not be loaded</h2>
        <p>Please try again in a moment.</p>
        <div className="hcm-message-actions">
          <button type="button" className="btn btn-primary" onClick={load}>Try again</button>
        </div>
      </div>
    ) : <p className="hcm-loading">Loading…</p>;
  }

  const { rows, responses } = data;
  const pending = rows.filter(r => !r.certified);
  const completed = rows.filter(r => r.certified);

  const refresh = () => { reloadParties(); load(); };
  const changed = (message: string) => {
    setNotice(message);
    setOpenKey('');
    setDetailKey('');
    setRefused([]);
    refresh();
  };
  const openForm = (recordId: string) => {
    setNotice('');
    setDetailKey('');
    setOpenKey(recordId);
    if (outdated.current) load();
  };
  const closeForm = () => {
    setOpenKey('');
    if (!outdated.current) return;
    setRefused([]);
    load();
  };
  const form = (r: CertRecord) => (
    <CertifyForm record={r} party={party} responses={responses} onTouched={() => { outdated.current = true; }}
      onSaved={changed} onCancel={closeForm} />
  );

  return (
    <>
      <Steps party={party} certified={completed.length} required={rows.length} />
      {loadFailed && (
        <div className="sy-error" role="alert">
          The latest changes could not be loaded. <button type="button" className="sy-link" onClick={load}>Try again</button>
        </div>
      )}
      <div ref={noticeBox} role="status">{notice && <div className="sy-success">{notice}</div>}</div>
      {!canWrite && <div className="hcm-banner">Your account can look at these certifications but cannot change them.</div>}
      {locked && <div className="hcm-banner">This cycle is signed, so the certifications below can no longer be changed.</div>}

      <h2 className="hcm-section" id="hcert-to-certify">To certify ({pending.length})</h2>
      {pending.length === 0 ? (
        <div className="hcm-empty">
          <p>{rows.length === 0 ? 'No certification is required from you in this cycle.' : 'Every file is certified. Nothing is pending here.'}</p>
        </div>
      ) : pending.map(r => {
        const id = recordKey(r);
        return (
          <section key={id} id={domId(id)} className="hcm-card hcert-record">
            <div className="hcert-record-head">
              <h3 className="hcert-record-name">{recordName(r)}</h3>
              <div className="hcert-record-actions">
                <Link href={filesHref(r)} className="btn btn-secondary" aria-label={`View the files of ${recordName(r)}`}>View files</Link>
                {canChange && openKey !== id && (
                  <button type="button" className="btn btn-primary" onClick={() => openForm(id)} aria-label={`Certify ${recordName(r)}`}>
                    Certify
                  </button>
                )}
              </div>
            </div>
            {openKey === id && form(r)}
          </section>
        );
      })}

      <h2 className="hcm-section">Completed ({completed.length})</h2>
      {completed.length === 0 ? (
        <div className="hcm-empty"><p>Nothing has been certified yet.</p></div>
      ) : (
        <ul className="hcm-list">
          {completed.map(r => {
            const id = recordKey(r);
            const issues = r.issues ?? 0;
            const detailsOpen = detailKey === id && openKey !== id;
            return (
              <li key={id} id={domId(id)} className="hcm-row hcert-record">
                <div className="hcm-row-main">
                  <div className="hcm-row-title">{recordName(r)}</div>
                  <div className="hcm-row-meta">
                    {[
                      r.resource_name && `Agency resource: ${r.resource_name}`,
                      r.certified_at && `Certified on ${day(r.certified_at)}`,
                      issues > 0 && count(issues, 'issue', 'issues'),
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <ResponseBadge code={r.response_code} responses={responses} />
                <div className="hcm-row-actions">
                  <button type="button" className="btn btn-secondary" aria-expanded={detailsOpen} disabled={openKey === id}
                    onClick={() => setDetailKey(detailsOpen ? '' : id)} aria-label={`${detailsOpen ? 'Hide' : 'Show'} the details of ${recordName(r)}`}>
                    {detailsOpen ? 'Hide details' : 'Details'}
                  </button>
                  {canChange && openKey !== id && (
                    <button type="button" className="btn btn-secondary" onClick={() => openForm(id)}
                      aria-label={`Change the response for ${recordName(r)}`}>
                      Change response
                    </button>
                  )}
                </div>
                {detailsOpen && (
                  <div className="hcert-row-more">
                    <RecordDetails record={r} party={party} responses={responses} canRevoke={isSuperUser && !locked} onRevoked={changed}
                      siblings={completed.filter(o => o !== r && recordKey({ ...o, module: '' }) === recordKey({ ...r, module: '' }))} />
                  </div>
                )}
                {openKey === id && <div className="hcert-row-more">{form(r)}</div>}
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="hcm-section">Final signature</h2>
      <Signature party={party} pending={pending} onChanged={changed}
        unbacked={refused.filter(m => !pending.some(r => recordKey(r) === recordKey(m)))}
        onOutdated={missing => { setRefused(missing); refresh(); }} />
    </>
  );
}
