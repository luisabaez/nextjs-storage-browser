'use client';

// What one source / agency does on the certifications page: upload the signed
// certification forms, follow the validations step and sign the cycle once
// everything is done.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiResult, apiGet, fmtDateTime } from '../../lib/symphony';
import { HcmParty, partyLabel, useHcm } from '../HcmShell';
import FormsStep from './FormsStep';
import {
  CertRecord, ReasonForm, RecordName, ResponseBadge, ResponseOption, agencyProblem, count, day, filesHref, partyId, post, recordKey,
  recordName,
} from './shared';

interface Expected extends ApiResult { responses?: ResponseOption[]; rows?: CertRecord[] }
interface SignResult extends ApiResult { missing_records?: RecordName[]; missing_validations?: string[] }

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
    { title: 'Upload your signed forms', text: `${certified} of ${required} certified`, done: required > 0 && certified >= required },
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

function Signature({ party, pending, unbacked, suggested, onChanged, onOutdated }: {
  party: HcmParty;
  pending: CertRecord[];
  unbacked: RecordName[];        // certified with issues, but the server no longer finds an issue with a document
  suggested: { name: string; title: string };    // the signature block of the latest form
  onChanged: (message: string) => void;
  onOutdated: (missing: RecordName[]) => void;   // the server knows of something missing that the page does not show yet
}) {
  const { mock, email, canWrite, isSuperUser, partiesLoading } = useHcm();
  const [name, setName] = useState(suggested.name);
  const [title, setTitle] = useState(suggested.title);
  useEffect(() => {
    setName(n => n || suggested.name);
    setTitle(t => t || suggested.title);
  }, [suggested]);
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
      These were certified as incorrect, but an entity answered that way has no supporting document.
      Add the documents under Supporting documents, then sign again:
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
                      <li>and {pending.length - shown.length} more; see <a href="#hcert-forms">Certification forms</a></li>
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

export default function AgencyView({ party }: { party: HcmParty }) {
  const { mock, email, canWrite, reloadParties } = useHcm();
  const key = partyId(party);
  const [data, setData] = useState<{ rows: CertRecord[]; responses: ResponseOption[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [refused, setRefused] = useState<RecordName[]>([]);   // records the server named when it refused the signature
  const [signer, setSigner] = useState({ name: '', title: '' });
  const latest = useRef(0);
  const noticeBox = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const request = ++latest.current;
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
    if (message) setNotice(message);
    setRefused([]);
    refresh();
  };

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

      <h2 className="hcm-section" id="hcert-forms">Certification forms</h2>
      <FormsStep party={party} locked={locked} onChanged={changed} onSigner={setSigner} />

      <h2 className="hcm-section">What your forms certified ({completed.length} of {rows.length})</h2>
      {rows.length === 0 ? (
        <div className="hcm-empty"><p>No certification is required from you in this cycle.</p></div>
      ) : (
        <ul className="hcm-list">
          {[...pending, ...completed].map(r => {
            const issues = r.issues ?? 0;
            return (
              <li key={recordKey(r)} className="hcm-row hcert-record">
                <div className="hcm-row-main">
                  <div className="hcm-row-title">{recordName(r)}</div>
                  <div className="hcm-row-meta">
                    {r.certified ? [
                      r.resource_name && `Agency resource: ${r.resource_name}`,
                      r.certified_at && `Certified on ${day(r.certified_at)}`,
                      issues > 0 && count(issues, 'entity answered as incorrect', 'entities answered as incorrect'),
                    ].filter(Boolean).join(' · ') : 'Waiting for the signed form'}
                  </div>
                </div>
                {r.certified ? <ResponseBadge code={r.response_code} responses={responses} />
                  : <span className="sy-badge sy-badge-warn">Pending</span>}
                <div className="hcm-row-actions">
                  <Link href={filesHref(r)} className="btn btn-secondary" aria-label={`View the files of ${recordName(r)}`}>View files</Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="hcm-section">Final signature</h2>
      <Signature party={party} pending={pending} suggested={signer} onChanged={changed}
        unbacked={refused.filter(m => !pending.some(r => recordKey(r) === recordKey(m)))}
        onOutdated={missing => { setRefused(missing); refresh(); }} />
    </>
  );
}
