'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import { getUrl, uploadData } from 'aws-amplify/storage';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import './validations.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import {
  ENTITY_NAMES,
  ENTITY_CLASSIFICATION,
  TIERS,
  tierForEntity,
  computeSampleSize,
  parseFilename,
  selectSample,
  readWorkbook,
  buildWorkbook,
  workbookToArray,
  downloadWorkbook,
  FileData,
} from './sampling';
import { parseAgencyReport, AgencyReport, buildGroups } from './dashboard';

Amplify.configure(config);

const SAMPLING_FOLDER = 'Sampling/';
const LOCAL_FOLDER = 'Sampling/Local/';
const CLIENT_FOLDER = 'Sampling/Client/';
const REPORT_PATH = 'Sampling/_status/agency_report.xlsx';
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type TabId = 'sampling' | 'dashboard';
type GenStatus = 'idle' | 'working' | 'done' | 'error';

interface FileEntry {
  id: string;
  fileName: string;
  entity: string;
  agency: string;
  N: number;
  loading: boolean;
  error: string;
  data: FileData | null;
  genStatus: GenStatus;
  genError: string;
  generated: { seed: number; n: number; at: string } | null;
}

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function stamp(d: Date) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── Overall-completion donut (SVG, no chart library) ─────────────────────────
function Donut({ completed, partial, pending }: { completed: number; partial: number; pending: number }) {
  const total = completed + partial + pending || 1;
  const r = 70;
  const C = 2 * Math.PI * r;
  const segs = [
    { v: completed, c: '#059669' },
    { v: partial, c: '#f59e0b' },
    { v: pending, c: '#ef4444' },
  ];
  let off = 0;
  const pct = Math.round((100 * completed) / total);
  return (
    <svg viewBox="0 0 200 200" className="val-donut" role="img" aria-label={`${pct}% complete`}>
      <circle cx="100" cy="100" r={r} fill="none" stroke="#eceff3" strokeWidth="24" />
      {segs.map((s, i) => {
        const len = (C * s.v) / total;
        const el = (
          <circle
            key={i}
            cx="100" cy="100" r={r} fill="none" stroke={s.c} strokeWidth="24"
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off}
            transform="rotate(-90 100 100)"
          />
        );
        off += len;
        return el;
      })}
      <text x="100" y="96" textAnchor="middle" className="val-donut-pct">{pct}%</text>
      <text x="100" y="118" textAnchor="middle" className="val-donut-sub">complete</text>
    </svg>
  );
}

function ValidationsPage() {
  const [userEmail, setUserEmail] = useState('');
  const [activeTab, setActiveTab] = useState<TabId>('sampling');

  // ── Sampling state ──
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Dashboard state ──
  const [report, setReport] = useState<AgencyReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const [reportLoaded, setReportLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const reportInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const attrs = await fetchUserAttributes();
        setUserEmail(attrs.email || '');
      } catch (e) {
        console.error('Failed to fetch user attrs', e);
      }
    })();
  }, []);

  const patch = useCallback((id: string, p: Partial<FileEntry>) => {
    setEntries(prev => prev.map(e => (e.id === id ? { ...e, ...p } : e)));
  }, []);

  // ── Sampling: add + read files ──
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => /\.(xlsx|xlsm|xls)$/i.test(f.name));
    for (const file of list) {
      const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const parsed = parseFilename(file.name);
      setEntries(prev => [...prev, {
        id, fileName: file.name,
        entity: parsed.entity || '', agency: parsed.agency,
        N: 0, loading: true, error: '', data: null,
        genStatus: 'idle', genError: '', generated: null,
      }]);
      try {
        const data = await readWorkbook(file);
        patch(id, { data, N: data.rows.length, loading: false });
      } catch (err) {
        patch(id, { loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [patch]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  // ── Sampling: generate → upload to Local (full) + Client (no Sizing) + local download ──
  const generate = async (entry: FileEntry) => {
    if (!entry.data || !entry.entity) return;
    const tier = tierForEntity(entry.entity);
    if (!tier) return;
    const n = computeSampleSize(entry.N, tier);
    const seed = Math.floor(Math.random() * 2 ** 32) >>> 0;
    const selectedIndices = selectSample(entry.N, n, seed);
    const now = new Date();
    const agency = entry.agency || 'NA';
    const base = `${entry.entity.replace(/\s+/g, '_')}_${agency}_Sample_${stamp(now)}`;
    const meta = {
      entity: entry.entity, agency, tier, N: entry.N, n, seed,
      generatedAt: now.toISOString(), generatedBy: userEmail, selectedIndices,
    };

    patch(entry.id, { genStatus: 'working', genError: '' });
    try {
      const full = buildWorkbook(entry.data, meta, true);
      const client = buildWorkbook(entry.data, meta, false);
      await uploadData({
        path: `${LOCAL_FOLDER}${base}.xlsx`,
        data: new Blob([workbookToArray(full)], { type: XLSX_CT }),
        options: { contentType: XLSX_CT },
      }).result;
      await uploadData({
        path: `${CLIENT_FOLDER}${base}.xlsx`,
        data: new Blob([workbookToArray(client)], { type: XLSX_CT }),
        options: { contentType: XLSX_CT },
      }).result;
      downloadWorkbook(full, `${base}.xlsx`);
      patch(entry.id, { genStatus: 'done', generated: { seed, n, at: now.toLocaleString() } });
    } catch (err) {
      patch(entry.id, { genStatus: 'error', genError: err instanceof Error ? err.message : String(err) });
    }
  };

  const nFor = (entry: FileEntry): number | null => {
    const tier = entry.entity ? tierForEntity(entry.entity) : null;
    if (!tier || !entry.N) return null;
    return computeSampleSize(entry.N, tier);
  };

  // ── Dashboard: load report from S3 (auto), or upload to persist ──
  const loadReport = useCallback(async () => {
    setReportLoading(true);
    setReportError('');
    try {
      const { url } = await getUrl({ path: REPORT_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error('fetch failed');
      setReport(parseAgencyReport(await resp.arrayBuffer()));
    } catch {
      setReport(null); // not uploaded yet — prompt to upload
    } finally {
      setReportLoading(false);
      setReportLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'dashboard' && !reportLoaded) loadReport();
  }, [activeTab, reportLoaded, loadReport]);

  const uploadReport = async (file: File) => {
    setReportLoading(true);
    setReportError('');
    try {
      const buf = await file.arrayBuffer();
      await uploadData({ path: REPORT_PATH, data: new Blob([buf], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;
      setReport(parseAgencyReport(buf));
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setReportLoading(false);
    }
  };

  const statusClass = (s: string) => {
    const l = s.toLowerCase();
    if (l === 'completed') return 'val-st-completed';
    if (l === 'partial') return 'val-st-partial';
    if (l === 'pending') return 'val-st-pending';
    return 'val-st-other';
  };

  const groups = report ? buildGroups(report.bus) : [];
  const filteredGroups = groups
    .filter(g => {
      const q = filter.trim().toLowerCase();
      if (!q) return true;
      return g.code.toLowerCase().includes(q) || g.name.toLowerCase().includes(q) ||
        g.members.some(m => m.unit.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    })
    .sort((a, b) => a.pct - b.pct || a.code.localeCompare(b.code));

  return (
    <div className="val-page">
      <header className="val-header">
        <div className="val-header-left">
          <Link href="/" className="val-back-link">&larr; File Browser</Link>
          <div className="val-header-title">
            <h1>Validations</h1>
            <p className="val-header-subtitle">
              Sampling and validation tooling for the ERP conversion effort
            </p>
          </div>
        </div>
        <div className="val-header-right">
          <Link href={`/?path=${encodeURIComponent(SAMPLING_FOLDER)}`} className="val-folder-link">
            📁 Open Sampling Folder
          </Link>
        </div>
      </header>

      <div className="val-tabs">
        <button className={`val-tab-btn ${activeTab === 'sampling' ? 'active' : ''}`} onClick={() => setActiveTab('sampling')}>
          Sampling
        </button>
        <button className={`val-tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
          BU Dashboard
        </button>
      </div>

      {activeTab === 'sampling' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>Record Sampling</h2>
            <p>
              Drop one or more consolidated master files (one per agency). Each file&rsquo;s
              population is sized with the Data Validation Framework V2 formula, a simple random
              sample is drawn, and the workbook is written to two folders in the Sampling area:
              the full copy (Sample, Population, Sizing) to <strong>Local</strong>, and a
              client copy without the Sizing sheet to <strong>Client</strong>. A full copy also
              downloads to your machine. Files are read and sampled in your browser.
            </p>
            <div className="val-note">
              n = N·Z²·p·(1−p) / [ e²·(N−1) + Z²·p·(1−p) ], rounded up. Tiers: HIGH 99% ·
              MODERATE 95% · LOW 90% · AUTO 85%. Selection uses a recorded random seed so any
              sample can be reproduced.
            </div>
          </div>

          <div
            className={`val-dropzone ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xlsm,.xls"
              multiple
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
            />
            <span className="val-dropzone-icon">📥</span>
            <p><strong>Drop consolidated master files here</strong> or click to browse</p>
            <p className="val-dropzone-hint">.xlsx — one file per agency (e.g. Consolidated_Suppliers_015.xlsx)</p>
          </div>

          {entries.length > 0 && (
            <table className="val-table val-files">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Entity</th>
                  <th className="val-col-agency">Agency</th>
                  <th className="val-col-num">Population (N)</th>
                  <th className="val-col-class">Class</th>
                  <th className="val-col-num">Sample (n)</th>
                  <th className="val-col-gen">Action</th>
                  <th className="val-col-caret"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => {
                  const cls = entry.entity ? ENTITY_CLASSIFICATION[entry.entity] : null;
                  const n = nFor(entry);
                  return (
                    <tr key={entry.id}>
                      <td className="val-file-name" title={entry.fileName}>
                        {entry.fileName}
                        {entry.loading && <span className="val-spinner val-spinner-dark" />}
                        {entry.error && <div className="val-file-err">{entry.error}</div>}
                      </td>
                      <td>
                        <select
                          value={entry.entity}
                          onChange={e => patch(entry.id, { entity: e.target.value, generated: null, genStatus: 'idle' })}
                          className={entry.entity ? '' : 'val-select-empty'}
                        >
                          <option value="">— select entity —</option>
                          {ENTITY_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
                        </select>
                      </td>
                      <td className="val-col-agency">
                        <input type="text" value={entry.agency} onChange={e => patch(entry.id, { agency: e.target.value })} placeholder="—" />
                      </td>
                      <td className="val-col-num">{entry.N ? entry.N.toLocaleString() : (entry.loading ? '…' : '0')}</td>
                      <td className="val-col-class">
                        {cls ? <span className={`val-class val-class-${cls.toLowerCase()}`}>{cls}</span> : <span className="val-muted">—</span>}
                      </td>
                      <td className="val-col-num val-n">{n ?? '—'}</td>
                      <td className="val-col-gen">
                        <button
                          className="val-btn-row"
                          disabled={!entry.data || !entry.entity || !entry.N || entry.genStatus === 'working'}
                          onClick={() => generate(entry)}
                        >
                          {entry.genStatus === 'working' ? <><span className="val-spinner" /> Generating…</>
                            : entry.generated ? '↻ Re-generate' : '⬇ Generate'}
                        </button>
                        {entry.genStatus === 'done' && entry.generated && (
                          <div className="val-gen-note" title={`seed ${entry.generated.seed}`}>
                            ✓ {entry.generated.n} rows → Local + Client · seed {entry.generated.seed}
                          </div>
                        )}
                        {entry.genStatus === 'error' && <div className="val-file-err">{entry.genError}</div>}
                      </td>
                      <td className="val-col-caret">
                        <button className="val-remove" onClick={() => setEntries(prev => prev.filter(e => e.id !== entry.id))} aria-label="Remove">×</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="val-framework">
            <h3>Framework V2 — classification parameters</h3>
            <table className="val-table val-tiers">
              <thead>
                <tr><th>Class</th><th>Confidence</th><th>Z</th><th>Margin (e)</th><th>Expected error (p)</th><th>Entities</th></tr>
              </thead>
              <tbody>
                {Object.values(TIERS).map(t => (
                  <tr key={t.name}>
                    <td><span className={`val-class val-class-${t.name.toLowerCase()}`}>{t.name}</span></td>
                    <td>{Math.round(t.confidence * 100)}%</td>
                    <td>{t.Z}</td>
                    <td>{(t.e * 100).toFixed(0)}%</td>
                    <td>{(t.p * 100).toFixed(2)}%</td>
                    <td className="val-muted">
                      {ENTITY_NAMES.filter(e => ENTITY_CLASSIFICATION[e] === t.name).map(e => e.toLowerCase()).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'dashboard' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>BU Completion Dashboard</h2>
            <p>Certification completion per Business Unit, drawn from the agencies-by-entity status report. Expand a BU to see which entities are still outstanding.</p>
          </div>

          {reportLoading && <div className="val-loading"><span className="val-spinner val-spinner-dark" /> Loading report…</div>}

          {!reportLoading && !report && (
            <div className="val-dropzone" onClick={() => reportInputRef.current?.click()}>
              <input
                ref={reportInputRef}
                type="file"
                accept=".xlsx,.xlsm,.xls"
                style={{ display: 'none' }}
                onChange={e => { if (e.target.files?.[0]) uploadReport(e.target.files[0]); e.target.value = ''; }}
              />
              <span className="val-dropzone-icon">📊</span>
              <p><strong>Upload the agency status report</strong> to load the dashboard</p>
              <p className="val-dropzone-hint">The FIN-SCM sheet — it will be saved and auto-load next time</p>
              {reportError && <p className="val-file-err">{reportError}</p>}
            </div>
          )}

          {!reportLoading && report && (
            <>
              <div className="val-dash-top">
                <div className="val-dash-chart">
                  <Donut completed={report.totals.completed} partial={report.totals.partial} pending={report.totals.pending} />
                </div>
                <div className="val-dash-stats">
                  <div className="val-legend">
                    <span className="val-legend-item"><i className="val-dot val-dot-completed" /> Completed <b>{report.totals.completed}</b></span>
                    <span className="val-legend-item"><i className="val-dot val-dot-partial" /> Partial <b>{report.totals.partial}</b></span>
                    <span className="val-legend-item"><i className="val-dot val-dot-pending" /> Pending <b>{report.totals.pending}</b></span>
                  </div>
                  <div className="val-cards">
                    <div className="val-card"><span className="val-card-num">{groups.length}</span><span className="val-card-label">Business Units</span></div>
                    <div className="val-card"><span className="val-card-num">{report.totals.attached}</span><span className="val-card-label">Entities attached</span></div>
                    <div className="val-card"><span className="val-card-num">{Math.round(report.totals.pct * 100)}%</span><span className="val-card-label">Overall complete</span></div>
                  </div>
                  <button className="val-btn-secondary" onClick={() => reportInputRef.current?.click()}>Update report</button>
                  <input ref={reportInputRef} type="file" accept=".xlsx,.xlsm,.xls" style={{ display: 'none' }}
                    onChange={e => { if (e.target.files?.[0]) uploadReport(e.target.files[0]); e.target.value = ''; }} />
                </div>
              </div>

              <div className="val-dash-controls">
                <input className="val-search" placeholder="Filter by BU number or name…" value={filter} onChange={e => setFilter(e.target.value)} />
                <span className="val-muted">{filteredGroups.length} of {groups.length} · sorted by least complete</span>
              </div>

              <table className="val-table val-bu">
                <thead>
                  <tr>
                    <th className="val-col-caret"></th>
                    <th>BU</th>
                    <th>Agency</th>
                    <th className="val-col-progress">Completion</th>
                    <th className="val-col-num">Done</th>
                    <th className="val-col-num">Partial</th>
                    <th className="val-col-num">Pending</th>
                    <th className="val-col-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.map(g => {
                    const open = !!expanded[g.code];
                    const pct = Math.round(g.pct * 100);
                    return (
                      <React.Fragment key={g.code}>
                        <tr className="val-bu-row" onClick={() => setExpanded(p => ({ ...p, [g.code]: !p[g.code] }))}>
                          <td className="val-col-caret"><span className="val-caret">{open ? '▾' : '▸'}</span></td>
                          <td className="val-bu-unit">
                            {g.code}
                            {g.multi && <span className="val-multi-badge" title={`${g.members.length} codes grouped`}>+{g.members.length - 1}</span>}
                          </td>
                          <td className="val-bu-name" title={g.name}>{g.name}</td>
                          <td className="val-col-progress">
                            <div className="val-progress"><div className={`val-progress-bar ${pct === 100 ? 'full' : ''}`} style={{ width: `${pct}%` }} /></div>
                            <span className="val-progress-pct">{pct}%</span>
                          </td>
                          <td className="val-col-num">{g.completed}</td>
                          <td className="val-col-num">{g.partial || ''}</td>
                          <td className="val-col-num">{g.pending ? <span className="val-pending-count">{g.pending}</span> : ''}</td>
                          <td className="val-col-num">{g.total}</td>
                        </tr>
                        {open && (
                          <tr className="val-bu-detail-row">
                            <td></td>
                            <td colSpan={7}>
                              {g.members.map(m => (
                                <div key={m.unit} className="val-member">
                                  {g.multi && (
                                    <div className="val-member-head">
                                      <span className="val-member-code">{m.unit}</span> {m.name}
                                      <span className="val-member-pct">{Math.round(m.pct * 100)}% · {m.completed}/{m.total}</span>
                                    </div>
                                  )}
                                  <div className="val-entity-grid">
                                    {report.entities.filter(e => m.statuses[e]).map(e => (
                                      <span key={e} className={`val-entity-badge ${statusClass(m.statuses[e])}`}>
                                        {e}<span className="val-entity-status">{m.statuses[e]}</span>
                                      </span>
                                    ))}
                                  </div>
                                  {m.completed < m.total && (
                                    <div className="val-missing">
                                      Outstanding: {report.entities.filter(e => m.statuses[e] && m.statuses[e].toLowerCase() !== 'completed').join(', ')}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default withAuthenticator(ValidationsPage);
