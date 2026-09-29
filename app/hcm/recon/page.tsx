'use client';

// Pre-load reconciliation reports of the sources: one workbook per entity and
// source, built from the conversion database's recon views and published to
// the source's Pre-Load Recon Reports folder through the distribution list.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import { ApiResult, apiGet, apiPost, fmtDateTime } from '../../lib/symphony';
import HcmShell, { fileTypeLabel, partyLabel, useHcm } from '../HcmShell';
import './recon.css';

Amplify.configure(config);

interface Target { source: string; agency: string; party?: string; module?: string; file_type?: string; entity?: string }
interface Report {
  entity: string;
  token: string;
  label: string;
  has_detail?: boolean;
  has_by_bu?: boolean;
  targets?: Target[];
  reason?: string;
  published?: { name: string; published_at?: string; published_by?: string } | null;
}
interface ReportList extends ApiResult { reports?: Report[]; sources?: string[] }
interface Generated extends ApiResult {
  name?: string;
  rows?: { summary?: number; detail?: number; by_bu?: number };
  truncated?: boolean;
  summary?: Record<string, string | number | null>;
  targets?: Target[];
  reason?: string;
  url?: string;
}
type Stage = { state: 'working' } | { state: 'done'; result: Generated } | { state: 'failed'; error: string };

const PARALLEL = 2;
const idOf = (r: Report) => `${r.entity}|${r.token}`.toUpperCase();

function ReconReports() {
  const { mock, email, isSuperUser, view } = useHcm();
  const canGenerate = isSuperUser && view === 'staff';
  const [list, setList] = useState<ReportList | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [onlyRouted, setOnlyRouted] = useState(false);
  const [stages, setStages] = useState<Record<string, Stage>>({});
  const [running, setRunning] = useState(false);
  const latest = useRef(0);
  const stop = useRef(false);

  const load = useCallback(async () => {
    const id = ++latest.current;
    const d = await apiGet<ReportList>('recon_list', { mock, email });
    if (id !== latest.current) return;
    setError(d.ok ? '' : d.error || 'The recon reports could not be loaded');
    if (d.ok) setList(d);
  }, [mock, email]);

  useEffect(() => {
    load();
    return () => { latest.current++; stop.current = true; };
  }, [load]);

  const reports = useMemo(() => [...(list?.reports ?? [])].sort((a, b) => a.token.localeCompare(b.token) || a.label.localeCompare(b.label)), [list]);
  const shown = reports.filter(r => (!source || r.token === source)
    && (!onlyRouted || (r.targets ?? []).length > 0)
    && (!search.trim() || `${r.label} ${r.entity} ${r.token}`.toLowerCase().includes(search.trim().toLowerCase())));
  const routed = reports.filter(r => (r.targets ?? []).length > 0);
  const published = reports.filter(r => r.published);

  const generate = async (r: Report) => {
    setStages(prev => ({ ...prev, [idOf(r)]: { state: 'working' } }));
    const d = await apiPost<Generated>('recon_generate', { actor: email, mock, entity: r.entity, token: r.token });
    setStages(prev => ({
      ...prev, [idOf(r)]: d.ok ? { state: 'done', result: d } : { state: 'failed', error: d.error || 'The report could not be generated' },
    }));
    return d.ok;
  };

  const generateAll = async () => {
    const queue = routed.filter(r => !source || r.token === source);
    if (!window.confirm(`Generate and publish ${queue.length} recon reports for ${mock}? Each one replaces the report already in the source's folder.`)) return;
    setRunning(true);
    stop.current = false;
    let next = 0;
    const worker = async () => {
      while (!stop.current && next < queue.length) {
        const r = queue[next++];
        await generate(r);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setRunning(false);
    load();
  };

  const done = Object.values(stages).filter(s => s.state !== 'working').length;
  const working = Object.values(stages).filter(s => s.state === 'working').length;

  if (!list) return error ? <div className="sy-error">{error} <button type="button" className="sy-link" onClick={load}>Try again</button></div>
    : <p className="hcm-loading">Loading…</p>;
  return (
    <>
      {error && <div className="sy-error" role="alert">{error}</div>}
      <section className="sy-stats" aria-label="Recon reports of the cycle">
        <div className="sy-stat"><div className="sy-stat-num">{reports.length}</div><div className="sy-stat-label">Reports (entity and source)</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{routed.length}</div><div className="sy-stat-label">In the distribution list</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{published.length}</div><div className="sy-stat-label">Published</div></div>
      </section>
      {routed.length < reports.length && (
        <div className="hcm-banner">
          {reports.length - routed.length} reports have no row in the cycle&apos;s file distribution list, so they cannot be published yet.
          They can still be generated and downloaded here.
        </div>
      )}

      <div className="hrc-controls">
        <label className="sy-field">
          <span>Source</span>
          <select value={source} onChange={e => setSource(e.target.value)}>
            <option value="">All sources</option>
            {(list.sources ?? []).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="sy-field">
          <span>Search</span>
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Entity or source" />
        </label>
        <label className="hrc-check">
          <input type="checkbox" checked={onlyRouted} onChange={e => setOnlyRouted(e.target.checked)} />
          <span>Only reports that can be published</span>
        </label>
        {canGenerate && (
          <button type="button" className="btn btn-primary" disabled={running || routed.length === 0} onClick={generateAll}>
            {running ? `Generating… ${done} done, ${working} in progress` : `Generate and publish${source ? ` ${source}` : ' all'}`}
          </button>
        )}
        {running && <button type="button" className="btn btn-secondary" onClick={() => { stop.current = true; }}>Stop after the current reports</button>}
      </div>

      <div className="hcm-card sy-scroll">
        <table className="sy-table hrc-table">
          <thead>
            <tr><th>Source</th><th>Entity</th><th>Goes to</th><th>Last published</th><th>Result</th>{canGenerate && <th />}</tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const stage = stages[idOf(r)];
              const result = stage?.state === 'done' ? stage.result : null;
              return (
                <tr key={idOf(r)}>
                  <td className="mono">{r.token}</td>
                  <td>
                    <div>{r.label}</div>
                    <div className="sy-muted small">{['Summary', r.has_detail && 'Detail', r.has_by_bu && 'By BU'].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>
                    {(r.targets ?? []).length > 0
                      ? (r.targets ?? []).map((t, i) => (
                        <div key={i}>{partyLabel(t)} · {[t.module, fileTypeLabel(t.file_type), t.entity].filter(Boolean).join(' / ')}</div>
                      ))
                      : <span className="sy-badge sy-badge-warn" title={r.reason}>Not in the distribution list</span>}
                  </td>
                  <td>{r.published ? `${fmtDateTime(r.published.published_at).slice(0, 16)}` : '—'}</td>
                  <td>
                    {!stage ? '—' : stage.state === 'working' ? <span className="sy-muted">Generating…</span>
                      : stage.state === 'failed' ? <span className="sy-error-text">{stage.error}</span> : (
                        <div className="hrc-result">
                          <div>
                            {Object.entries(result?.summary ?? {}).map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toLocaleString() : v ?? '—'}`).join(' · ')}
                          </div>
                          <div className="sy-muted small">
                            {(result?.targets ?? []).length > 0 ? 'Published' : 'Generated, not published'}
                            {result?.truncated ? ' · detail cut at the Excel row limit' : ''}
                            {result?.url && <> · <a href={result.url}>Download</a></>}
                          </div>
                        </div>
                      )}
                  </td>
                  {canGenerate && (
                    <td>
                      <button type="button" className="btn btn-secondary" disabled={running || stage?.state === 'working'} onClick={() => generate(r)}>
                        {(r.targets ?? []).length > 0 ? 'Generate and publish' : 'Generate'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr><td colSpan={canGenerate ? 6 : 5} className="sy-muted">No report matches the filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HcmReconPage() {
  return (
    <HcmShell title="Recon Reports" staffOnly wide
      subtitle="Pre-load reconciliation reports for each source, published to the source's Pre-Load Recon Reports folder.">
      <ReconReports />
    </HcmShell>
  );
}

export default withAuthenticator(HcmReconPage);
