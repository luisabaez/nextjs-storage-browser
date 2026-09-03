'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import './data-validation.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';

Amplify.configure(config);

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';
// Site-wide mock: every file and validation runs against this mock until the
// project moves as a whole to the next one.
const PLAN_MOCK = 'MOCK14';
const PAGE_SIZE = 200;

interface ProgramEntry { program: string; rules: number; runnable: boolean; sources: string[] }
interface Rule {
  code: string; message: string; message_spa: string | null; long_description: string | null;
  entity: string | null; type: string | null; severity: string | null; severity_criteria: string | null;
  transformation_logic: string | null; not_in_scope: string | null; before_send: string | null;
  count: number; sources: Record<string, number>; last_run: string | null; run_number: number | null;
}
interface Summary { ok: boolean; rules: Rule[]; sources: string[]; unknown_codes: string[]; error?: string }
interface DetailRow {
  ERROR_MSG: string; Entity: string; File: string; File_PROCESSED_DTTM: string; VALIDATION_TYPE: string;
  Source: string; Validation_Code: string; BU: string; Validation_PROCESSED_DTTM: string;
  RECORD_COUNT: string | null; cols: (string | null)[];
}
interface Detail { ok: boolean; total: number; offset: number; limit: number; col_names: string[]; rows: DetailRow[]; error?: string }
interface RunEntry { program: string; source: string; mock: string; at: string | null; user: string | null }
interface RunResult {
  ok: boolean; error?: string; dry_run: boolean; views: { view: string; rows: number; codes: Record<string, number>; error?: string }[];
  warnings: string[]; partial: boolean; total_rows: number; elapsed_s: number; run_number: number | null; codes: Record<string, number>;
}

const fmtDate = (iso: string | null | undefined) => (iso ? iso.replace('T', ' ').slice(0, 19) : '—');

function DataValidationPage() {
  const [userEmail, setUserEmail] = useState('');
  const [programs, setPrograms] = useState<ProgramEntry[]>([]);
  const [program, setProgram] = useState('');
  const [source, setSource] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(true);
  const [selectedCode, setSelectedCode] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [running, setRunning] = useState<'' | 'preview' | 'run'>('');
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchUserAttributes().then(a => setUserEmail(a.email || '')).catch(() => {});
    fetch(`${LAMBDA_URL}?action=val_programs&mock=${PLAN_MOCK}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setPrograms(d.programs); else setError(d.error || 'Could not load programs'); })
      .catch(e => setError(`Network error: ${(e as Error).message}`));
  }, []);

  const current = programs.find(p => p.program === program);

  const loadSummary = useCallback(async (prog: string, src: string) => {
    if (!prog) return;
    setLoadingSummary(true);
    setError('');
    try {
      const url = `${LAMBDA_URL}?action=val_summary&mock=${PLAN_MOCK}&program=${encodeURIComponent(prog)}`
        + (src ? `&source=${encodeURIComponent(src)}` : '');
      const d: Summary = await (await fetch(url)).json();
      if (!d.ok) setError(d.error || 'Summary failed'); else setSummary(d);
      const r = await (await fetch(`${LAMBDA_URL}?action=val_runs&mock=${PLAN_MOCK}&program=${encodeURIComponent(prog)}`)).json();
      if (r.ok) setRuns(r.runs);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  useEffect(() => {
    setSelectedCode('');
    setDetail(null);
    setRunResult(null);
    if (program) loadSummary(program, source); else setSummary(null);
  }, [program, source, loadSummary]);

  const loadDetail = useCallback(async (code: string, offset: number) => {
    setLoadingDetail(true);
    try {
      const url = `${LAMBDA_URL}?action=val_detail&mock=${PLAN_MOCK}&program=${encodeURIComponent(program)}`
        + (source ? `&source=${encodeURIComponent(source)}` : '')
        + `&code=${encodeURIComponent(code)}&limit=${PAGE_SIZE}&offset=${offset}`;
      const d: Detail = await (await fetch(url)).json();
      if (!d.ok) setError(d.error || 'Detail failed'); else { setDetail(d); setDetailOffset(offset); }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoadingDetail(false);
    }
  }, [program, source]);

  const selectCode = (code: string) => {
    if (code === selectedCode) { setSelectedCode(''); setDetail(null); return; }
    setSelectedCode(code);
    loadDetail(code, 0);
  };

  const runValidation = async (dryRun: boolean) => {
    if (!current?.runnable || !source) return;
    if (!dryRun && !window.confirm(
      `Run the ${program} validations for ${source} on ${PLAN_MOCK}?\n\n`
      + `This regenerates the source's validation views, replaces the stored results for `
      + `${program} / ${source} / ${PLAN_MOCK}, and logs the run under your name. It can take a few minutes.`
    )) return;
    setRunning(dryRun ? 'preview' : 'run');
    setRunResult(null);
    setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=val_run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program, source, mock: PLAN_MOCK, actor: userEmail, dry_run: dryRun }),
      });
      const d: RunResult = await resp.json();
      if (!d.ok) setError(d.error || 'Run failed');
      setRunResult(d);
      if (d.ok && !dryRun) await loadSummary(program, source);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setRunning('');
    }
  };

  const sourceOptions = Array.from(new Set([...(current?.sources || []), ...(summary?.sources || [])])).sort();
  const rules = (summary?.rules || []).filter(r => !onlyErrors || r.count > 0);
  const totalErrors = (summary?.rules || []).reduce((s, r) => s + r.count, 0);
  const sevClass = (s: string | null) => `dv-sev dv-sev-${(s || 'none').toLowerCase().replace(/[^a-z]/g, '')}`;

  return (
    <div className="dv-page">
      <header className="dv-header">
        <div>
          <h1>Data Validation <span className="dv-mock">{PLAN_MOCK}</span></h1>
          <p className="dv-sub">Results of the SQL data validations, by program and source. Assets and Inventory can be run from here; the other programs show the results their teams have logged.</p>
        </div>
        <div className="dv-links">
          <Link href="/validations" className="btn btn-secondary">Sampling</Link>
          <Link href="/" className="btn btn-secondary">← File Browser</Link>
        </div>
      </header>

      <section className="dv-controls">
        <label>
          <span>Program</span>
          <select value={program} onChange={e => { setProgram(e.target.value); setSource(''); }}>
            <option value="">Select a program…</option>
            {programs.map(p => (
              <option key={p.program} value={p.program}>{p.program} ({p.rules} rules){p.runnable ? ' — runnable' : ''}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Source</span>
          <select value={source} onChange={e => setSource(e.target.value)} disabled={!program}>
            <option value="">All sources</option>
            {sourceOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {current?.runnable && (
          <div className="dv-run-btns">
            <button className="btn btn-secondary" disabled={!source || !!running} onClick={() => runValidation(true)}
              title={source ? 'Iterate the views and count, without storing anything' : 'Pick a source first'}>
              {running === 'preview' ? 'Previewing…' : 'Preview counts'}
            </button>
            <button className="btn btn-primary" disabled={!source || !!running} onClick={() => runValidation(false)}
              title={source ? 'Run and store the results' : 'Pick a source first'}>
              {running === 'run' ? 'Running…' : 'Run validation'}
            </button>
          </div>
        )}
      </section>

      {running && <div className="dv-note">Running {program} for {source} — this iterates every validation view and can take a few minutes.</div>}
      {error && <div className="dv-error">{error}</div>}

      {runResult && (
        <section className={`dv-card ${runResult.ok ? 'dv-card-ok' : 'dv-card-err'}`}>
          <h2>{runResult.dry_run ? 'Preview' : 'Run'} {runResult.ok ? 'complete' : 'failed'}{runResult.partial ? ' (partial)' : ''}</h2>
          {runResult.ok && (
            <p>
              {runResult.views.length} views · {runResult.total_rows.toLocaleString()} rows · {runResult.elapsed_s}s
              {runResult.run_number != null && <> · run #{runResult.run_number}</>}
              {runResult.dry_run && <> · nothing was stored</>}
            </p>
          )}
          {Object.keys(runResult.codes || {}).length > 0 && (
            <div className="dv-chips">
              {Object.entries(runResult.codes).sort().map(([c, n]) => <span key={c} className="dv-chip">{c}: {n.toLocaleString()}</span>)}
            </div>
          )}
          {runResult.warnings?.length > 0 && (
            <ul className="dv-warnings">{runResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
        </section>
      )}

      {program && (
        <section className="dv-card">
          <div className="dv-card-head">
            <h2>{program}{source ? ` · ${source}` : ' · all sources'}</h2>
            <div className="dv-card-tools">
              <span className="dv-total">{totalErrors.toLocaleString()} logged rows across {summary?.rules.filter(r => r.count > 0).length || 0} rules</span>
              <label className="dv-check"><input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} /> only rules with results</label>
            </div>
          </div>
          {loadingSummary ? <p className="dv-muted">Loading…</p> : (
            <div className="dv-scroll">
              <table className="dv-table">
                <thead>
                  <tr>
                    <th>Code</th><th>Message</th><th>Entity</th><th>Type</th><th>Severity</th>
                    <th className="num">Rows</th><th>Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(r => (
                    <tr key={r.code} className={r.code === selectedCode ? 'dv-selected' : (r.count > 0 ? 'dv-clickable' : '')}
                      onClick={() => r.count > 0 && selectCode(r.code)}
                      title={r.message_spa || undefined}>
                      <td className="mono">{r.code}</td>
                      <td>
                        {r.message}
                        {r.long_description && <div className="dv-muted small">{r.long_description}</div>}
                        {r.transformation_logic && <div className="dv-muted small">Transformation: {r.transformation_logic}</div>}
                      </td>
                      <td>{r.entity}</td>
                      <td>{r.type}</td>
                      <td><span className={sevClass(r.severity)}>{r.severity || '—'}</span></td>
                      <td className="num">{r.count.toLocaleString()}</td>
                      <td className="dv-muted small">{fmtDate(r.last_run)}</td>
                    </tr>
                  ))}
                  {rules.length === 0 && <tr><td colSpan={7} className="dv-muted">No rules{onlyErrors ? ' with results' : ''} for this selection.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {summary && summary.unknown_codes.length > 0 && (
            <p className="dv-muted small">Logged codes not in the catalog: {summary.unknown_codes.join(', ')}</p>
          )}
        </section>
      )}

      {selectedCode && (
        <section className="dv-card">
          <div className="dv-card-head">
            <h2>{selectedCode} — failing rows</h2>
            {detail && (
              <div className="dv-card-tools">
                <span className="dv-total">{detail.offset + 1}–{Math.min(detail.offset + detail.rows.length, detail.total)} of {detail.total.toLocaleString()}</span>
                <button className="btn btn-secondary" disabled={loadingDetail || detail.offset === 0} onClick={() => loadDetail(selectedCode, Math.max(0, detail.offset - PAGE_SIZE))}>‹ Prev</button>
                <button className="btn btn-secondary" disabled={loadingDetail || detail.offset + PAGE_SIZE >= detail.total} onClick={() => loadDetail(selectedCode, detail.offset + PAGE_SIZE)}>Next ›</button>
              </div>
            )}
          </div>
          {loadingDetail || !detail ? <p className="dv-muted">Loading…</p> : (
            <div className="dv-scroll">
              <table className="dv-table dv-detail">
                <thead>
                  <tr>
                    <th>Source</th><th>BU</th><th>File</th><th>Message</th>
                    {detail.col_names.map(c => <th key={c}>{c}</th>)}
                    <th>Validated</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.rows.map((r, i) => (
                    <tr key={detailOffset + i}>
                      <td className="mono">{r.Source}</td>
                      <td className="mono">{r.BU}</td>
                      <td className="small">{r.File}</td>
                      <td>{r.ERROR_MSG}</td>
                      {r.cols.map((v, j) => <td key={j}>{v}</td>)}
                      <td className="dv-muted small">{fmtDate(r.Validation_PROCESSED_DTTM)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {program && runs.length > 0 && (
        <section className="dv-card">
          <h2>Recent runs · {program}</h2>
          <div className="dv-scroll">
            <table className="dv-table">
              <thead><tr><th>When</th><th>Source</th><th>By</th></tr></thead>
              <tbody>
                {runs.slice(0, 25).map((r, i) => (
                  <tr key={i}><td className="small">{fmtDate(r.at)}</td><td className="mono">{r.source}</td><td className="small">{r.user}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

export default withAuthenticator(DataValidationPage);
