'use client';

// The form that certifies one record: the response, the agency resource, notes
// and, for the "issues" response, every issue with its supporting documents.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiResult, apiGet } from '../../lib/symphony';
import { HcmParty, formatSize, useHcm } from '../HcmShell';
import {
  Attachment, CertRecord, Documents, ISSUES, IssuesResult, ResponseOption, agencyProblem, count, post, recordName, responseGloss,
} from './shared';

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// An issue on screen. It exists on the server once it has an id; `saved` is the
// description stored there and `text` what the user is typing.
interface Entry { key: string; id?: number; saved: string; text: string; reportedBy: string; documents: Attachment[] }

interface IssueSaved extends ApiResult { id?: number }
interface UploadUrl extends ApiResult { key?: string; url?: string; content_type?: string }
interface DocumentAdded extends ApiResult { id?: number; file_name?: string; size?: number }

const draft = (n: number): Entry => ({ key: `draft-${n}`, saved: '', text: '', reportedBy: '', documents: [] });

export default function CertifyForm({ record, party, responses, onTouched, onSaved, onCancel }: {
  record: CertRecord;
  party: HcmParty;
  responses: ResponseOption[];
  onTouched: () => void;               // an issue or a document changed on the server
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const { mock, email, isSuperUser } = useHcm();
  const { source, agency } = party;
  const { module, file_type: fileType, entity } = record;
  const name = recordName(record);

  const [response, setResponse] = useState(record.response_code || '');
  const [resource, setResource] = useState(record.resource_name || '');
  const [notes, setNotes] = useState(record.notes || '');
  const [items, setItems] = useState<Entry[] | null>(null);      // null until the record's issues are loaded
  const [issuesFailed, setIssuesFailed] = useState(false);
  const [working, setWorking] = useState<{ key: string; text: string } | null>(null);   // key: an issue, or 'submit'
  const [saved, setSaved] = useState<{ key: string; text: string } | null>(null);       // what was just saved on an issue
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const latest = useRef(0);
  const drafts = useRef(0);
  const id = useId();
  const busy = working !== null;

  useEffect(() => { heading.current?.focus(); }, []);

  const loadIssues = useCallback(async () => {
    const request = ++latest.current;
    setItems(null);
    setIssuesFailed(false);
    const d = await apiGet<IssuesResult>('cert_issues', { mock, email, source, agency, module, file_type: fileType, entity });
    if (request !== latest.current) return;
    if (!d.ok) {
      setIssuesFailed(true);
      return;
    }
    setItems((d.issues ?? []).map(i => ({
      key: `issue-${i.id}`, id: i.id, saved: i.description || '', text: i.description || '',
      reportedBy: i.reported_by || '', documents: i.attachments ?? [],
    })));
  }, [mock, email, source, agency, module, fileType, entity]);

  useEffect(() => {
    loadIssues();
    return () => { latest.current++; };
  }, [loadIssues]);

  // The "issues" response always has an issue to fill in.
  useEffect(() => {
    if (response === ISSUES && items && items.length === 0) setItems([draft(++drafts.current)]);
  }, [response, items]);

  const patch = (key: string, change: Partial<Entry>) =>
    setItems(prev => (prev ?? []).map(e => (e.key === key ? { ...e, ...change } : e)));
  const drop = (key: string) => setItems(prev => (prev ?? []).filter(e => e.key !== key));
  const mine = (author?: string | null) => isSuperUser || (author || '').toLowerCase() === email.toLowerCase();
  const recordIds = { actor: email, mock, source, agency, module, file_type: fileType, entity };

  const saveIssue = async (e: Entry) => {
    const text = e.text.trim();
    setWorking({ key: e.key, text: 'Saving the issue…' });
    setSaved(null);
    setError('');
    const d = await post<IssueSaved>('cert_issue_save', { ...recordIds, id: e.id, description: text });
    setWorking(null);
    const issueId = e.id ?? d.id;
    if (!d.ok || !issueId) {
      setError(agencyProblem(d, 'The issue could not be saved. Please try again in a moment.'));
      return;
    }
    onTouched();
    patch(e.key, { id: issueId, saved: text, text, reportedBy: e.reportedBy || email });
    setSaved({ key: e.key, text: e.id ? 'The description was saved.' : 'The issue was saved. Now add its supporting documents.' });
  };

  const removeIssue = async (e: Entry, position: number) => {
    if (!e.id) {
      drop(e.key);
      return;
    }
    if (!window.confirm(`Remove issue ${position} and its documents from ${name}?`)) return;
    setWorking({ key: e.key, text: 'Removing the issue…' });
    setSaved(null);
    setError('');
    const d = await post<ApiResult>('cert_issue_delete', { actor: email, id: e.id });
    setWorking(null);
    if (!d.ok) {
      setError(agencyProblem(d, 'The issue could not be removed. Please try again in a moment.'));
      return;
    }
    onTouched();
    drop(e.key);
  };

  const addDocuments = async (e: Entry, files: File[]) => {
    const target = { actor: email, mock, source, agency, cert_type: 'ISSUE', cert_key: String(e.id) };
    const problems: string[] = [];
    const added: Attachment[] = [];
    setSaved(null);
    setError('');
    for (const file of files) {
      if (file.size === 0) {
        problems.push(`${file.name} is empty.`);
        continue;
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        problems.push(`${file.name} is ${formatSize(file.size)}. The limit is 25 MB.`);
        continue;
      }
      const failed = `${file.name} could not be uploaded. Please try again.`;
      setWorking({ key: e.key, text: `Uploading ${file.name}…` });
      const up = await post<UploadUrl>('cert_upload_url', {
        ...target, file_name: file.name, content_type: file.type || 'application/octet-stream', size: file.size,
      });
      if (!up.ok || !up.url || !up.key) {
        problems.push(agencyProblem(up, failed));
        continue;
      }
      try {
        // The link is signed for one content type; send exactly that one.
        const put = await fetch(up.url, {
          method: 'PUT',
          headers: { 'Content-Type': up.content_type || file.type || 'application/octet-stream' },
          body: file,
        });
        if (!put.ok) throw new Error(String(put.status));
      } catch {
        problems.push(failed);
        continue;
      }
      const d = await post<DocumentAdded>('cert_attachment_add', { ...target, key: up.key, file_name: file.name });
      if (!d.ok || !d.id) {
        problems.push(agencyProblem(d, failed));
        continue;
      }
      added.push({ id: d.id, file_name: d.file_name || file.name, size: d.size ?? file.size, uploaded_by: email });
    }
    setWorking(null);
    if (added.length > 0) {
      onTouched();
      setItems(prev => (prev ?? []).map(x => (x.key === e.key ? { ...x, documents: [...x.documents, ...added] } : x)));
      setSaved({ key: e.key, text: `${count(added.length, 'document was', 'documents were')} added.` });
    }
    if (problems.length > 0) setError(problems.join(' '));
  };

  const removeDocument = async (e: Entry, a: Attachment) => {
    if (!window.confirm(`Remove ${a.file_name}?`)) return;
    setWorking({ key: e.key, text: `Removing ${a.file_name}…` });
    setSaved(null);
    setError('');
    const d = await post<ApiResult>('cert_attachment_delete', { actor: email, id: a.id });
    setWorking(null);
    if (!d.ok) {
      setError(agencyProblem(d, `${a.file_name} could not be removed. Please try again in a moment.`));
      return;
    }
    onTouched();
    setItems(prev => (prev ?? []).map(x => (x.key === e.key ? { ...x, documents: x.documents.filter(doc => doc.id !== a.id) } : x)));
    setSaved({ key: e.key, text: `${a.file_name} was removed.` });
  };

  // Why the certification cannot be submitted yet; empty when it can.
  const why = (() => {
    if (!response) return 'Choose one of the three responses.';
    if (!resource.trim()) return 'Enter the full name of the agency resource.';
    if (items === null) return issuesFailed ? 'The issues of this record must load before you can submit.' : 'Loading the issues of this record…';
    if (response !== ISSUES) return '';
    if (items.some(e => !e.text.trim())) return 'Write a description for every issue.';
    if (items.some(e => !e.id || e.text.trim() !== e.saved)) return 'Save the description of every issue.';
    if (items.some(e => e.documents.length === 0)) return 'Add at least one supporting document to every issue.';
    return '';
  })();

  const submit = async () => {
    // Issues are only kept with the response that reports them.
    const leftovers = response === ISSUES ? [] : (items ?? []).filter(e => e.id);
    const foreign = leftovers.find(e => !mine(e.reportedBy));
    if (foreign) {
      setError(`This record has an issue reported by ${foreign.reportedBy}. Only that person or the validation team can remove it, `
        + 'and it must be removed before this response can be saved.');
      return;
    }
    if (leftovers.length > 0 && !window.confirm(
      `Issues are only kept with the response that reports them. ${count(leftovers.length, 'issue', 'issues')} on ${name} will be removed. Continue?`)) return;

    setWorking({ key: 'submit', text: '' });
    setError('');
    for (const e of leftovers) {
      const removed = await post<ApiResult>('cert_issue_delete', { actor: email, id: e.id });
      if (!removed.ok) {
        setWorking(null);
        setError(agencyProblem(removed, 'An issue of this record could not be removed, so the response was not saved. Please try again in a moment.'));
        return;
      }
      onTouched();
      drop(e.key);
    }
    const d = await post<ApiResult>('cert_certify_file', {
      ...recordIds, response_code: response, resource_name: resource.trim(), notes: notes.trim(),
    });
    setWorking(null);
    if (!d.ok) {
      setError(agencyProblem(d, 'The certification could not be saved. Please try again in a moment.'));
      return;
    }
    onSaved(`${name} was certified.`);
  };

  return (
    <section className="hcert-form" aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`} ref={heading} tabIndex={-1}>{record.certified ? 'Change the response for' : 'Certify'} {name}</h4>

      <fieldset disabled={busy}>
        <legend>Your response</legend>
        {responses.length === 0 && <div className="sy-error">The responses could not be loaded. Please reload the page.</div>}
        <div className="hcert-choices">
          {responses.map(r => (
            <label key={r.code} className={`hcert-choice${response === r.code ? ' hcert-choice-on' : ''}`}>
              <input type="radio" name={`${id}-response`} value={r.code} checked={response === r.code}
                onChange={() => setResponse(r.code)} />
              <span>
                <span className="hcert-choice-label" lang="es">{r.label}</span>
                <span className="hcert-choice-gloss">{responseGloss(r.code)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {response === ISSUES && (
        <div>
          <h5>Issues you are reporting</h5>
          <p className="hcert-note">Report each issue separately. Every issue needs a description and at least one supporting document.</p>
          {items === null ? !issuesFailed && <p className="hcert-note">Loading…</p> : (
            <>
              <ol className="hcert-issues">
                {items.map((e, i) => {
                  const own = !e.id || mine(e.reportedBy);
                  const unsaved = !e.id || e.text.trim() !== e.saved;
                  return (
                    <li key={e.key} className="hcert-issue">
                      <div className="hcert-issue-head">
                        <span>Issue {i + 1}</span>
                        {own && (e.id || items.length > 1) && (
                          <button type="button" className="sy-link" disabled={busy} onClick={() => removeIssue(e, i + 1)}
                            aria-label={`Remove issue ${i + 1}`}>
                            Remove issue
                          </button>
                        )}
                      </div>
                      <label className="sy-field">
                        <span>Description of the issue (required)</span>
                        <textarea value={e.text} maxLength={4000} readOnly={!own} disabled={busy}
                          onChange={ev => patch(e.key, { text: ev.target.value })} />
                      </label>
                      {!own && <p className="hcert-note">Reported by {e.reportedBy}. Only that person can change or remove it.</p>}
                      {own && unsaved && (
                        <div>
                          <button type="button" className="btn btn-secondary" disabled={busy || !e.text.trim()} onClick={() => saveIssue(e)}>
                            {e.id ? 'Save description' : 'Save issue'}
                          </button>
                        </div>
                      )}
                      {e.id ? (
                        <>
                          <div className="hcert-label">Supporting documents</div>
                          <Documents items={e.documents} email={email} staff={false} disabled={busy}
                            empty="No document yet. Add at least one."
                            canRemove={a => mine(a.uploaded_by)} onRemove={a => removeDocument(e, a)} />
                          <label className="sy-field">
                            <span>Add supporting documents (up to 25 MB each)</span>
                            <input type="file" multiple disabled={busy} onChange={ev => {
                              const files = Array.from(ev.target.files ?? []);
                              ev.target.value = '';
                              if (files.length > 0) addDocuments(e, files);
                            }} />
                          </label>
                        </>
                      ) : <p className="hcert-note">Save the issue first. Then you can add its supporting documents.</p>}
                      {working?.key === e.key ? <p className="hcert-note" role="status">{working.text}</p>
                        : saved?.key === e.key && <p className="hcert-note hcert-saved" role="status">{saved.text}</p>}
                    </li>
                  );
                })}
              </ol>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setItems(prev => [...(prev ?? []), draft(++drafts.current)])}>
                Add another issue
              </button>
            </>
          )}
        </div>
      )}

      <div className="sy-form-grid">
        <label className="sy-field">
          <span>Agency resource (your full name)</span>
          <input type="text" value={resource} maxLength={200} required autoComplete="name" disabled={busy}
            onChange={e => setResource(e.target.value)} />
        </label>
        <label className="sy-field">
          <span>Notes (optional)</span>
          <textarea value={notes} disabled={busy} onChange={e => setNotes(e.target.value)} />
        </label>
      </div>

      {issuesFailed && (
        <div className="sy-error" role="alert">
          The issues of this record could not be loaded.{' '}
          <button type="button" className="sy-link" onClick={loadIssues}>Try again</button>
        </div>
      )}
      {error && <div className="sy-error" role="alert">{error}</div>}
      <div className="hcert-submit">
        {why && <p className="hcert-why" id={`${id}-why`}>{why}</p>}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !!why} onClick={submit}
          aria-describedby={why ? `${id}-why` : undefined}>
          {working?.key === 'submit' ? 'Saving…' : record.certified ? 'Save new response' : 'Submit certification'}
        </button>
      </div>
    </section>
  );
}
