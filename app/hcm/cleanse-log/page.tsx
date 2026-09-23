'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import { ApiResult, apiGet, apiPost } from '../../lib/symphony';
import HcmShell, { useHcm } from '../HcmShell';
import RecordsTable from '../RecordsTable';
import './cleanse-log.css';

Amplify.configure(config);

type Layout = 'by_bu' | 'summary';
type Cell = string | number | boolean | null;

interface Rule {
  message?: string | null; message_spa?: string | null; path_forward?: string | null;
  severity?: string | null; entity?: string | null; type?: string | null;
}
interface CleanseLog extends ApiResult {
  mock: string; layout: Layout;
  db: string; is_test: boolean;
  source: 'view' | 'query'; view_name: string | null;
  columns: string[]; rows: Cell[][];
  total: number; truncated: boolean;
  sources: string[]; warnings: string[];
  rules: Record<string, Rule>;     // by validation code; a very large log may come without some of them
}
interface CleanseLogExport extends ApiResult {
  key: string; name: string; rows: number; truncated: boolean; url: string;
}

// Rows drawn at once; the rest stay a click away so a large log does not freeze the tab.
const RENDER_LIMIT = 2000;
const LONG_TEXT = ['notes', 'severity_criteria', 'transformationlogicapplied'];
const LAYOUT_LABEL: Record<Layout, string> = { by_bu: 'By BU', summary: 'Summary' };
// A test copy with nothing run for the cycle is answered from the main database, named in `db`.
const MAIN_DATABASE = 'HACIENDA_ERP';

const text = (v: Cell | undefined) => (v === null || v === undefined ? '' : String(v).trim());
const isCount = (column: string) => column.toLowerCase().endsWith(' count');
// The team's views spell the message column "Error Messge".
const isMessage = (column: string) => column.toLowerCase().startsWith('error mess');

function CleanseLogView() {
  const { mock, email, session, parties } = useHcm();
  const { isAdmin } = session;

  const [layout, setLayout] = useState<Layout>('by_bu');
  const [log, setLog] = useState<CleanseLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [buFilter, setBuFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [openCode, setOpenCode] = useState('');
  const [openRowAt, setOpenRowAt] = useState(-1);   // the row whose code was clicked, among the log's rows
  const [records, setRecords] = useState<{ code: string; source: string; bu: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<CleanseLogExport | null>(null);
  const latest = useRef(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const panelTitle = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const id = ++latest.current;
    setLoading(true);
    setError('');
    setExported(null);
    const d = await apiGet<CleanseLog>('cleanse_log', { mock, pillar: 'HCM', layout, email });
    if (id !== latest.current) return;   // a newer selection is already loading
    setLoading(false);
    setShowAll(false);
    if (!d.ok) {
      setLog(null);
      setError(d.error || 'The Data Cleanse Log could not be loaded');
      return;
    }
    setLog({
      ...d,
      columns: Array.isArray(d.columns) ? d.columns : [],
      rows: Array.isArray(d.rows) ? d.rows : [],
      sources: Array.isArray(d.sources) ? d.sources : [],
      warnings: Array.isArray(d.warnings) ? d.warnings : [],
      rules: d.rules ?? {},
    });
  }, [mock, layout, email]);

  useEffect(() => { load(); }, [load]);

  const columns = useMemo(() => log?.columns ?? [], [log]);
  const idx = useMemo(() => {
    const find = (test: (c: string) => boolean) => columns.findIndex(c => test(c.trim().toLowerCase()));
    // "<MOCK> Count" is the cycle's own column (a view may also carry the previous cycle's)
    const mockCount = find(c => c === `${(log?.mock || mock).toLowerCase()} count`);
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
  }, [columns, log, mock]);

  const activeSource = log?.sources.includes(sourceFilter) ? sourceFilter : '';

  // The agencies of the chosen source; a BU starts with the agency number.
  const bus = useMemo(() => {
    if (!log || idx.bu < 0) return [];
    const inSource = log.rows.filter(r => !activeSource || text(r[idx.source]) === activeSource);
    return Array.from(new Set(inSource.map(r => text(r[idx.bu])).filter(Boolean))).sort();
  }, [log, idx, activeSource]);
  const activeBu = bus.includes(buFilter) ? buFilter : '';

  const agencyNames = useMemo(() => {
    const names = new Map<string, string>();
    parties.forEach(p => {
      const agency = (p.agency || '').trim();
      const number = (/^\d{3}/.exec(agency) || /^\d{3}/.exec((p.bu || '').trim()) || [''])[0];
      const name = agency.replace(/^\d{3,5}\s*[-–]?\s*/, '');
      if (number && name && !names.has(number)) names.set(number, name);
    });
    return names;
  }, [parties]);
  const buLabel = (bu: string) => {
    const name = agencyNames.get(bu.slice(0, 3));
    return name ? `${bu} · ${name}` : bu;
  };

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
      (!activeSource || text(r[idx.source]) === activeSource)
      && (!activeBu || text(r[idx.bu]) === activeBu)
      && (!activeType || text(r[idx.type]) === activeType)
      && (!needle || searched.some(i => text(r[i]).toLowerCase().includes(needle))));
  }, [log, idx, activeSource, activeBu, activeType, search]);

  const stats = useMemo(() => {
    const distinct = (i: number) => (i < 0 ? null : new Set(rows.map(r => text(r[i])).filter(Boolean)).size);
    const occurrences = idx.count < 0 ? null : rows.reduce((sum, r) => sum + (Number(r[idx.count]) || 0), 0);
    return { codes: distinct(idx.code), occurrences, sources: distinct(idx.source), bus: distinct(idx.bu) };
  }, [rows, idx]);

  // The validation whose rule is open: the clicked row, and every row of the same code.
  const openRow = useMemo(
    () => (log && openCode && idx.code >= 0
      ? (text(log.rows[openRowAt]?.[idx.code]) === openCode ? log.rows[openRowAt] : log.rows.find(r => text(r[idx.code]) === openCode))
      : undefined),
    [log, openCode, openRowAt, idx.code],
  );
  const occurrences = useMemo(() => {
    if (!log || !openCode || idx.code < 0) return [];
    return log.rows
      .filter(r => text(r[idx.code]) === openCode)
      .map(r => ({
        source: idx.source >= 0 ? text(r[idx.source]) : '',
        bu: idx.bu >= 0 ? text(r[idx.bu]) : '',
        count: idx.count >= 0 ? Number(r[idx.count]) || 0 : 0,
      }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.bu.localeCompare(b.bu));
  }, [log, openCode, idx]);

  useEffect(() => {
    if (openCode) panelTitle.current?.focus();
  }, [openCode]);

  const openRule = (code: string, button: HTMLButtonElement, rowAt: number) => {
    opener.current = button;
    setOpenCode(code);
    setOpenRowAt(rowAt);
  };
  const closeRule = () => {
    setOpenCode('');
    opener.current?.focus();
  };

  const exportExcel = async () => {
    setExporting(true);
    setError('');
    setExported(null);
    const d = await apiPost<CleanseLogExport>('cleanse_log_export', { mock, pillar: 'HCM', layout, email, actor: email });
    setExporting(false);
    if (!d.ok || !d.url) {
      setError(d.error || 'The export could not be created');
      return;
    }
    setExported(d);
    window.location.assign(d.url);  // served as an attachment: downloads in place, no pop-up to block
  };

  const stat = (n: number | null) => (n === null ? '—' : n.toLocaleString());
  const visible = showAll ? rows : rows.slice(0, RENDER_LIMIT);
  const filtered = !!(activeSource || activeBu || activeType || search.trim());

  const cellClass = (column: string, i: number) => {
    if (isCount(column)) return 'num';
    if (i === idx.code || i === idx.source || i === idx.bu) return 'mono';
    if (isMessage(column) || LONG_TEXT.includes(column.trim().toLowerCase())) return 'hcl-long';
    return undefined;
  };
  const renderCell = (v: Cell, column: string, i: number, rowAt: number) => {
    if (v === null || v === undefined || v === '') return '';
    if (i === idx.code) {
      const code = text(v);
      return (
        <button type="button" className="sy-link" aria-label={`${code}: show the rule and its path forward`}
          onClick={e => openRule(code, e.currentTarget, rowAt)}>
          {code}
        </button>
      );
    }
    if (isCount(column) && typeof v === 'number') return v.toLocaleString();
    if (i === idx.severity) return <span className={`sy-sev sy-sev-${text(v).toLowerCase()}`}>{text(v)}</span>;
    return String(v);
  };

  // One plain line for the validation team; administrators get the details instead.
  let friendly = '';
  if (log?.is_test && (log.db || '').toUpperCase() === MAIN_DATABASE) {
    friendly = `Nothing has been run for ${mock} in the test environment yet, so this log shows the results of the main environment.`;
  } else if (log?.source === 'query') {
    friendly = `The report for ${mock} has not been set up yet, so this log was put together directly from the validation results.`;
  }

  const rule = openRow ? log?.rules[openCode] : undefined;
  const fromRow = (i: number) => (openRow && i >= 0 ? text(openRow[i]) : '');
  const detail = openRow && {
    message: text(rule?.message) || fromRow(idx.message),
    spanish: text(rule?.message_spa),
    entity: text(rule?.entity) || fromRow(idx.entity),
    type: text(rule?.type) || fromRow(idx.type),
    severity: text(rule?.severity) || fromRow(idx.severity),
    forward: text(rule?.path_forward),
  };

  return (
    <>
      <section className="sy-controls hcl-controls" aria-label="Filters">
        <label>
          <span>Layout</span>
          <select value={layout} onChange={e => setLayout(e.target.value as Layout)}>
            <option value="by_bu">{LAYOUT_LABEL.by_bu}</option>
            <option value="summary">{LAYOUT_LABEL.summary}</option>
          </select>
        </label>
        <label>
          <span>Source</span>
          <select value={activeSource} onChange={e => setSourceFilter(e.target.value)}>
            <option value="">All sources</option>
            {(log?.sources ?? []).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="hcl-agency">
          <span>Agency / BU</span>
          <select value={activeBu} onChange={e => setBuFilter(e.target.value)} disabled={!!log && idx.bu < 0}>
            <option value="">{log && idx.bu < 0 ? 'Not kept in the summary' : 'All agencies'}</option>
            {bus.map(b => <option key={b} value={b}>{buLabel(b)}</option>)}
          </select>
        </label>
        <label>
          <span>Validation type</span>
          <select value={activeType} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="hcl-search">
          <span>Search</span>
          <input className="sy-input" type="search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Code, message or entity" />
        </label>
        <div className="sy-run-btns">
          <button type="button" className="btn btn-secondary" disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Refresh'}</button>
          <button type="button" className="btn btn-primary" disabled={!log || loading || exporting} onClick={exportExcel}>
            {exporting ? 'Preparing…' : 'Export to Excel'}
          </button>
        </div>
      </section>

      {error && <div className="sy-error" role="alert">{error}</div>}
      {exported && (
        <div className="sy-success" role="status">
          The download has started: <a href={exported.url}>{exported.name}</a> holds the whole log of {mock}
          {' '}({exported.rows.toLocaleString()} rows{exported.truncated ? ', the first part only' : ''}), whatever the filters on screen.
          {isAdmin && <> Saved under <code>{exported.key.split('/').slice(0, -1).join('/')}</code>.</>}
        </div>
      )}
      {log && (isAdmin
        ? log.warnings.length > 0 && <div className="sy-note"><ul className="hcl-notes">{log.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
        : friendly && <div className="hcm-banner">{friendly}</div>)}

      <section className="sy-stats" aria-label="Totals of the rows on screen">
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.codes)}</div><div className="sy-stat-label">Validations reported</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.occurrences)}</div><div className="sy-stat-label">Total occurrences</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.sources)}</div><div className="sy-stat-label">Sources</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{stat(stats.bus)}</div><div className="sy-stat-label">Agencies / BUs</div></div>
      </section>

      <div className={`hcl-split${detail ? ' hcl-open' : ''}`}>
        <section className="hcm-card hcl-log">
          <div className="hcm-card-head">
            <h2>{log ? LAYOUT_LABEL[log.layout] || 'Log' : 'Log'}</h2>
            {log && (
              <span className="sy-total">
                {rows.length.toLocaleString()} {filtered ? `of ${log.rows.length.toLocaleString()} ` : ''}rows
                {log.truncated ? ` (the log has ${log.total.toLocaleString()}; export it to get them all)` : ''}
              </span>
            )}
          </div>
          {log && <p className="sy-muted hcl-hint">Select a validation code to read its rule and path forward.</p>}
          {log && isAdmin && (
            <p className="sy-muted small hcl-hint">
              Source: {log.source === 'view' ? <>view <code>{log.view_name}</code></> : <>query over the rule catalog and the detail log</>} in {log.db}
              {log.is_test ? ' (validation runs against a test copy)' : ''}
            </p>
          )}
          {!log ? <p className="hcm-loading">{loading ? 'Loading…' : 'Nothing to show.'}</p> : (
            <div className={`hcl-scroll${loading ? ' hcl-loading' : ''}`} tabIndex={0} role="region" aria-label="Data Cleanse Log rows">
              <table className="sy-table hcl-table">
                <thead>
                  <tr>{columns.map((c, i) => <th key={i} scope="col" className={isCount(c) ? 'num' : undefined}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {visible.map((r, n) => (
                    <tr key={n} className={openCode && text(r[idx.code]) === openCode ? 'hcl-current' : undefined}>
                      {columns.map((c, i) => <td key={i} className={cellClass(c, i)}>{renderCell(r[i], c, i, log.rows.indexOf(r))}</td>)}
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={Math.max(1, columns.length)} className="sy-muted">
                      {filtered ? 'No rows match the filters.' : `No validations have been reported for ${mock}.`}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > visible.length && (
            <p className="sy-muted small">
              Showing the first {visible.length.toLocaleString()} rows.{' '}
              <button type="button" className="sy-link" onClick={() => setShowAll(true)}>Show all {rows.length.toLocaleString()}</button>
            </p>
          )}
        </section>

        {detail && (
          <aside className="hcm-card hcl-panel" aria-labelledby="hcl-panel-title"
            onKeyDown={e => { if (e.key === 'Escape') closeRule(); }}>
            <div className="hcm-card-head">
              <h2 id="hcl-panel-title" ref={panelTitle} tabIndex={-1}>Validation <span className="hcl-panel-code">{openCode}</span></h2>
              <button type="button" className="btn btn-secondary" onClick={closeRule}>Close</button>
            </div>
            <dl className="hcl-facts">
              <div className="hcl-fact-wide"><dt>Message</dt><dd>{detail.message || '—'}</dd></div>
              <div className="hcl-fact-wide"><dt>Message in Spanish</dt><dd lang="es">{detail.spanish || '—'}</dd></div>
              <div><dt>Entity</dt><dd>{detail.entity || '—'}</dd></div>
              <div><dt>Type</dt><dd>{detail.type || '—'}</dd></div>
              <div>
                <dt>Severity</dt>
                <dd>{detail.severity ? <span className={`sy-sev sy-sev-${detail.severity.toLowerCase()}`}>{detail.severity}</span> : '—'}</dd>
              </div>
            </dl>
            <h3 className="hcl-forward-title">Path Forward</h3>
            {detail.forward
              ? <p className="hcl-forward">{detail.forward}</p>
              : <p className="hcl-forward hcl-forward-empty">
                  {rule ? 'No path forward has been recorded for this validation yet.' : 'The rule of this validation could not be loaded with the log.'}
                </p>}
            {openRow && (
              <p className="hcl-records-link">
                <button type="button" className="btn btn-secondary"
                  onClick={() => setRecords({ code: openCode, source: fromRow(idx.source), bu: fromRow(idx.bu) })}>
                  View the records of this row
                </button>
              </p>
            )}
            {occurrences.length > 0 && (
              <>
                <h3 className="hcl-forward-title">Where it was found</h3>
                <p className="sy-muted small hcl-where-note">
                  The same rule is listed once for every source and agency it was found in. The row you opened is marked.
                </p>
                <ul className="hcl-where" aria-label="Where this validation was found">
                  {occurrences.map((o, n) => {
                    const current = openRow && text(openRow[idx.source]) === o.source && text(openRow[idx.bu]) === o.bu;
                    return (
                      <li key={n} className={current ? 'hcl-where-current' : undefined}>
                        <span className="mono">{[o.source, o.bu ? buLabel(o.bu) : ''].filter(Boolean).join(' · ') || '—'}</span>
                        <span className="num">{o.count.toLocaleString()}</span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>

      {records && (
        <section className="hcm-card hcl-records" aria-labelledby="hcl-records-title">
          <div className="hcm-card-head">
            <h2 id="hcl-records-title">
              Records of <span className="hcl-panel-code">{records.code}</span>
              {records.source ? ` — ${records.source}` : ''}{records.bu ? ` · ${buLabel(records.bu)}` : ''}
            </h2>
            <button type="button" className="btn btn-secondary" onClick={() => setRecords(null)}>Close</button>
          </div>
          <RecordsTable key={`${records.code}|${records.source}|${records.bu}`}
            validationCode={records.code} source={records.source} bu={records.bu} />
        </section>
      )}
    </>
  );
}

function HcmCleanseLogPage() {
  return (
    <HcmShell title="Data Cleanse Log" staffOnly wide
      subtitle="Every validation reported in the selected Mock Cycle and how many times it occurred, by source and agency.">
      <CleanseLogView />
    </HcmShell>
  );
}

export default withAuthenticator(HcmCleanseLogPage);
