'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import { ApiResult, apiPost } from '../../lib/symphony';
import HcmShell, { formatSize, partyLabel, useHcm } from '../HcmShell';
import './publish.css';

Amplify.configure(config);

interface Target { source: string; agency: string; party?: string; module?: string; file_type?: string; entity?: string }
interface PreviewResult { name: string; matched?: boolean; targets?: Target[]; reason?: string }
interface Preview extends ApiResult { results?: PreviewResult[] }
interface UploadLink { name: string; key?: string; url?: string; content_type?: string }
interface UploadUrls extends ApiResult { batch?: string; uploads?: UploadLink[] }
interface Published extends ApiResult {
  published?: { name: string; targets?: Target[] }[];
  unmatched?: { name: string; reason?: string }[];
}

type Verdict = 'matched' | 'unmatched' | 'invalid';
interface Checked { file: File; verdict: Verdict; targets: Target[]; reason: string }
type Stage = 'waiting' | 'uploading' | 'uploaded' | 'published' | 'failed';
interface Progress { stage: Stage; reason?: string }

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PREVIEW = 5000;          // file names per check
const MAX_UPLOADS = 50;            // upload links per request
const MAX_PUBLISH = 25;            // files per publish request
const PARALLEL_UPLOADS = 4;
// Upload links last 15 minutes, so one set of links covers no more than this much data.
const GROUP_BYTES = 250 * 1024 * 1024;

const STEPS = ['Choose files', 'Check where they go', 'Publish'];
const VERDICT: Record<Verdict, { label: string; badge: string }> = {
  matched: { label: 'Matched', badge: 'sy-badge sy-badge-ok' },
  unmatched: { label: 'Not matched', badge: 'sy-badge sy-badge-warn' },
  invalid: { label: 'Cannot be published', badge: 'sy-badge sy-badge-bad' },
};
const STAGE: Record<Stage, { label: string; badge: string }> = {
  waiting: { label: 'Waiting', badge: 'sy-badge' },
  uploading: { label: 'Uploading', badge: 'sy-badge sy-badge-info' },
  uploaded: { label: 'Uploaded', badge: 'sy-badge sy-badge-info' },
  published: { label: 'Published', badge: 'sy-badge sy-badge-ok' },
  failed: { label: 'Not published', badge: 'sy-badge sy-badge-bad' },
};
const WAITING: Progress = { stage: 'waiting' };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const contentType = (file: File) => file.type || 'application/octet-stream';

function problemWith(file: File): string {
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_FILE_BYTES) return `The file is ${formatSize(file.size)}. The limit is 200 MB.`;
  return '';
}

/** Files in sets that share one request for upload links. */
function uploadGroups(files: File[]): File[][] {
  const groups: File[][] = [];
  let bytes = 0;
  files.forEach(f => {
    const last = groups[groups.length - 1];
    if (!last || last.length >= MAX_UPLOADS || bytes + f.size > GROUP_BYTES) {
      groups.push([f]);
      bytes = f.size;
    } else {
      last.push(f);
      bytes += f.size;
    }
  });
  return groups;
}

/** Sends one file to its upload link; resolves to what went wrong, or ''. */
async function send(url: string, type: string, file: File): Promise<string> {
  try {
    // The link is signed for one content type; send exactly that one.
    const resp = await fetch(url, { method: 'PUT', headers: { 'Content-Type': type }, body: file });
    return resp.ok ? '' : `The upload did not complete (${resp.status})`;
  } catch (e) {
    return `The upload did not complete: ${(e as Error).message}`;
  }
}

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);

function Destinations({ targets }: { targets: Target[] }) {
  const list = (
    <ul className="hp-targets">
      {targets.map((t, i) => (
        <li key={i}>
          <span className="hp-target-party">{partyLabel(t)}</span>
          <span className="hp-target-folder">{[t.module, t.file_type, t.entity].filter(Boolean).join(' / ')}</span>
        </li>
      ))}
    </ul>
  );
  if (targets.length <= 3) return list;
  return (
    <details className="hp-more">
      <summary>{targets.length.toLocaleString()} destinations</summary>
      {list}
    </details>
  );
}

const StatusRow = React.memo(function StatusRow({ file, progress }: { file: File; progress: Progress }) {
  return (
    <tr>
      <td className="hp-name">{file.name}</td>
      <td className="num">{formatSize(file.size)}</td>
      <td><span className={STAGE[progress.stage].badge}>{STAGE[progress.stage].label}</span></td>
      <td>{progress.reason || ''}</td>
    </tr>
  );
});

function Publish() {
  const { mock, email } = useHcm();
  const [step, setStep] = useState(1);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [checked, setChecked] = useState<Checked[] | null>(null);
  const [checkError, setCheckError] = useState('');
  const [onlySkipped, setOnlySkipped] = useState(false);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [running, setRunning] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const latest = useRef(0);
  const alive = useRef(true);

  // The page leaves when the Mock Cycle changes: a run in progress stops after the file it is on.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A new step starts at its heading for keyboard and screen reader users.
  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [step]);
  const go = (n: number) => { moved.current = true; setStep(n); };

  const add = (list: FileList | null) => {
    const chosen = Array.from(list ?? []);
    if (picker.current) picker.current.value = '';
    if (chosen.length === 0) return;
    // A name chosen again replaces the earlier choice: a folder holds one file per name.
    setFiles(prev => Array.from(new Map([...prev, ...chosen].map(f => [f.name, f])).values()));
  };

  const check = async () => {
    const id = ++latest.current;
    go(2);
    setChecked(null);
    setCheckError('');
    setOnlySkipped(false);
    const results = new Map<string, PreviewResult>();
    for (let i = 0; i < files.length; i += MAX_PREVIEW) {
      const d = await apiPost<Preview>('pub_preview', {
        actor: email, mock, names: files.slice(i, i + MAX_PREVIEW).map(f => f.name),
      });
      if (id !== latest.current) return;
      if (!d.ok) {
        setCheckError(d.error || 'The file names could not be checked');
        return;
      }
      (d.results ?? []).forEach(r => results.set(r.name, r));
    }
    setChecked(files.map(file => {
      const problem = problemWith(file);
      if (problem) return { file, verdict: 'invalid', targets: [], reason: problem };
      const r = results.get(file.name);
      const targets = r?.matched && Array.isArray(r.targets) ? r.targets : [];
      return targets.length > 0
        ? { file, verdict: 'matched', targets, reason: '' }
        : { file, verdict: 'unmatched', targets, reason: r?.reason || 'No destination was found for this file name' };
    }));
  };

  const back = () => {
    latest.current++;
    go(1);
  };

  const mark = (names: string[], next: Progress) =>
    setProgress(prev => ({ ...prev, ...Object.fromEntries(names.map(n => [n, next])) }));

  const publish = async () => {
    const ready = (checked ?? []).filter(c => c.verdict === 'matched').map(c => c.file);
    go(3);
    setProgress({});
    setRunning(true);
    let batch = '';
    for (const group of uploadGroups(ready)) {
      if (!alive.current) return;
      const names = group.map(f => f.name);
      const d = await apiPost<UploadUrls>('pub_upload_urls', {
        actor: email, mock, batch: batch || undefined,
        files: group.map(f => ({ name: f.name, size: f.size, content_type: contentType(f) })),
      });
      if (!d.ok || !d.batch || !Array.isArray(d.uploads)) {
        mark(names, { stage: 'failed', reason: d.error || 'The upload could not be started' });
        continue;
      }
      batch = d.batch;
      const links = new Map(d.uploads.map(u => [u.name, u]));
      const uploaded: string[] = [];
      const queue = [...group];
      const worker = async () => {
        for (let f = queue.shift(); f && alive.current; f = queue.shift()) {
          const link = links.get(f.name);
          if (!link?.url) {
            mark([f.name], { stage: 'failed', reason: 'The upload could not be started' });
            continue;
          }
          mark([f.name], { stage: 'uploading' });
          const problem = await send(link.url, link.content_type || contentType(f), f);
          if (problem) {
            mark([f.name], { stage: 'failed', reason: problem });
          } else {
            uploaded.push(f.name);
            mark([f.name], { stage: 'uploaded' });
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, worker));
      for (let i = 0; i < uploaded.length && alive.current; i += MAX_PUBLISH) {
        const sent = uploaded.slice(i, i + MAX_PUBLISH);
        const p = await apiPost<Published>('pub_publish', { actor: email, mock, batch, names: sent });
        if (!p.ok) {
          mark(sent, { stage: 'failed', reason: p.error || 'The files could not be published' });
          continue;
        }
        const done = new Set((p.published ?? []).map(x => x.name));
        const reasons = new Map((p.unmatched ?? []).map(x => [x.name, x.reason]));
        mark(sent.filter(n => done.has(n)), { stage: 'published' });
        sent.filter(n => !done.has(n)).forEach(n =>
          mark([n], { stage: 'failed', reason: reasons.get(n) || 'The file was not published' }));
      }
    }
    if (alive.current) setRunning(false);
  };

  const startOver = () => {
    setFiles([]);
    setChecked(null);
    setProgress({});
    go(1);
  };

  const steps = (
    <ol className="hp-steps">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i + 1 === step ? 'step' : undefined}
          className={`hp-step${i + 1 === step ? ' hp-step-current' : i + 1 < step ? ' hp-step-done' : ''}`}>
          <span className="hp-step-number">{i + 1}</span>
          <span>{label}</span>
          {i + 1 < step && <span className="hp-hidden"> (done)</span>}
        </li>
      ))}
    </ol>
  );

  if (step === 1) {
    const bytes = files.reduce((n, f) => n + f.size, 0);
    return (
      <>
        {steps}
        <section className="hcm-card">
          <h2 ref={heading} tabIndex={-1}>Choose the files to publish</h2>
          <p className="sy-muted">Choose as many files as you need. Nothing is uploaded yet: first you see where each file goes.</p>
          <div className={`hp-drop${dragging ? ' hp-drop-active' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={e => { e.preventDefault(); setDragging(false); add(e.dataTransfer.files); }}>
            <span className="hp-drop-icon"><UploadIcon /></span>
            <p className="hp-drop-title">Drag and drop files here</p>
            <p className="hp-drop-or">or</p>
            <button type="button" className="btn btn-secondary" onClick={() => picker.current?.click()}>Choose files</button>
            <input ref={picker} type="file" multiple hidden tabIndex={-1} aria-label="Files to publish"
              onChange={e => add(e.target.files)} />
          </div>
          {files.length > 0 && (
            <div className="hp-chosen" role="status">
              <strong>{plural(files.length, 'file', 'files')} chosen</strong>
              <span className="sy-muted">{formatSize(bytes)} in total</span>
              <button type="button" className="sy-link" onClick={() => setFiles([])}>Remove all</button>
            </div>
          )}
          <div className="hp-actions">
            <button type="button" className="btn btn-primary" disabled={files.length === 0} onClick={check}>
              Check where they go
            </button>
          </div>
        </section>
      </>
    );
  }

  if (step === 2) {
    if (!checked) {
      return (
        <>
          {steps}
          <section className="hcm-card">
            <h2 ref={heading} tabIndex={-1}>Check where the files go</h2>
            {checkError ? (
              <>
                <div className="sy-error" role="alert">{checkError}</div>
                <div className="hp-actions">
                  <button type="button" className="btn btn-secondary" onClick={back}>Back</button>
                  <button type="button" className="btn btn-primary" onClick={check}>Try again</button>
                </div>
              </>
            ) : (
              <>
                <p className="hcm-loading" role="status">Checking {plural(files.length, 'file name', 'file names')}…</p>
                <div className="hp-actions">
                  <button type="button" className="btn btn-secondary" onClick={back}>Back</button>
                </div>
              </>
            )}
          </section>
        </>
      );
    }
    const count = (v: Verdict) => checked.filter(c => c.verdict === v).length;
    const matched = count('matched');
    const unmatched = count('unmatched');
    const invalid = count('invalid');
    const skipped = unmatched + invalid;
    // Files that will be skipped come first, so they are not missed in a long list.
    const rows = [...checked.filter(c => c.verdict !== 'matched'), ...(onlySkipped ? [] : checked.filter(c => c.verdict === 'matched'))];
    return (
      <>
        {steps}
        <section className="hcm-card">
          <h2 ref={heading} tabIndex={-1}>Check where the files go</h2>
          <p className="hp-lead">
            {matched === 0 ? 'None of these files can be published.'
              : `${matched.toLocaleString()} of ${plural(checked.length, 'file', 'files')} will be published.`}
            {skipped > 0 && ` ${plural(skipped, 'file is', 'files are')} skipped.`}
          </p>
          <div className="hp-counts">
            <span className={VERDICT.matched.badge}>{matched.toLocaleString()} matched</span>
            <span className={VERDICT.unmatched.badge}>{unmatched.toLocaleString()} not matched</span>
            {invalid > 0 && <span className={VERDICT.invalid.badge}>{invalid.toLocaleString()} cannot be published</span>}
          </div>
          {unmatched > 0 && (
            <p className="sy-muted">A file is matched when its name starts with a name in the file distribution list of {mock}.</p>
          )}
          <div className="hp-actions">
            <button type="button" className="btn btn-secondary" onClick={back}>Back</button>
            <button type="button" className="btn btn-primary" disabled={matched === 0} onClick={publish}>
              {matched === 0 ? 'Publish' : `Publish ${plural(matched, 'file', 'files')}`}
            </button>
          </div>
        </section>

        {skipped > 0 && matched > 0 && (
          <label className="sy-check hp-filter">
            <input type="checkbox" checked={onlySkipped} onChange={e => setOnlySkipped(e.target.checked)} />
            Show only the files that are skipped
          </label>
        )}
        <div className="hp-table" role="region" aria-label="Where each file goes" tabIndex={0}>
          <table className="sy-table">
            <thead>
              <tr><th>File</th><th className="num">Size</th><th>Result</th><th>Goes to</th></tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.file.name}>
                  <td className="hp-name">{c.file.name}</td>
                  <td className="num">{formatSize(c.file.size)}</td>
                  <td><span className={VERDICT[c.verdict].badge}>{VERDICT[c.verdict].label}</span></td>
                  <td>{c.verdict === 'matched' ? <Destinations targets={c.targets} /> : c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  const ready = (checked ?? []).filter(c => c.verdict === 'matched').map(c => c.file);
  const stageOf = (f: File) => (progress[f.name] ?? WAITING).stage;
  const published = ready.filter(f => stageOf(f) === 'published').length;
  const failed = ready.filter(f => stageOf(f) === 'failed').length;
  const done = published + failed;
  const percent = ready.length ? Math.round((done / ready.length) * 100) : 0;
  // Once finished, the files that were not published come first.
  const rows = running ? ready : [...ready.filter(f => stageOf(f) === 'failed'), ...ready.filter(f => stageOf(f) !== 'failed')];
  return (
    <>
      {steps}
      <section className="hcm-card">
        <h2 ref={heading} tabIndex={-1}>{running ? 'Publishing…' : 'Finished'}</h2>
        <div className="sy-progress hp-progress" role="progressbar" aria-label="Files done"
          aria-valuemin={0} aria-valuemax={ready.length} aria-valuenow={done}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className="hp-lead">{done.toLocaleString()} of {plural(ready.length, 'file', 'files')} done</p>
        {running ? (
          <p className="sy-muted">
            Keep this page open until it finishes. If it closes before that, nothing is lost: choose the same files again
            and publish them again. A file that is published twice simply replaces the earlier one.
          </p>
        ) : (
          <>
            <div role="status">
              {published > 0 && <div className="sy-success">{plural(published, 'file was', 'files were')} published.</div>}
              {failed > 0 && (
                <div className="sy-error">
                  {plural(failed, 'file was', 'files were')} not published. The reason is next to each one below. You can choose
                  the same files again: a file that is published twice simply replaces the earlier one.
                </div>
              )}
            </div>
            <div className="hp-actions">
              <Link href="/hcm/files" className="btn btn-secondary">See the published files</Link>
              <button type="button" className="btn btn-primary" onClick={startOver}>Publish more files</button>
            </div>
          </>
        )}
      </section>

      <div className="hp-table" role="region" aria-label="Progress of each file" tabIndex={0}>
        <table className="sy-table">
          <thead>
            <tr><th>File</th><th className="num">Size</th><th>Status</th><th>Details</th></tr>
          </thead>
          <tbody>
            {rows.map(f => <StatusRow key={f.name} file={f} progress={progress[f.name] ?? WAITING} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HcmPublishPage() {
  return (
    <HcmShell superOnly title="Publish Files"
      subtitle="Files are matched by the start of their name against the cycle's file distribution list.">
      <Publish />
    </HcmShell>
  );
}

export default withAuthenticator(HcmPublishPage);
