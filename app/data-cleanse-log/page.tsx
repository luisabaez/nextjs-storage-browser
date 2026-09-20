'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import '../lib/symphony.css';
import './data-cleanse-log.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import { ApiResult, ROLE_LABEL, apiGet, apiPost, useSymphonySession } from '../lib/symphony';

Amplify.configure(config);

type Pillar = 'HCM' | 'FSCM';
type Layout = 'by_bu' | 'summary';
type Cell = string | number | boolean | null;

interface CleanseLog extends ApiResult {
  mock: string; pillar: Pillar; layout: Layout;
  db: string; is_test: boolean;
  source: 'view' | 'query'; view_name: string | null;
  columns: string[]; rows: Cell[][];
  total: number; truncated: boolean;
  sources: string[]; warnings: string[];
}
interface CleanseLogExport extends ApiResult {
  key: string; name: string; rows: number; truncated: boolean; warnings: string[]; url: string;
}

// Rows drawn at once; the rest stay a click away so a large log does not freeze the tab.
const RENDER_LIMIT = 2000;
const LONG_TEXT = ['notes', 'severity_criteria', 'transformationlogicapplied'];

const defaultPillar = (mock: string): Pillar => (mock.toUpperCase().includes('HCM') ? 'HCM' : 'FSCM');
const text = (v: Cell) => (v === null || v === undefined ? '' : String(v).trim());
const isCount = (column: string) => column.toLowerCase().endsWith(' count');
// The team's views spell the message column "Error Messge".
const isMessage = (column: string) => column.toLowerCase().startsWith('error mess');

function DataCleanseLogPage() {
  const session = useSymphonySession();
  const { email, mock, ready } = session;
  const allowed = session.canCertify || session.canReview;

  const [pillarChoice, setPillarChoice] = useState<Pillar | ''>('');
  const [layout, setLayout] = useState<Layout>('by_bu');
  const [readMain, setReadMain] = useState(false);
  const [isTest, setIsTest] = useState(false);
  const [log, setLog] = useState<CleanseLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<CleanseLogExport | null>(null);
  const latest = useRef(0);

  const pillar: Pillar = pillarChoice || defaultPillar(mock);

  const load = useCallback(async () => {
    if (!mock || !email) return;
    const id = ++latest.current;
    setLoading(true);
    setError('');
    setExported(null);
    const d = await apiGet<CleanseLog>('cleanse_log', { mock, pillar, layout, email, db: readMain ? 'main' : undefined });
    if (id !== latest.current) return;   // a newer selection is already loading
    setLoading(false);
    setShowAll(false);
    if (!d.ok) {
      setLog(null);
      setError(d.error || 'Could not load the Data Cleanse Log');
      return;
    }
    setLog(d);
    setIsTest(d.is_test);
    setSourceFilter(prev => (d.sources.includes(prev) ? prev : ''));
  }, [mock, pillar, layout, email, readMain]);

  useEffect(() => {
    if (ready && allowed) load();
  }, [ready, allowed, load]);

  const columns = useMemo(() => log?.columns ?? [], [log]);
  const idx = useMemo(() => {
    const find = (test: (c: string) => boolean) => columns.findIndex(c => test(c.trim().toLowerCase()));
    // "<MOCK> Count" is the cycle's own column (a view may also carry the previous cycle's)
    const mockCount = find(c => c === `${(log?.mock || '').toLowerCase()} count`);
    return {
      code: find(c => c === 'validation code'),
      message: find(isMessage),
      entity: find(c => c === 'entity'),
      type: find(c => c === 'validation type'),
      source: find(c => c === 'source'),
      bu: find(c => c === 'bu'),
      count: mockCount >= 0 ? mockCount : find(isCount),
      severity: find(c => c === 'severity'),
    };
  }, [columns, log]);

  const types = useMemo(() => {
    if (!log || idx.type < 0) return [];
    return Array.from(new Set(log.rows.map(r => text(r[idx.type])).filter(Boolean))).sort();
  }, [log, idx.type]);

  const activeType = types.includes(typeFilter) ? typeFilter : '';

  const rows = useMemo(() => {
    if (!log) return [];
    const needle = search.trim().toLowerCase();
    const searched = [idx.code, idx.message, idx.entity].filter(i => i >= 0);
    return log.rows.filter(r =>
      (!sourceFilter || text(r[idx.source]) === sourceFilter)
      && (!activeType || text(r[idx.type]) === activeType)
      && (!needle || searched.some(i => text(r[i]).toLowerCase().includes(needle))));
  }, [log, idx, sourceFilter, activeType, search]);

  const stats = useMemo(() => {
    const distinct = (i: number) => (i < 0 ? null : new Set(rows.map(r => text(r[i])).filter(Boolean)).size);
    const occurrences = idx.count < 0 ? null : rows.reduce((sum, r) => sum + (Number(r[idx.count]) || 0), 0);
    return { codes: distinct(idx.code), occurrences, sources: distinct(idx.source), bus: distinct(idx.bu) };
  }, [rows, idx]);

  const exportExcel = async () => {
    setExporting(true);
    setError('');
    setExported(null);
    const d = await apiPost<CleanseLogExport>('cleanse_log_export', {
      mock, pillar, layout, email, actor: email, db: readMain ? 'main' : undefined,
    });
    setExporting(false);
    if (!d.ok) {
      setError(d.error || 'The export failed');
      return;
    }
    setExported(d);
    window.location.assign(d.url);  // served as an attachment: downloads in place, no pop-up to block
  };

  if (!ready) return <div className="sy-page"><p className="sy-muted">Loading…</p></div>;

  if (!allowed) {
    return (
      <div className="sy-denied">
        <h2>Data Cleanse Log</h2>
        {session.error
          ? <div className="sy-error">{session.error}</div>
          : <p>{email || 'This account'} has no role assigned. The Data Cleanse Log is available to super users, agency users and certification reviewers — ask a super user to assign one.</p>}
        <Link href="/" className="btn btn-secondary">← File Browser</Link>
      </div>
    );
  }

  const stat = (n: number | null) => (n === null ? '—' : n.toLocaleString());
  const visible = showAll ? rows : rows.slice(0, RENDER_LIMIT);
  const filtered = !!(sourceFilter || activeType || search.trim());

  const cellClass = (column: string, i: number) => {
    if (isCount(column)) return 'num';
    if (i === idx.code || i === idx.source || i === idx.bu) return 'mono';
    if (isMessage(column) || LONG_TEXT.includes(column.trim().toLowerCase())) return 'dcl-long';
    return undefined;
  };
  const renderCell = (v: Cell, column: string, i: number) => {
    if (v === null || v === '') return '';
    if (isCount(column) && typeof v === 'number') return v.toLocaleString();
    if (i === idx.severity) return <span className={`sy-sev sy-sev-${text(v).toLowerCase()}`}>{text(v)}</span>;
    return String(v);
  };

  return (
    <div className="sy-page">
      <header className="sy-header">
        <div>
          <h1>
            Data Cleanse Log <span className="sy-mock">{mock}</span>
            {log?.is_test && <span className="sy-mock sy-test">{log.db}{readMain ? ' · read-only' : ' · test'}</span>}
            <span className="sy-pill sy-pill-role">{ROLE_LABEL[session.role] || session.role}</span>
          </h1>
          <p className="sy-sub">Every validation raised on the mock cycle&apos;s files with its number of occurrences, by source and business unit, as the validation team reports it.</p>
        </div>
        <div className="sy-links">
          <Link href="/" className="btn btn-secondary">← File Browser</Link>
        </div>
      </header>

      <section className="sy-controls">
        <label className="dcl-narrow">
          <span>Mock Cycle</span>
          <select value={mock} onChange={e => { session.setMock(e.target.value); setPillarChoice(''); }}>
            {session.mocks.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="dcl-narrow">
          <span>Pillar</span>
          <select value={pillar} onChange={e => setPillarChoice(e.target.value as Pillar)}>
            <option value="HCM">HCM</option>
            <option value="FSCM">FSCM</option>
          </select>
        </label>
        <label className="dcl-narrow">
          <span>Layout</span>
          <select value={layout} onChange={e => setLayout(e.target.value as Layout)}>
            <option value="by_bu">By BU</option>
            <option value="summary">Summary</option>
          </select>
        </label>
        <label className="dcl-narrow">
          <span>Source</span>
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
            <option value="">All sources</option>
            {(log?.sources ?? []).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="dcl-narrow">
          <span>Validation Type</span>
          <select value={activeType} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>
          <span>Search</span>
          <input className="sy-input" type="search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Code, message or entity" />
        </label>
        {isTest && (
          <label className="sy-check dcl-main">
            <input type="checkbox" checked={readMain} onChange={e => setReadMain(e.target.checked)} />
            Read the main database (read-only)
          </label>
        )}
        <div className="sy-run-btns">
          <button className="btn btn-secondary" disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Refresh'}</button>
          <button className="btn btn-primary" disabled={!log || loading || exporting} onClick={exportExcel}
            title="Builds the workbook for this mock cycle, pillar and layout — every row you may see, whatever the filters — and saves it under DataValidation/DataCleanseLog">
            {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
        </div>
      </section>

      {session.error && <div className="sy-error">{session.error}</div>}
      {error && <div className="sy-error">{error}</div>}
      {exported && (
        <div className="sy-success">
          Saved <a href={exported.url} target="_blank" rel="noreferrer">{exported.name}</a> ({exported.rows.toLocaleString()} rows
          {exported.truncated ? ', truncated' : ''}) under <code>{exported.key.split('/').slice(0, -1).join('/')}</code>.
        </div>
      )}
      {log && log.warnings.length > 0 && (
        <div className="sy-note"><ul className="dcl-notes">{log.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}

      <section className="sy-stats">
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.codes)}</div><div className="sy-stat-label">Validations reported</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.occurrences)}</div><div className="sy-stat-label">Total occurrences</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.sources)}</div><div className="sy-stat-label">Sources</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.bus)}</div><div className="sy-stat-label">Business units</div></div>
      </section>

      <section className="sy-card">
        <div className="sy-card-head">
          <h2>{pillar} · {layout === 'by_bu' ? 'By BU' : 'Summary'}</h2>
          <div className="sy-card-tools">
            {log && (
              <span className="sy-total">
                {rows.length.toLocaleString()} {filtered ? `of ${log.rows.length.toLocaleString()} ` : ''}rows
                {log.truncated ? ` (the log has ${log.total.toLocaleString()})` : ''}
              </span>
            )}
          </div>
        </div>
        {log && (
          <p className="sy-muted small dcl-source">
            Source: {log.source === 'view' ? <>view <code>{log.view_name}</code></> : <>query over the rule catalog and the detail log</>} in {log.db}
          </p>
        )}
        {!log ? <p className="sy-muted">{loading ? 'Loading…' : 'Nothing to show.'}</p> : (
          <div className={`sy-scroll dcl-scroll${loading ? ' dcl-loading' : ''}`}>
            <table className="sy-table dcl-table">
              <thead>
                <tr>{columns.map((c, i) => <th key={i} className={isCount(c) ? 'num' : undefined}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {visible.map((r, n) => (
                  <tr key={n}>
                    {columns.map((c, i) => <td key={i} className={cellClass(c, i)}>{renderCell(r[i], c, i)}</td>)}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={Math.max(1, columns.length)} className="sy-muted">
                    {filtered ? 'No rows match the filters.' : `No validations are logged for ${log.mock} · ${log.pillar}${session.role === 'agency_user' ? ' on your sources' : ''}.`}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > visible.length && (
          <p className="sy-muted small">
            Showing the first {visible.length.toLocaleString()} rows.{' '}
            <button className="sy-link" onClick={() => setShowAll(true)}>Show all {rows.length.toLocaleString()}</button>
          </p>
        )}
      </section>
    </div>
  );
}

export default withAuthenticator(DataCleanseLogPage);
