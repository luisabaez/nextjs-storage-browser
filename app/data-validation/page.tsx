'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import '../lib/symphony.css';
import './data-validation.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import { ApiResult, apiGet, apiPost, fmtDateTime as fmtDate, ROLE_LABEL, useSymphonySession } from '../lib/symphony';

Amplify.configure(config);

const PAGE_SIZE = 200;

interface ProgramEntry {
  program: string; rules: number; pillar?: string; runnable: boolean; mode: 'views' | 'sp' | null;
  runs_via: string | null; sources: string[];
}
interface ProgramsResponse extends ApiResult { mock: string; db: string; is_test: boolean; programs: ProgramEntry[] }
interface Rule {
  code: string; message: string; message_spa: string | null; long_description: string | null;
  entity: string | null; type: string | null; severity: string | null; severity_criteria: string | null;
  transformation_logic: string | null; not_in_scope: string | null; before_send: string | null;
  count: number; sources: Record<string, number>; last_run: string | null; run_number: number | null;
}
interface Summary extends ApiResult { rules: Rule[]; sources: string[]; unknown_codes: string[] }
interface DetailRow {
  ERROR_MSG: string; Entity: string; File: string; File_PROCESSED_DTTM: string; VALIDATION_TYPE: string;
  Source: string; Validation_Code: string; BU: string; Validation_PROCESSED_DTTM: string;
  RECORD_COUNT: string | null; cols: (string | null)[];
}
interface Detail extends ApiResult { total: number; offset: number; limit: number; col_names: string[]; rows: DetailRow[] }
interface RunEntry { program: string; source: string; mock: string; at: string | null; user: string | null }
interface RunsResponse extends ApiResult { runs: RunEntry[] }
interface RunResult extends ApiResult {
  dry_run: boolean; views: { view: string; rows: number; codes: Record<string, number>; error?: string }[];
  warnings: string[]; partial: boolean; total_rows: number; elapsed_s: number; run_number: number | null; codes: Record<string, number>;
  report_key?: string; report_name?: string; report_rows?: number;
}
interface ReportEntry { key: string; name: string; program: string; source: string; size: number; last_modified: string }
interface ReportsResponse extends ApiResult { prefix: string; reports: ReportEntry[] }
interface ReportUrl extends ApiResult { url: string }
interface SeedResponse extends ApiResult { created: number; copied: number; skipped: number; failed: string[] }
interface AgencyReport extends ApiResult { key: string; name: string; rows: number; url: string; warnings: string[] }

function DataValidationPage() {
  const session = useSymphonySession();
  const { email, mock, isSuperUser } = session;
  const [programs, setPrograms] = useState<ProgramEntry[]>([]);
  const [db, setDb] = useState<{ name: string; isTest: boolean } | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string>('');
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
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [running, setRunning] = useState<'' | 'preview' | 'run'>('');
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [error, setError] = useState('');
  const [agencyBu, setAgencyBu] = useState('');
  const [audience, setAudience] = useState<'agency' | 'source'>('agency');
  const [generating, setGenerating] = useState(false);
  const [agencyReport, setAgencyReport] = useState<AgencyReport | null>(null);

  // Programs (and the sources each can run for) depend on the mock being shown.
  useEffect(() => {
    if (!session.ready || !mock) return;
    let stale = false;
    apiGet<ProgramsResponse>('val_programs', { mock, email }).then(d => {
      if (stale) return;
      if (d.ok) { setPrograms(d.programs); setDb({ name: d.db, isTest: !!d.is_test }); }
      else setError(d.error || 'Could not load programs');
    });
    return () => { stale = true; };
  }, [session.ready, mock, email]);

  const current = programs.find(p => p.program === program);
  // The catalog's pillar decides; a server that does not send it yet falls back to the run mode.
  const isHcm = !!current && (current.pillar ? current.pillar.toUpperCase() === 'HCM' : current.mode === 'sp');

  const loadReports = useCallback(async (prog: string, src: string) => {
    const rep = await apiGet<ReportsResponse>('val_reports', { mock, program: prog, source: src, email });
    if (rep.ok) setReports(rep.reports);
  }, [mock, email]);

  // Each load takes a ticket; a response is applied only while its ticket is
  // still the latest, so a slow answer for a previous program / source / mock
  // can never land on the current selection.
  const summarySeq = useRef(0);
  const detailSeq = useRef(0);

  const loadSummary = useCallback(async (prog: string, src: string) => {
    if (!prog || !mock) return;
    const mine = ++summarySeq.current;
    setLoadingSummary(true);
    setError('');
    const d = await apiGet<Summary>('val_summary', { mock, program: prog, source: src, email });
    if (mine !== summarySeq.current) return;
    if (!d.ok) setError(d.error || 'Summary failed'); else setSummary(d);
    const r = await apiGet<RunsResponse>('val_runs', { mock, program: prog, email });
    if (mine !== summarySeq.current) return;
    if (r.ok) setRuns(r.runs);
    const rep = await apiGet<ReportsResponse>('val_reports', { mock, program: prog, source: src, email });
    if (mine !== summarySeq.current) return;
    if (rep.ok) setReports(rep.reports);
    setLoadingSummary(false);
  }, [mock, email]);

  useEffect(() => {
    detailSeq.current++;
    setSelectedCode('');
    setDetail(null);
    setRunResult(null);
    setAgencyReport(null);
    if (program) loadSummary(program, source); else setSummary(null);
  }, [program, source, loadSummary]);

  const loadDetail = useCallback(async (code: string, offset: number) => {
    const mine = ++detailSeq.current;
    setLoadingDetail(true);
    const d = await apiGet<Detail>('val_detail', { mock, program, source, code, limit: PAGE_SIZE, offset, email });
    if (mine !== detailSeq.current) return;
    if (!d.ok) setError(d.error || 'Detail failed'); else { setDetail(d); setDetailOffset(offset); }
    setLoadingDetail(false);
  }, [mock, program, source, email]);

  const selectCode = (code: string) => {
    if (code === selectedCode) { detailSeq.current++; setSelectedCode(''); setDetail(null); setLoadingDetail(false); return; }
    setSelectedCode(code);
    loadDetail(code, 0);
  };

  const runValidation = async (dryRun: boolean) => {
    if (!current?.runnable || !source || !isSuperUser) return;
    if (!dryRun && !window.confirm(
      `Run the ${program} validations for ${source} on ${mock}?\n\n`
      + `This regenerates the source's validation views, replaces the stored results for `
      + `${program} / ${source} / ${mock}, and logs the run under your name. It can take a few minutes.`
    )) return;
    setRunning(dryRun ? 'preview' : 'run');
    setRunResult(null);
    setError('');
    const d = await apiPost<RunResult>('val_run', { program, source, mock, actor: email, dry_run: dryRun });
    if (!d.ok) setError(d.error || 'Run failed');
    setRunResult(d);
    if (d.ok && !dryRun) await loadSummary(program, source);
    setRunning('');
  };

  // The workbooks hold person-level rows: the server checks the caller's role
  // before handing out a short-lived link.
  const openReport = async (key: string) => {
    const d = await apiGet<ReportUrl>('val_report_url', { key, email });
    if (!d.ok) { setError(d.error || 'Could not open report'); return; }
    window.location.assign(d.url);  // served as an attachment: downloads in place, no pop-up to block
  };

  const generateAgencyWorkbook = async () => {
    if (!isHcm || !source || !isSuperUser) return;
    setGenerating(true);
    setAgencyReport(null);
    setError('');
    const d = await apiPost<AgencyReport>('val_agency_report', { actor: email, mock, source, bu: agencyBu.trim(), audience });
    if (!d.ok) setError(d.error || 'Agency workbook failed');
    else {
      setAgencyReport(d);
      window.location.assign(d.url);
      await loadReports(program, source);
    }
    setGenerating(false);
  };

  const prepareTestDb = async () => {
    if (!current?.runnable || !source || !isSuperUser) return;
    setSeeding(true);
    setSeedResult('');
    setError('');
    const d = await apiPost<SeedResponse>('val_seed', { program, source, mock, actor: email });
    if (!d.ok) setError(d.error || 'Prepare failed');
    else setSeedResult(`Created ${d.created}, copied with rows ${d.copied}, already present ${d.skipped}, failed ${d.failed.length}` + (d.failed.length ? ` — ${d.failed.join('; ')}` : ''));
    setSeeding(false);
  };

  const sourceOptions = Array.from(new Set([...(current?.sources || []), ...(summary?.sources || [])])).sort();
  const rules = (summary?.rules || []).filter(r => !onlyErrors || r.count > 0);
  const totalErrors = (summary?.rules || []).reduce((s, r) => s + r.count, 0);
  const sevClass = (s: string | null) => `sy-sev sy-sev-${(s || 'none').toLowerCase().replace(/[^a-z]/g, '')}`;

  if (!session.ready) return <div className="sy-page"><p className="sy-muted">Loading…</p></div>;
  if (!isSuperUser) {
    return (
      <div className="sy-denied">
        <h2>Data Validation</h2>
        <p>{session.error || 'These screens show record-level validation results and are limited to super users. Agency users and certification reviewers work from the Data Cleanse Log and Certifications pages.'}</p>
        <Link href="/" className="btn btn-secondary">← File Browser</Link>
      </div>
    );
  }

  return (
    <div className="sy-page">
      <header className="sy-header">
        <div>
          <h1>
            Data Validation <span className="sy-mock">{mock}</span>
            {db && <span className={`sy-mock${db.isTest ? ' sy-test' : ''}`}>{db.name}{db.isTest ? ' · test' : ''}</span>}
            <span className="sy-pill sy-pill-role">{ROLE_LABEL[session.role] || session.role}</span>
            <label className="dv-mock-pick">
              Mock Cycle
              <select value={mock} onChange={e => { session.setMock(e.target.value); setSource(''); }}>
                {session.mocks.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </h1>
          <p className="sy-sub">Results of the SQL data validations, by program and source. Programs marked runnable can be run from here for a source; the rest show the results their teams have logged.</p>
        </div>
        <div className="sy-links">
          <Link href="/validations" className="btn btn-secondary">Sampling</Link>
          <Link href="/" className="btn btn-secondary">← File Browser</Link>
        </div>
      </header>

      <section className="sy-controls">
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
        {current?.runnable && isSuperUser && (
          <div className="sy-run-btns">
            {db?.isTest && (
              <button className="btn btn-secondary" disabled={!source || !!running || seeding} onClick={prepareTestDb}
                title="Create the tables, procedures and views this program needs in the test database (also done automatically on Run)">
                {seeding ? 'Preparing…' : 'Prepare test DB'}
              </button>
            )}
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

      {db?.isTest && (
        <div className="sy-note">Validation is pointed at the test database <code>{db.name}</code>. Runs create the tables, procedures and views they need there by cloning definitions from Hacienda_ERP; staging tables start empty until files are loaded.</div>
      )}
      {isHcm && source && isSuperUser && (
        <section className="sy-controls dv-agency">
          <label className="dv-narrow">
            <span>Business unit (optional)</span>
            <input className="sy-input" value={agencyBu} onChange={e => setAgencyBu(e.target.value)} placeholder="e.g. 010" maxLength={20} />
          </label>
          <label className="dv-narrow">
            <span>Audience</span>
            <select value={audience} onChange={e => setAudience(e.target.value as 'agency' | 'source')}>
              <option value="agency">Agency</option>
              <option value="source">Source</option>
            </select>
          </label>
          <button className="btn btn-secondary" disabled={generating} onClick={generateAgencyWorkbook}
            title={`One workbook with every HCM validation reported to the ${audience} for ${source}${agencyBu.trim() ? ` / ${agencyBu.trim()}` : ''}, built from the stored results`}>
            {generating ? 'Generating…' : 'Generate agency workbook'}
          </button>
          {agencyReport && (
            <span className="sy-muted small">
              <button className="sy-link" onClick={() => openReport(agencyReport.key)}>{agencyReport.name}</button>
              {' '}· {agencyReport.rows.toLocaleString()} rows
              {agencyReport.warnings?.length > 0 && <> · {agencyReport.warnings.join('; ')}</>}
            </span>
          )}
        </section>
      )}
      {seedResult && <div className="sy-note">{seedResult}</div>}
      {current?.runs_via && isSuperUser && !running && (
        <div className="sy-note">{program} runs through the validation team&apos;s procedure <code>{current.runs_via}</code>; Preview lists the views without running them.</div>
      )}
      {running && <div className="sy-note">Running {program} for {source} — this runs every validation view and can take a few minutes.</div>}
      {(error || session.error) && <div className="sy-error">{error || session.error}</div>}

      {runResult && (
        <section className={`sy-card ${runResult.ok ? 'sy-card-ok' : 'sy-card-err'}`}>
          <h2>{runResult.dry_run ? 'Preview' : 'Run'} {runResult.ok ? 'complete' : 'failed'}{runResult.partial ? ' (partial)' : ''}</h2>
          {runResult.ok && (
            <p>
              {runResult.views.length} views · {runResult.total_rows.toLocaleString()} rows · {runResult.elapsed_s}s
              {runResult.run_number != null && <> · run #{runResult.run_number}</>}
              {runResult.dry_run && <> · nothing was stored</>}
            </p>
          )}
          {runResult.report_key && (
            <p>
              Client report: <button className="sy-link" onClick={() => openReport(runResult.report_key!)}>{runResult.report_name}</button>
              {' '}({(runResult.report_rows || 0).toLocaleString()} rows) — saved under <code>{runResult.report_key.split('/').slice(0, -1).join('/')}</code>
            </p>
          )}
          {Object.keys(runResult.codes || {}).length > 0 && (
            <div className="sy-chips">
              {Object.entries(runResult.codes).sort().map(([c, n]) => <span key={c} className="sy-chip">{c}: {n.toLocaleString()}</span>)}
            </div>
          )}
          {runResult.warnings?.length > 0 && (
            <ul className="sy-warnings">{runResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
        </section>
      )}

      {program && (
        <section className="sy-card">
          <div className="sy-card-head">
            <h2>{program}{source ? ` · ${source}` : ' · all sources'}</h2>
            <div className="sy-card-tools">
              <span className="sy-total">{totalErrors.toLocaleString()} logged rows across {summary?.rules.filter(r => r.count > 0).length || 0} rules</span>
              <label className="sy-check"><input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} /> only rules with results</label>
            </div>
          </div>
          {loadingSummary ? <p className="sy-muted">Loading…</p> : (
            <div className="sy-scroll">
              <table className="sy-table">
                <thead>
                  <tr>
                    <th>Code</th><th>Message</th><th>Entity</th><th>Type</th><th>Severity</th>
                    <th className="num">Rows</th><th>Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(r => (
                    <tr key={r.code} className={r.code === selectedCode ? 'sy-selected' : (r.count > 0 ? 'sy-clickable' : '')}
                      onClick={() => r.count > 0 && selectCode(r.code)}
                      title={r.message_spa || undefined}>
                      <td className="mono">{r.code}</td>
                      <td>
                        {r.message}
                        {r.long_description && <div className="sy-muted small">{r.long_description}</div>}
                        {r.transformation_logic && <div className="sy-muted small">Transformation: {r.transformation_logic}</div>}
                      </td>
                      <td>{r.entity}</td>
                      <td>{r.type}</td>
                      <td><span className={sevClass(r.severity)}>{r.severity || '—'}</span></td>
                      <td className="num">{r.count.toLocaleString()}</td>
                      <td className="sy-muted small">{fmtDate(r.last_run)}</td>
                    </tr>
                  ))}
                  {rules.length === 0 && <tr><td colSpan={7} className="sy-muted">No rules{onlyErrors ? ' with results' : ''} for this selection.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {summary && summary.unknown_codes.length > 0 && (
            <p className="sy-muted small">Logged codes not in the catalog: {summary.unknown_codes.join(', ')}</p>
          )}
        </section>
      )}

      {selectedCode && (
        <section className="sy-card">
          <div className="sy-card-head">
            <h2>{selectedCode} — failing rows</h2>
            {detail && (
              <div className="sy-card-tools">
                <span className="sy-total">{detail.offset + 1}–{Math.min(detail.offset + detail.rows.length, detail.total)} of {detail.total.toLocaleString()}</span>
                <button className="btn btn-secondary" disabled={loadingDetail || detail.offset === 0} onClick={() => loadDetail(selectedCode, Math.max(0, detail.offset - PAGE_SIZE))}>‹ Prev</button>
                <button className="btn btn-secondary" disabled={loadingDetail || detail.offset + PAGE_SIZE >= detail.total} onClick={() => loadDetail(selectedCode, detail.offset + PAGE_SIZE)}>Next ›</button>
              </div>
            )}
          </div>
          {loadingDetail || !detail ? <p className="sy-muted">Loading…</p> : (
            <div className="sy-scroll">
              <table className="sy-table sy-detail">
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
                      <td className="sy-muted small">{fmtDate(r.Validation_PROCESSED_DTTM)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {program && reports.length > 0 && (
        <section className="sy-card">
          <h2>Client reports · {program}{source ? ` · ${source}` : ''}</h2>
          <p className="sy-muted small">Excel workbooks (summary, failing rows and the error message legend) generated by each run{isHcm ? ', plus the per-agency workbooks' : ''}, stored under <code>DataValidation/Reports/{mock}/</code>. Send the latest one per file to the client.</p>
          <div className="sy-scroll">
            <table className="sy-table">
              <thead><tr><th>Generated</th><th>Source</th><th>Report</th><th className="num">Size</th></tr></thead>
              <tbody>
                {reports.slice(0, 40).map(r => (
                  <tr key={r.key}>
                    <td className="small">{fmtDate(r.last_modified)}</td>
                    <td className="mono">{r.source}</td>
                    <td><button className="sy-link" onClick={() => openReport(r.key)}>{r.name}</button></td>
                    <td className="num small">{Math.round(r.size / 1024).toLocaleString()} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {program && runs.length > 0 && (
        <section className="sy-card">
          <h2>Recent runs · {program}</h2>
          <div className="sy-scroll">
            <table className="sy-table">
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
