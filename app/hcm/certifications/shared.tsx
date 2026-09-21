'use client';

// Types and small pieces shared by the agency view and the staff view of the
// certifications page.
import React, { useEffect, useRef, useState } from 'react';
import { ApiResult, LAMBDA_URL, apiGet, fmtDateTime } from '../../lib/symphony';
import { formatSize } from '../HcmShell';

export interface ResponseOption { code: string; label: string }

/** One expected certification: Module + File type + Entity of a source / agency. */
export interface CertRecord {
  source: string;
  agency: string;
  bu?: string;
  party?: string;
  module: string;
  file_type: string;
  entity: string;
  certified?: boolean;
  response_code?: string | null;
  resource_name?: string | null;
  notes?: string | null;
  certified_by?: string | null;
  certified_at?: string | null;
  issues?: number;               // how many issues are reported on the record
}

export interface Attachment {
  id: number;
  file_name: string;
  size?: number | null;
  uploaded_by?: string | null;
  uploaded_at?: string | null;
}

export interface Issue {
  id: number;
  source: string;
  agency: string;
  party?: string;
  module: string;
  file_type: string;
  entity: string;
  description: string;
  reported_by?: string | null;
  reported_at?: string | null;
  certified?: boolean;           // the record the issue belongs to has been certified
  attachments?: Attachment[];
}
export interface IssuesResult extends ApiResult { issues?: Issue[] }

interface DownloadUrl extends ApiResult { url?: string }

export const ISSUES = 'ISSUES';

// The responses are shown in the wording the server sends; these go with them.
const RESPONSE_INFO: Record<string, { short: string; gloss: string; badge: string }> = {
  AGREE: { short: 'Agrees with the errors', gloss: 'I agree with the errors shown and they will be corrected', badge: 'sy-badge-info' },
  ISSUES: {
    short: 'Issues reported', badge: 'sy-badge-warn',
    gloss: 'The data is partly or completely incorrect - I am reporting issues with supporting documents',
  },
  NO_ERRORS: { short: 'No errors', gloss: 'I verified the data and it has no errors', badge: 'sy-badge-ok' },
};

export const responseGloss = (code: string) => RESPONSE_INFO[code]?.gloss || '';
export const responseShort = (code?: string | null) => (code && RESPONSE_INFO[code]?.short) || 'Certified';

export function ResponseBadge({ code, responses }: { code?: string | null; responses?: ResponseOption[] }) {
  const info = code ? RESPONSE_INFO[code] : undefined;
  const label = responses?.find(r => r.code === code)?.label;
  return <span className={`sy-badge ${info?.badge || 'sy-badge-ok'}`} title={label}>{responseShort(code)}</span>;
}

/** The server's key of a party: the source and the agency number, or the agency's name when it has no number. */
export function partyId(p: { source: string; agency: string }): string {
  const agency = (p.agency || '').trim();
  const number = /^(\d{3})(?!\d)/.exec(agency);
  return `${(p.source || '').trim().toUpperCase()}|${number ? number[1] : agency.toUpperCase()}`;
}

export type RecordName = Pick<CertRecord, 'module' | 'file_type' | 'entity'>;

export const recordKey = (r: RecordName) =>
  [r.module, r.file_type, r.entity].map(s => (s || '').trim().toUpperCase()).join('|');

export const recordName = (r: RecordName) =>
  [r.module, r.file_type, r.entity].map(s => (s || '').trim()).filter(Boolean).join(' · ');

export const filesHref = (r: RecordName) =>
  `/hcm/files?${new URLSearchParams({ module: r.module || '', file_type: r.file_type || '', entity: r.entity || '' }).toString()}`;

export const day = (iso?: string | null) => (iso ? fmtDateTime(iso).slice(0, 10) : '');
export const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export type Written<T> = T & { status: number };

/** apiPost that keeps the HTTP status: a 400 or a 409 from a change tells the user what to fix. */
export async function post<T extends ApiResult>(action: string, body: Record<string, unknown>): Promise<Written<T>> {
  try {
    const resp = await fetch(`${LAMBDA_URL}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ...((await resp.json()) as T), status: resp.status };
  } catch (e) {
    return { ok: false, error: `Network error: ${(e as Error).message}`, status: 0 } as Written<T>;
  }
}

/** What an agency reads when a change fails: the server's sentence when it says what to fix, otherwise a plain one. */
export const agencyProblem = (d: Written<ApiResult>, plain: string) =>
  ((d.status === 400 || d.status === 409) && d.error) || plain;

/** Documents of an issue: download for everyone, Remove where the page allows it. */
export function Documents({ items, email, staff, empty, disabled, canRemove, onRemove }: {
  items: Attachment[];
  email: string;
  staff: boolean;                // staff read the server's own error text
  empty: string;
  disabled?: boolean;
  canRemove?: (a: Attachment) => boolean;
  onRemove?: (a: Attachment) => void;
}) {
  const [opening, setOpening] = useState(0);
  const [error, setError] = useState('');

  const download = async (a: Attachment) => {
    setOpening(a.id);
    setError('');
    const d = await apiGet<DownloadUrl>('cert_download_url', { id: a.id, email });
    setOpening(0);
    if (!d.ok || !d.url) {
      setError((staff && d.error) || `${a.file_name} could not be downloaded. Please try again in a moment.`);
      return;
    }
    // Served as an attachment: it downloads in place and the page stays.
    window.location.assign(d.url);
  };

  if (items.length === 0) return <p className="hcert-note">{empty}</p>;
  return (
    <>
      {error && <div className="sy-error" role="alert">{error}</div>}
      <ul className="hcert-docs">
        {items.map(a => (
          <li key={a.id} className="hcert-doc">
            <span className="hcert-doc-name">{a.file_name}</span>
            {formatSize(a.size) && <span className="sy-muted">{formatSize(a.size)}</span>}
            <button type="button" className="sy-link" disabled={opening === a.id} onClick={() => download(a)}
              aria-label={`Download ${a.file_name}`}>
              {opening === a.id ? 'Please wait…' : 'Download'}
            </button>
            {onRemove && canRemove?.(a) && (
              <button type="button" className="sy-link" disabled={disabled} onClick={() => onRemove(a)}
                aria-label={`Remove ${a.file_name}`}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Asks for the reason of a revoke before it happens. */
export function ReasonForm({ heading, text, action, busy, error, onSubmit, onCancel }: {
  heading: string;
  text: string;
  action: string;
  busy: boolean;
  error: string;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);

  return (
    <form className="hcert-confirm" onSubmit={e => { e.preventDefault(); if (reason.trim()) onSubmit(reason.trim()); }}>
      <h3>{heading}</h3>
      <p>{text}</p>
      <label className="sy-field">
        <span>Reason (required)</span>
        <textarea ref={box} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} />
      </label>
      {error && <div className="sy-error" role="alert">{error}</div>}
      <div className="sy-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !reason.trim()}>{busy ? 'Please wait…' : action}</button>
      </div>
    </form>
  );
}
