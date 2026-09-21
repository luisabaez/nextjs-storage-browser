'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import { ApiResult, apiGet, apiPost, fmtDateTime } from '../../lib/symphony';
import HcmShell, { formatSize, useHcm } from '../HcmShell';

Amplify.configure(config);

interface Guide { name: string; size?: number; last_modified?: string }
interface GuideList extends ApiResult { guides?: Guide[] }
interface GuideUrl extends ApiResult { url?: string }
interface GuideUploadUrl extends ApiResult { url?: string; key?: string; content_type?: string }

const MAX_BYTES = 50 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const extension = (name: string) => (name.includes('.') ? name.split('.').pop() || '' : '').toLowerCase();

function problemWith(file: File): string {
  if (!CONTENT_TYPES[extension(file.name)]) return 'Choose a PDF, Word (.docx), PowerPoint (.pptx) or Excel (.xlsx) file.';
  if (file.size > MAX_BYTES) return `${file.name} is ${formatSize(file.size)}. The limit is 50 MB.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return '';
}

const DocumentIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h6" />
  </svg>
);

function Guides() {
  const { mock, email, view, isSuperUser } = useHcm();
  const canManage = isSuperUser && view === 'staff';
  // The server's own wording is for the validation team; an agency gets the plain sentence.
  const reason = (d: ApiResult, plain: string) => (view === 'staff' && d.error) || plain;
  const [guides, setGuides] = useState<Guide[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');          // the guide being opened or removed
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latest.current;
    const d = await apiGet<GuideList>('guide_list', { mock, email });
    if (id !== latest.current) return;
    setLoadError(d.ok ? '' : d.error || 'The user guides could not be loaded');
    setGuides(d.ok && Array.isArray(d.guides) ? d.guides : []);
  }, [mock, email]);

  useEffect(() => { load(); }, [load]);

  const clearFile = () => {
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const choose = (chosen: File | null) => {
    setError('');
    setNotice('');
    const problem = chosen ? problemWith(chosen) : '';
    if (problem) {
      setError(problem);
      clearFile();
    } else {
      setFile(chosen);
    }
  };

  const open = async (name: string) => {
    setBusy(name);
    setError('');
    const d = await apiGet<GuideUrl>('guide_url', { mock, name, email });
    setBusy('');
    if (!d.ok || !d.url) {
      setError(reason(d, `${name} could not be opened. Please try again in a moment.`));
      return;
    }
    window.location.assign(d.url);
  };

  const upload = async () => {
    if (!file) return;
    const exists = (guides ?? []).some(g => g.name.toLowerCase() === file.name.toLowerCase());
    if (exists && !window.confirm(`${file.name} is already in ${mock}. Replace it?`)) return;
    setUploading(true);
    setError('');
    setNotice('');
    const d = await apiPost<GuideUploadUrl>('guide_upload_url', {
      actor: email, mock, file_name: file.name, content_type: CONTENT_TYPES[extension(file.name)], size: file.size,
    });
    let problem = '';
    if (!d.ok || !d.url) {
      problem = d.error || 'The upload could not be started';
    } else {
      try {
        // The link is signed for one content type; send exactly that one.
        const resp = await fetch(d.url, {
          method: 'PUT',
          headers: { 'Content-Type': d.content_type || CONTENT_TYPES[extension(file.name)] },
          body: file,
        });
        if (!resp.ok) problem = `The upload did not complete (${resp.status}). Please try again.`;
      } catch (e) {
        problem = `The upload did not complete: ${(e as Error).message}`;
      }
    }
    setUploading(false);
    if (problem) {
      setError(problem);
      return;
    }
    setNotice(`${file.name} was added to ${mock}.`);
    clearFile();
    load();
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Remove ${name} from ${mock}?\n\nAgencies will no longer see it.`)) return;
    setBusy(name);
    setError('');
    setNotice('');
    const d = await apiPost<ApiResult>('guide_delete', { actor: email, mock, name });
    setBusy('');
    if (!d.ok) {
      setError(d.error || `${name} could not be removed`);
      return;
    }
    setNotice(`${name} was removed.`);
    load();
  };

  return (
    <>
      {loadError && <div className="sy-error">{view === 'staff' ? loadError : 'The user guides could not be loaded. Please try again in a moment.'}</div>}
      {error && <div className="sy-error" role="alert">{error}</div>}
      {notice && <div className="sy-success" role="status">{notice}</div>}

      {canManage && (
        <section className="hcm-card">
          <h2>Add a user guide</h2>
          <p className="sy-muted">Agencies see every guide added to {mock}. PDF, Word, PowerPoint or Excel, up to 50 MB.</p>
          <div className="hcm-upload">
            <label className="sy-field">
              <span>File</span>
              <input ref={fileInput} type="file" accept=".pdf,.docx,.pptx,.xlsx" disabled={uploading}
                onChange={e => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="button" className="btn btn-primary" disabled={!file || uploading} onClick={upload}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </section>
      )}

      {guides === null ? <p className="hcm-loading">Loading…</p> : guides.length === 0 ? (
        !loadError && <div className="hcm-empty"><p>No user guide has been added for this cycle yet.</p></div>
      ) : (
        <ul className="hcm-list">
          {guides.map(g => (
            <li key={g.name} className="hcm-row">
              <span className="hcm-row-icon"><DocumentIcon /></span>
              <div className="hcm-row-main">
                <div className="hcm-row-title">{g.name}</div>
                <div className="hcm-row-meta">
                  {[formatSize(g.size), g.last_modified ? `Updated ${fmtDateTime(g.last_modified).slice(0, 16)}` : ''].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="hcm-row-actions">
                <button type="button" className="btn btn-primary" disabled={busy === g.name} onClick={() => open(g.name)}
                  aria-label={`Open ${g.name}`}>
                  {busy === g.name ? 'Please wait…' : 'Open'}
                </button>
                {canManage && (
                  <button type="button" className="btn btn-secondary" disabled={busy === g.name || uploading} onClick={() => remove(g.name)}
                    aria-label={`Remove ${g.name}`}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function HcmGuidePage() {
  return (
    <HcmShell title="User Guide" subtitle="Instructions for the selected Mock Cycle.">
      <Guides />
    </HcmShell>
  );
}

export default withAuthenticator(HcmGuidePage);
