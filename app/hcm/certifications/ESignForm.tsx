'use client';

// Filling in and signing a certification form in the portal, instead of
// downloading, signing and uploading it. The agency answers the rows of the
// same form and signs with its name and title; the portal writes both into the
// cycle's form and keeps that file like an uploaded one. Until the validation
// team approves it, only super users see this.
import React, { useCallback, useEffect, useState } from 'react';
import { ApiResult, apiGet } from '../../lib/symphony';
import { HcmParty, partyLabel, useHcm } from '../HcmShell';
import type { Submitted } from './FormsStep';
import { agencyProblem, count, post, responseShort } from './shared';

interface ESignRow { row: number; segment: string; entity: string; folder: string; options: string[]; resource: string; code?: string | null }
interface ESignData extends ApiResult {
  rows?: ESignRow[];
  responses?: Record<string, string>;
  consent?: string;
  esign_open?: boolean;
  signer?: { email: string; name: string };
}
interface Answer { resource: string; code: string }

export default function ESignForm({ kind, formName, party, onSigned, onCancel }: {
  kind: string;
  formName: string;
  party: HcmParty;
  onSigned: (result: Submitted) => void;
  onCancel: () => void;
}) {
  const { mock, email } = useHcm();
  const [data, setData] = useState<ESignData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [name, setName] = useState('');
  const [signerTitle, setSignerTitle] = useState('');
  const [consent, setConsent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    const d = await apiGet<ESignData>('certform_esign_form', { mock, email, source: party.source, agency: party.agency, kind });
    if (!d.ok) {
      setLoadError(d.error || 'The form could not be loaded');
      return;
    }
    setData(d);
    setAnswers(Object.fromEntries((d.rows ?? []).map(r => [r.row, { resource: r.resource || '', code: r.code || '' }])));
    setName(n => n || d.signer?.name || '');
  }, [mock, email, party.source, party.agency, kind]);

  useEffect(() => { load(); }, [load]);

  if (!data) {
    return loadError ? (
      <div className="sy-error" role="alert">{loadError} <button type="button" className="sy-link" onClick={load}>Try again</button></div>
    ) : <p className="hcm-loading">Loading the form…</p>;
  }

  const rows = data.rows ?? [];
  const responses = data.responses ?? {};
  const answered = rows.filter(r => answers[r.row]?.code).length;
  const set = (row: number, change: Partial<Answer>) => setAnswers(a => ({ ...a, [row]: { ...a[row], ...change } }));
  const why = answered === 0 ? 'Choose a comment for at least one data entity.'
    : !name.trim() ? 'Enter your full name.'
      : !signerTitle.trim() ? 'Enter your title.'
        : !consent ? 'Confirm that you sign this form electronically.' : '';

  const sign = async () => {
    setBusy(true);
    setError('');
    const d = await post<Submitted>('certform_esign', {
      actor: email, mock, source: party.source, agency: party.agency, kind,
      signer_name: name.trim(), signer_title: signerTitle.trim(), consent: true,
      answers: rows.filter(r => answers[r.row]?.code || answers[r.row]?.resource.trim())
        .map(r => ({ row: r.row, resource: answers[r.row].resource.trim(), code: answers[r.row].code })),
    });
    setBusy(false);
    setConfirming(false);
    if (!d.ok) {
      setError(agencyProblem(d, 'The form could not be signed. Please try again in a moment.'));
      return;
    }
    onSigned(d);
  };

  return (
    <div className="hcert-esign">
      <h4>Fill in and sign the {formName}</h4>
      {!data.esign_open && (
        <div className="hcm-banner">
          <strong>Pending approval.</strong> Agencies do not see electronic signature yet. You can use it because you are on the
          validation team, and a form you sign here counts as the form of {partyLabel(party)}.
        </div>
      )}
      <p className="hcert-note">
        Answer each data entity as you would on the Excel form, then sign with your details. The portal writes your answers and
        your signature into the form and keeps it with the certification.
      </p>
      <div className="sy-scroll">
        <table className="sy-table hcert-esign-rows">
          <thead>
            <tr><th>Data entity</th><th>Segment</th><th>Folder</th><th>Agency resource</th><th>Comment</th></tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const answer = answers[r.row] ?? { resource: '', code: '' };
              return (
                <tr key={r.row}>
                  <td>{r.entity}</td>
                  <td>{r.segment || '—'}</td>
                  <td>{r.folder || '—'}</td>
                  <td>
                    <input type="text" value={answer.resource} maxLength={200} disabled={busy || confirming}
                      aria-label={`Agency resource for ${r.entity}`} onChange={e => set(r.row, { resource: e.target.value })} />
                  </td>
                  <td>
                    <select value={answer.code} disabled={busy || confirming} aria-label={`Comment for ${r.entity}`}
                      onChange={e => set(r.row, { code: e.target.value })}>
                      <option value="">Choose a comment</option>
                      {r.options.map(code => <option key={code} value={code}>{responseShort(code)}</option>)}
                    </select>
                    {answer.code && <p className="hcert-esign-text" lang="es">{responses[answer.code]}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h4>Signature</h4>
      <div className="sy-form-grid">
        <label className="sy-field">
          <span>Name</span>
          <input type="text" value={name} maxLength={200} required autoComplete="name" disabled={busy || confirming}
            onChange={e => setName(e.target.value)} />
        </label>
        <label className="sy-field">
          <span>Title</span>
          <input type="text" value={signerTitle} maxLength={200} required autoComplete="organization-title" disabled={busy || confirming}
            onChange={e => setSignerTitle(e.target.value)} />
        </label>
        <div className="sy-field">
          <span>Signed with the account</span>
          <p className="hcert-esign-account">{data.signer?.email || email}</p>
        </div>
      </div>
      <label className="sy-check hcert-esign-consent">
        <input type="checkbox" checked={consent} disabled={busy || confirming} onChange={e => setConsent(e.target.checked)} />
        <span lang="es">{data.consent}</span>
      </label>

      {error && <div className="sy-error" role="alert">{error}</div>}
      {confirming ? (
        <div className="hcert-confirm" role="group" aria-label="Confirm the electronic signature">
          <p>
            You are signing the {formName} of <strong>{partyLabel(party)}</strong> as {name.trim()}, {signerTitle.trim()}.
            {' '}{count(answered, 'data entity has', 'data entities have')} a comment
            {answered < rows.length && `; ${rows.length - answered} without one`}.
          </p>
          <div className="sy-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Go back</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={sign}>{busy ? 'Signing…' : 'Yes, sign electronically'}</button>
          </div>
        </div>
      ) : (
        <div className="hcert-submit">
          {why && <p className="hcert-why" id={`hcert-esign-why-${kind}`}>{why}</p>}
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!!why} onClick={() => setConfirming(true)}
            aria-describedby={why ? `hcert-esign-why-${kind}` : undefined}>
            Sign electronically
          </button>
        </div>
      )}
    </div>
  );
}
