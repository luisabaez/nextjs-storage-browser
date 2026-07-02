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
  matchEntity,
  FileData,
} from './sampling';
import { parseAgencyReport, AgencyReport, buildGroups } from './dashboard';
import { RawFile, MergeResult, groupRawFiles, mergeGroup, resultToFileData, downloadMaster, appendValidationSheets } from './merge';
import { PlanRow, EntityGroup, groupEntityPlan, READINESS_LABEL } from './entityFiles';

Amplify.configure(config);

const SAMPLING_FOLDER = 'Sampling/';
const LOCAL_FOLDER = 'Sampling/Local/';
const CLIENT_FOLDER = 'Sampling/Client/';
const REPORT_PATH = 'Sampling/_status/agency_report.xlsx';
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

type TabId = 'sampling' | 'dashboard' | 'entities';
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
  merged: MergeResult | null;
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

  // ── Entity Files state ──
  const [planRows, setPlanRows] = useState<PlanRow[]>([]);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [planLoaded, setPlanLoaded] = useState(false);
  const [countsLoading, setCountsLoading] = useState(false);
  const [planExpanded, setPlanExpanded] = useState<Record<string, boolean>>({});
  const [planFilter, setPlanFilter] = useState('');
  const PLAN_MOCK = 'MOCK14';

  const loadPlan = useCallback(async () => {
    setPlanLoading(true);
    setPlanError('');
    try {
      // Fast: plan rows without row counts.
      const resp = await fetch(`${LAMBDA_URL}?action=entity_plan&mock=${PLAN_MOCK}`);
      const data = await resp.json();
      if (!data.ok) { setPlanError(data.error || 'Failed to load the conversion plan'); return; }
      setPlanRows(data.rows || []);
      setPlanLoaded(true);
      // Background: conversion-table row counts (slow ~20s), merged in when ready.
      setCountsLoading(true);
      fetch(`${LAMBDA_URL}?action=entity_plan&mock=${PLAN_MOCK}&counts=1`)
        .then(r => r.json())
        .then(d => { if (d.ok) setPlanRows(d.rows || []); })
        .catch(() => {})
        .finally(() => setCountsLoading(false));
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'entities' && !planLoaded) loadPlan();
  }, [activeTab, planLoaded, loadPlan]);

  const entityGroups: EntityGroup[] = planRows.length ? groupEntityPlan(planRows) : [];
  const filteredEntities = entityGroups.filter(g => {
    const q = planFilter.trim().toLowerCase();
    return !q || g.entity.toLowerCase().includes(q) || g.module.toLowerCase().includes(q) || g.pillar.toLowerCase().includes(q);
  });
  const planTotals = {
    entities: entityGroups.length,
    expected: planRows.length,
    imported: planRows.filter(r => String(r.FileImportStatus).toUpperCase() === 'Y').length,
    populated: planRows.filter(r => typeof r.tableRows === 'number' && r.tableRows > 0).length,
  };

  // Entity-file generation (server-side run of the conversion scripts).
  interface GenState { state: 'idle' | 'working' | 'done' | 'error'; dry?: boolean; planned?: PlanRow[] | { file: string; rows: number }[]; generated?: { file: string; rows: number }[]; folder?: string; error?: string; }
  const [entGen, setEntGen] = useState<Record<string, GenState>>({});
  const doGen = async (entity: string, dry: boolean) => {
    setEntGen(p => ({ ...p, [entity]: { state: 'working', dry } }));
    try {
      const url = `${LAMBDA_URL}?action=generate_entity_files&mock=${PLAN_MOCK}&entity=${encodeURIComponent(entity)}${dry ? '&dry_run=1' : ''}`;
      const d = await (await fetch(url)).json();
      if (!d.ok) { setEntGen(p => ({ ...p, [entity]: { state: 'error', error: d.error || 'Failed' } })); return; }
      setEntGen(p => ({ ...p, [entity]: { state: 'done', dry, planned: d.planned, generated: d.generated, folder: d.folder } }));
    } catch (e) {
      setEntGen(p => ({ ...p, [entity]: { state: 'error', error: e instanceof Error ? e.message : String(e) } }));
    }
  };

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
        genStatus: 'idle', genError: '', generated: null, merged: null,
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

  // ── Merge raw parent + child files → master, added straight to the sampling list ──
  const [isRawDragOver, setIsRawDragOver] = useState(false);
  const rawInputRef = useRef<HTMLInputElement>(null);

  const addRawFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => /\.(xlsx|xlsm|xls)$/i.test(f.name));
    if (!list.length) return;
    const raws: RawFile[] = [];
    for (const file of list) {
      try { raws.push({ name: file.name, data: await readWorkbook(file) }); }
      catch (e) { console.error('read failed', file.name, e); }
    }
    for (const g of groupRawFiles(raws)) {
      try {
        const result = mergeGroup(g);
        const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setEntries(prev => [...prev, {
          id,
          fileName: `Consolidated_${result.entityToken}_${result.bu || 'NA'}`,
          entity: matchEntity(result.entityToken) || '',
          agency: result.bu,
          N: result.recordCount,
          loading: false, error: '', data: resultToFileData(result),
          genStatus: 'idle', genError: '', generated: null, merged: result,
        }]);
      } catch (e) {
        console.error('merge failed', e);
      }
    }
  }, []);

  const onRawDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsRawDragOver(false);
    if (e.dataTransfer.files?.length) addRawFiles(e.dataTransfer.files);
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
      // If this came from a raw-file merge, add the Data Integrity sheet and the
      // sampled parents' child detail to both copies.
      if (entry.merged) {
        const keyIdx = entry.data.headers.findIndex(
          h => String(h ?? '').trim().toLowerCase() === entry.merged!.key.toLowerCase()
        );
        const selectedKeys = keyIdx >= 0
          ? new Set(selectedIndices.map(i => String(entry.data!.rows[i]?.[keyIdx] ?? '').trim()))
          : undefined;
        appendValidationSheets(full, entry.merged, selectedKeys);
        appendValidationSheets(client, entry.merged, selectedKeys);
      }
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
        <button className={`val-tab-btn ${activeTab === 'entities' ? 'active' : ''}`} onClick={() => setActiveTab('entities')}>
          Entity Files
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

          <div
            className={`val-dropzone val-dropzone-alt ${isRawDragOver ? 'drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsRawDragOver(true); }}
            onDragLeave={() => setIsRawDragOver(false)}
            onDrop={onRawDrop}
            onClick={() => rawInputRef.current?.click()}
          >
            <input
              ref={rawInputRef}
              type="file"
              accept=".xlsx,.xlsm,.xls"
              multiple
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files) addRawFiles(e.target.files); e.target.value = ''; }}
            />
            <span className="val-dropzone-icon">🧩</span>
            <p><strong>Or drop the raw parent + child files</strong> — they&rsquo;ll be merged into a master on the common identifier</p>
            <p className="val-dropzone-hint">e.g. the CV_SCM_SUPPLIER_… set for one agency; grouped by agency automatically</p>
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
                        {entry.merged && (() => {
                          const orphans = entry.merged.integrity.reduce((s, i) => s + i.orphans, 0);
                          return (
                            <div className="val-merged-note">
                              merged {entry.merged.children.length + 1} files ·{' '}
                              {entry.merged.children.map(c => `${c.label}${c.strategy === 'aggregate' ? '∑' : ''}`).join(', ') || 'parent only'}
                              <span
                                className={`val-integrity ${orphans === 0 ? 'clean' : 'issues'}`}
                                title={entry.merged.integrity.map(i => `${i.child}: ${i.orphans} orphan(s), ${i.gaps} gap(s)`).join('\n')}
                              >
                                {orphans === 0 ? '✓ integrity clean' : `⚠ ${orphans} orphans`}
                              </span>
                              {entry.merged.warnings.length > 0 && (
                                <span className="val-integrity issues" title={entry.merged.warnings.join('\n')}>
                                  ⚠ {entry.merged.warnings.length} warning{entry.merged.warnings.length !== 1 ? 's' : ''}
                                </span>
                              )}
                              <button
                                className="val-link-btn"
                                onClick={() => downloadMaster(entry.merged!, `${entry.fileName}.xlsx`)}
                              >⬇ master</button>
                            </div>
                          );
                        })()}
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

      {activeTab === 'entities' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>Entity Files ({PLAN_MOCK})</h2>
            <p>
              The entity files expected for sampling, from the conversion plan. For each
              entity it shows how many files are expected, how many are imported, and how many
              of their conversion tables are populated with rows. Readiness reflects the PM&rsquo;s
              latest email. Expand an entity to see each file.
            </p>
          </div>

          {planError && <div className="val-error">{planError}</div>}
          {planLoading && <div className="val-loading"><span className="val-spinner val-spinner-dark" /> Loading conversion plan…</div>}

          {!planLoading && planLoaded && (
            <>
              <div className="val-cards" style={{ margin: '4px 0 14px' }}>
                <div className="val-card"><span className="val-card-num">{planTotals.entities}</span><span className="val-card-label">Entities</span></div>
                <div className="val-card"><span className="val-card-num">{planTotals.expected.toLocaleString()}</span><span className="val-card-label">Expected files</span></div>
                <div className="val-card"><span className="val-card-num">{planTotals.imported.toLocaleString()}</span><span className="val-card-label">Imported</span></div>
                <div className="val-card">
                  <span className="val-card-num">{countsLoading ? '…' : planTotals.populated.toLocaleString()}</span>
                  <span className="val-card-label">Tables populated</span>
                </div>
              </div>

              <div className="val-dash-controls">
                <input className="val-search" placeholder="Filter by entity, module or pillar…" value={planFilter} onChange={e => setPlanFilter(e.target.value)} />
                <span className="val-muted">
                  {filteredEntities.length} of {entityGroups.length} entities
                  {countsLoading && <> · <span className="val-spinner val-spinner-dark" /> loading table counts…</>}
                </span>
              </div>

              <table className="val-table val-bu">
                <thead>
                  <tr>
                    <th className="val-col-caret"></th>
                    <th>Entity</th>
                    <th>Pillar / Module</th>
                    <th>Readiness</th>
                    <th className="val-col-num">Expected</th>
                    <th className="val-col-num">Imported</th>
                    <th className="val-col-num">Populated</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntities.map(g => {
                    const gkey = `${g.pillar}|${g.module}|${g.entity}`;
                    const open = !!planExpanded[gkey];
                    return (
                      <React.Fragment key={gkey}>
                        <tr className="val-bu-row" onClick={() => setPlanExpanded(p => ({ ...p, [gkey]: !p[gkey] }))}>
                          <td className="val-col-caret"><span className="val-caret">{open ? '▾' : '▸'}</span></td>
                          <td className="val-bu-unit">{g.entity}</td>
                          <td className="val-muted">{g.pillar} / {g.module}</td>
                          <td><span className={`val-ready val-ready-${g.readiness}`}>{READINESS_LABEL[g.readiness]}</span></td>
                          <td className="val-col-num">{g.expected}</td>
                          <td className="val-col-num">{g.imported || ''}</td>
                          <td className="val-col-num">
                            {g.countsLoaded
                              ? <span title={`${g.empty} empty, ${g.missingTable} table not built`}>{g.populated}/{g.expected}</span>
                              : <span className="val-muted">…</span>}
                          </td>
                        </tr>
                        {open && (
                          <tr className="val-bu-detail-row">
                            <td></td>
                            <td colSpan={6}>
                              {(() => {
                                const gs = entGen[g.entity] || { state: 'idle' as const };
                                return (
                                  <div className="val-gen-panel">
                                    <span className="val-gen-label">Generate entity files →</span>
                                    <button className="val-btn-row" disabled={gs.state === 'working'} onClick={() => doGen(g.entity, true)}>Preview</button>
                                    <button className="val-btn-row" disabled={gs.state === 'working'} onClick={() => { if (confirm(`Generate the ${g.entity} files into ${SAMPLING_FOLDER}Generated/? This reads the conversion tables and writes CV_ files to S3.`)) doGen(g.entity, false); }}>Generate</button>
                                    {gs.state === 'working' && <span className="val-gen-status"><span className="val-spinner val-spinner-dark" /> {gs.dry ? 'previewing…' : 'generating… (may take a while)'}</span>}
                                    {gs.state === 'error' && <span className="val-gen-status val-file-err">{gs.error}</span>}
                                    {gs.state === 'done' && gs.dry && gs.planned && (
                                      <span className="val-gen-status">Would generate <b>{gs.planned.length}</b> file(s) · {gs.planned.reduce((s, x) => s + (x as { rows: number }).rows, 0).toLocaleString()} rows</span>
                                    )}
                                    {gs.state === 'done' && !gs.dry && gs.generated && (
                                      <span className="val-gen-status">✓ Generated <b>{gs.generated.length}</b> file(s) to <code>{gs.folder}</code></span>
                                    )}
                                  </div>
                                );
                              })()}
                              <table className="val-child-table">
                                <thead><tr><th>Source</th><th>BU</th><th>Conversion table</th><th>Rows</th><th>Imported</th></tr></thead>
                                <tbody>
                                  {g.files.map((f, i) => (
                                    <tr key={i}>
                                      <td>{f.SOURCE || '—'}</td>
                                      <td>{f.BU || '—'}</td>
                                      <td><code>{f.CONVERSION_TABLE_BU}</code></td>
                                      <td>{f.tableRows === null ? <span className="val-ready val-ready-blocked">no table</span>
                                        : typeof f.tableRows === 'number' ? f.tableRows.toLocaleString()
                                        : <span className="val-muted">…</span>}</td>
                                      <td>{String(f.FileImportStatus).toUpperCase() === 'Y' ? '✓' : ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
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
