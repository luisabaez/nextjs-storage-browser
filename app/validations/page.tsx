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
import { RawFile, MergeResult, SamplingTarget, RelEdge, groupRawFiles, mergeGroup, mergeByRelationships, mergeHierarchy, resultToFileData, downloadMaster, appendValidationSheets } from './merge';
import { PlanRow, EntityGroup, groupEntityPlan, READINESS_LABEL } from './entityFiles';
import { GeneratedEntity, ManifestFileRow, listGeneratedEntities, loadGeneratedTagged, readEntityManifests, readAllManifests, fetchSamplingTargets, fetchSamplingRelationships, safeName } from './generated';
import { ValidationReport, EntityValidation, parseValidationReport, fileMatchesTable, buildCompositeKeyOverrides, entityEmailStatus, isSharedEntity, EMAIL_STATUS_LABEL, EMAIL_STATUS_ORDER, EmailStatus } from './validationReport';

Amplify.configure(config);

const SAMPLING_FOLDER = 'Sampling/';
const LOCAL_FOLDER = 'Sampling/Local/';
const CLIENT_FOLDER = 'Sampling/Client/';
const REPORT_PATH = 'Sampling/_status/agency_report.xlsx';
const VALIDATION_REPORT_PATH = 'Sampling/_status/entity_validation_report.xlsx';
const READINESS_PATH = 'Sampling/_status/entity_readiness.json';
const BU_ASSIGN_PATH = 'Sampling/_status/bu_assignments.json';
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

type TabId = 'sampling' | 'dashboard' | 'entities' | 'completeness' | 'bybu' | 'bufiles';
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

// Is a report file present among the generated manifests for an agency? Matches
// by agency (source or bu) and table-name (file label tokens ⊆ table name).
function presentFor(mans: ManifestFileRow[], label: string, agency: string) {
  const hits = mans.filter(m => (m.source === agency || m.bu === agency) && fileMatchesTable(label, m.table));
  return { present: hits.length > 0, rows: hits.reduce((s, r) => s + r.rows, 0), tables: Array.from(new Set(hits.map(h => h.table))) };
}

const normStr = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
// Match a generated-entity folder name (e.g. "Supplier", "AR_Invoices", "Awards")
// to a report entity ("Suppliers", "AR Invoices", "Projects"). Also considers the
// entity's master file label, since the report calls the awards entity "Projects"
// while its master file (and the generated folder) is "AWARDS".
function matchReportEntity(rep: ValidationReport, folder: string): EntityValidation | null {
  const nf = normStr(folder);
  if (!nf) return null;
  return rep.entities.find(e => {
    const master = e.files.find(f => f.role === 'master')?.label || '';
    const cands = [normStr(e.tab), normStr(e.entity), normStr(master)];
    return cands.some(a => a && (a.includes(nf) || nf.includes(a)));
  }) || null;
}

// Is an entity's file present for a BU? PRIFAS/shared entities count as present
// if generated at all (one file serves all their agencies); others need an
// agency-specific match.
function buFilePresent(mans: ManifestFileRow[], entity: string, label: string, bu: string) {
  if (isSharedEntity(entity)) {
    const hits = mans.filter(m => fileMatchesTable(label, m.table));
    return { present: hits.length > 0, rows: hits.reduce((s, r) => s + r.rows, 0), shared: true };
  }
  const p = presentFor(mans, label, bu);
  return { present: p.present, rows: p.rows, shared: false };
}

function emailStatusClass(s: EmailStatus): string {
  return s === 'ready' ? 'val-es-ready' : s === 'completed' ? 'val-es-completed'
    : s === 'hold' ? 'val-es-hold' : s === 'notpublished' ? 'val-es-notpub' : 'val-es-unknown';
}

function repStatusClass(status: string): string {
  const l = (status || '').toUpperCase();
  if (l.includes('CLEAN')) return 'val-rep-clean';
  if (l.includes('ORPHAN')) return 'val-rep-orphans';
  if (l.includes('PARTIAL')) return 'val-rep-partial';
  if (l.includes('STANDALONE')) return 'val-rep-standalone';
  return 'val-rep-other';
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
      const actor = userEmail ? `&actor=${encodeURIComponent(userEmail)}` : '';
      const url = `${LAMBDA_URL}?action=generate_entity_files&mock=${PLAN_MOCK}&entity=${encodeURIComponent(entity)}${dry ? '&dry_run=1' : ''}${actor}`;
      const d = await (await fetch(url)).json();
      if (!d.ok) { setEntGen(p => ({ ...p, [entity]: { state: 'error', error: d.error || 'Failed' } })); return; }
      setEntGen(p => ({ ...p, [entity]: { state: 'done', dry, planned: d.planned, generated: d.generated, folder: d.folder } }));
    } catch (e) {
      setEntGen(p => ({ ...p, [entity]: { state: 'error', error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  // Multi-select + batch generate (Entity Files tab).
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(new Set());
  const [batchGen, setBatchGen] = useState<{ running: boolean; done: number; total: number; dry: boolean }>({ running: false, done: 0, total: 0, dry: false });
  const toggleEntity = (entity: string) => setSelectedEntities(p => {
    const n = new Set(p); if (n.has(entity)) n.delete(entity); else n.add(entity); return n;
  });
  const doGenSelected = async (dry: boolean) => {
    const list = filteredEntities.map(g => g.entity).filter(e => selectedEntities.has(e));
    if (!list.length || batchGen.running) return;
    if (!dry && !confirm(`Generate files for ${list.length} selected entit${list.length !== 1 ? 'ies' : 'y'}? This reads the conversion tables and writes CV_ files to S3 for each (one at a time).`)) return;
    setBatchGen({ running: true, done: 0, total: list.length, dry });
    for (let i = 0; i < list.length; i++) {
      await doGen(list[i], dry);           // sequential — avoids hammering the Lambda/DB
      setBatchGen(b => ({ ...b, done: i + 1 }));
    }
    setBatchGen(b => ({ ...b, running: false }));
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

  // Add one sampling entry per merged master.
  const addMergeResults = useCallback((results: MergeResult[]) => {
    results.forEach((result, i) => {
      const id = `m-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      setEntries(prev => [...prev, {
        id,
        fileName: `Consolidated_${result.entityToken}_${result.bu || 'NA'}`,
        entity: matchEntity(result.entityToken) || '',
        agency: result.bu,
        N: result.recordCount,
        loading: false, error: '', data: resultToFileData(result),
        genStatus: 'idle', genError: '', generated: null, merged: result,
      }]);
    });
  }, []);

  // Group + merge raw parent/child files by the filename heuristic (drag-and-drop).
  const addRawResults = useCallback((raws: RawFile[]) => {
    const results: MergeResult[] = [];
    for (const g of groupRawFiles(raws)) {
      try { results.push(mergeGroup(g)); } catch (e) { console.error('merge failed', e); }
    }
    addMergeResults(results);
  }, [addMergeResults]);

  const addRawFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => /\.(xlsx|xlsm|xls)$/i.test(f.name));
    if (!list.length) return;
    const raws: RawFile[] = [];
    for (const file of list) {
      try { raws.push({ name: file.name, data: await readWorkbook(file) }); }
      catch (e) { console.error('read failed', file.name, e); }
    }
    addRawResults(raws);
  }, [addRawResults]);

  // ── Bridge: load server-generated CV_ files straight from S3 into the list ──
  const [genList, setGenList] = useState<GeneratedEntity[] | null>(null);
  const [genListLoading, setGenListLoading] = useState(false);
  const [genListError, setGenListError] = useState('');
  const [genLoading, setGenLoading] = useState<Record<string, { done: number; total: number }>>({});
  const [genNote, setGenNote] = useState('');
  const [showFlags, setShowFlags] = useState(false);
  const samplingTargetsRef = useRef<SamplingTarget[] | null>(null);
  const relationshipEdgesRef = useRef<RelEdge[] | null>(null);
  const compositeOverridesRef = useRef<Map<string, string[]> | null>(null);
  const valReportRef = useRef<ValidationReport | null>(null);
  const valManifestsRef = useRef<ManifestFileRow[] | null>(null);

  // "N/M expected files present" for a generated entity, per the validation report.
  const completenessNote = useCallback((folder: string): string => {
    const rep = valReportRef.current, mans = valManifestsRef.current;
    if (!rep || !mans) return '';
    const e = matchReportEntity(rep, folder);
    if (!e) return '';
    let total = 0, present = 0;
    for (const f of e.files) for (const ag of e.agencies) {
      const c = f.counts[ag];
      if (!c || c === 'N/A') continue;
      total++;
      if (presentFor(mans, f.label, ag).present) present++;
    }
    return total ? `completeness ${present}/${total} expected files present` : '';
  }, []);

  const refreshGenerated = useCallback(async (): Promise<GeneratedEntity[]> => {
    setGenListLoading(true);
    setGenListError('');
    try {
      const items = await listGeneratedEntities(PLAN_MOCK);
      setGenList(items);
      return items;
    } catch (e) {
      setGenListError(e instanceof Error ? e.message : String(e));
      return [];
    } finally {
      setGenListLoading(false);
    }
  }, [PLAN_MOCK]);

  const loadFromGenerated = useCallback(async (g: GeneratedEntity) => {
    setGenLoading(p => ({ ...p, [g.entity]: { done: 0, total: g.files.length } }));
    setGenNote('');
    try {
      // Fetch the relationship graph + full edge list (once), then download + tag.
      if (!samplingTargetsRef.current) {
        try { samplingTargetsRef.current = await fetchSamplingTargets(LAMBDA_URL); }
        catch (e) { console.error('sampling_targets failed', e); samplingTargetsRef.current = []; }
      }
      if (!relationshipEdgesRef.current) {
        try { relationshipEdgesRef.current = await fetchSamplingRelationships(LAMBDA_URL); }
        catch (e) { console.error('sampling_relationships failed', e); relationshipEdgesRef.current = []; }
      }
      const manifest = await readEntityManifests(PLAN_MOCK, g.entity);
      const tagged = await loadGeneratedTagged(g, manifest, (done, total) =>
        setGenLoading(p => ({ ...p, [g.entity]: { done, total } })));

      const label = g.entity.replace(/_/g, ' ');
      const targets = samplingTargetsRef.current || [];
      const edges = relationshipEdgesRef.current || [];
      const overrides = compositeOverridesRef.current || undefined;
      if (targets.length && manifest.size) {
        // Multi-level relationship merge (falls back to direct-child if the full
        // edge graph is unavailable). Group by real source; composite keys honoured.
        const results = edges.length
          ? mergeHierarchy(tagged, targets, edges, overrides)
          : mergeByRelationships(tagged, targets, overrides);
        addMergeResults(results);
        const flagged = results.reduce((s, r) => s + r.warnings.length, 0);
        const complete = completenessNote(g.entity);
        setGenNote(`${label}: ${edges.length ? 'multi-level' : 'relationship'} merge · ${results.length} master${results.length !== 1 ? 's' : ''}${flagged ? ` · ${flagged} file(s) flagged` : ''}${complete ? ` · ${complete}` : ''}.`);
      } else {
        // No manifest (older generation) → fall back to filename grouping.
        addRawResults(tagged);
        setGenNote(`${label}: filename grouping (no manifest found — re-generate to enable the relationship-aware merge).`);
      }
    } catch (e) {
      console.error('load-from-generated failed', e);
      setGenListError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenLoading(p => { const n = { ...p }; delete n[g.entity]; return n; });
    }
  }, [addMergeResults, addRawResults, completenessNote]);

  // Jump from the Entity Files tab to Sampling and load that entity's files.
  const loadGeneratedByEntity = useCallback(async (entity: string) => {
    setActiveTab('sampling');
    const items = genList ?? await refreshGenerated();
    const g = items.find(x => x.entity === safeName(entity));
    if (g) loadFromGenerated(g);
    else setGenListError(`No generated files found for ${entity} yet — run Generate first.`);
  }, [genList, refreshGenerated, loadFromGenerated]);

  // ── Completeness: validation report (expected files) vs what's generated ──
  const [valReport, setValReport] = useState<ValidationReport | null>(null);
  const [valLoading, setValLoading] = useState(false);
  const [valError, setValError] = useState('');
  const [valLoaded, setValLoaded] = useState(false);
  const [valExpanded, setValExpanded] = useState<Record<string, boolean>>({});
  const [valManifests, setValManifests] = useState<ManifestFileRow[]>([]);
  const valReportInputRef = useRef<HTMLInputElement>(null);

  // Editable delivery-status overlay (from the status emails), persisted to S3.
  // Keyed by the report entity's normalized tab name.
  const [readiness, setReadiness] = useState<Record<string, EmailStatus>>({});
  const [readinessSaving, setReadinessSaving] = useState(false);
  const [readinessSavedAt, setReadinessSavedAt] = useState('');
  const statusForTab = useCallback((tab: string, entity: string): EmailStatus =>
    readiness[normStr(tab)] ?? entityEmailStatus(entity).status, [readiness]);

  // Load the saved overrides (else seed every entity from the hard-coded defaults).
  const loadReadiness = useCallback(async (report: ValidationReport) => {
    let saved: Record<string, EmailStatus> = {};
    try {
      const { url } = await getUrl({ path: READINESS_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (resp.ok) saved = await resp.json();
    } catch { /* not saved yet */ }
    const merged: Record<string, EmailStatus> = {};
    for (const e of report.entities) {
      const k = normStr(e.tab);
      merged[k] = saved[k] ?? entityEmailStatus(e.entity).status;
    }
    setReadiness(merged);
  }, []);

  const saveReadiness = useCallback(async () => {
    setReadinessSaving(true);
    try {
      await uploadData({ path: READINESS_PATH, data: new Blob([JSON.stringify(readiness)], { type: 'application/json' }), options: { contentType: 'application/json' } }).result;
      setReadinessSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      console.error('save readiness failed', e);
    } finally {
      setReadinessSaving(false);
    }
  }, [readiness]);

  // Editable BU → entities assignments (which entities/files each BU needs),
  // seeded from the report's Present-in-agencies, persisted to S3.
  const [buAssignments, setBuAssignments] = useState<Record<string, string[]>>({});
  const [buAssignSaving, setBuAssignSaving] = useState(false);
  const [buAssignSavedAt, setBuAssignSavedAt] = useState('');

  const loadBuAssignments = useCallback(async (report: ValidationReport) => {
    let saved: Record<string, string[]> = {};
    try {
      const { url } = await getUrl({ path: BU_ASSIGN_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (resp.ok) saved = await resp.json();
    } catch { /* not saved yet */ }
    const merged: Record<string, string[]> = {};
    for (const bu of report.agencies) {
      merged[bu] = saved[bu] ?? report.entities.filter(e => e.agencies.includes(bu)).map(e => e.tab);
    }
    for (const bu of Object.keys(saved)) if (!merged[bu]) merged[bu] = saved[bu];
    setBuAssignments(merged);
  }, []);

  const saveBuAssignments = useCallback(async () => {
    setBuAssignSaving(true);
    try {
      await uploadData({ path: BU_ASSIGN_PATH, data: new Blob([JSON.stringify(buAssignments)], { type: 'application/json' }), options: { contentType: 'application/json' } }).result;
      setBuAssignSavedAt(new Date().toLocaleTimeString());
    } catch (e) { console.error('save bu assignments failed', e); }
    finally { setBuAssignSaving(false); }
  }, [buAssignments]);

  const applyReport = useCallback((report: ValidationReport, manifests: ManifestFileRow[]) => {
    setValReport(report); valReportRef.current = report;
    setValManifests(manifests); valManifestsRef.current = manifests;
    compositeOverridesRef.current = buildCompositeKeyOverrides(report, samplingTargetsRef.current || []);
    loadReadiness(report);
    loadBuAssignments(report);
  }, [loadReadiness, loadBuAssignments]);

  const ensureTargets = useCallback(async () => {
    if (!samplingTargetsRef.current) {
      try { samplingTargetsRef.current = await fetchSamplingTargets(LAMBDA_URL); }
      catch { samplingTargetsRef.current = []; }
    }
  }, []);

  const loadValReport = useCallback(async () => {
    setValLoading(true); setValError('');
    try {
      await ensureTargets();
      const manifests = await readAllManifests(PLAN_MOCK).catch(() => [] as ManifestFileRow[]);
      const { url } = await getUrl({ path: VALIDATION_REPORT_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error('fetch failed');
      applyReport(parseValidationReport(await resp.arrayBuffer()), manifests);
    } catch {
      setValReport(null); // not uploaded yet — prompt to upload
    } finally {
      setValLoading(false); setValLoaded(true);
    }
  }, [applyReport, ensureTargets, PLAN_MOCK]);

  const uploadValReport = useCallback(async (file: File) => {
    setValLoading(true); setValError('');
    try {
      const buf = await file.arrayBuffer();
      await uploadData({ path: VALIDATION_REPORT_PATH, data: new Blob([buf], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;
      await ensureTargets();
      const manifests = await readAllManifests(PLAN_MOCK).catch(() => [] as ManifestFileRow[]);
      applyReport(parseValidationReport(buf), manifests);
    } catch (e) {
      setValError(e instanceof Error ? e.message : String(e));
    } finally {
      setValLoading(false); setValLoaded(true);
    }
  }, [applyReport, ensureTargets, PLAN_MOCK]);

  useEffect(() => {
    if ((activeTab === 'completeness' || activeTab === 'bybu' || activeTab === 'bufiles') && !valLoaded) loadValReport();
  }, [activeTab, valLoaded, loadValReport]);
  // The BU Files "add entity" dropdown also offers conversion-plan entities (e.g. Location).
  useEffect(() => {
    if (activeTab === 'bufiles' && !planLoaded && !planLoading) loadPlan();
  }, [activeTab, planLoaded, planLoading, loadPlan]);

  // ── Sample by BU ──
  const [selectedBU, setSelectedBU] = useState('');
  const [buLoading, setBuLoading] = useState(false);
  useEffect(() => {
    if (valReport && !selectedBU && valReport.agencies.length) setSelectedBU(valReport.agencies[0]);
  }, [valReport, selectedBU]);

  // ── BU Files editor state ──
  const [buFilesSel, setBuFilesSel] = useState('');
  const [newBuInput, setNewBuInput] = useState('');
  const [addEntSel, setAddEntSel] = useState('');
  useEffect(() => {
    const keys = Object.keys(buAssignments);
    if (keys.length && (!buFilesSel || !keys.includes(buFilesSel))) setBuFilesSel(keys.sort()[0]);
  }, [buAssignments, buFilesSel]);

  // Entities available to assign: report entities (by tab) + conversion-plan entities.
  const availableEntityNames = React.useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    const add = (name: string) => { const k = normStr(name); if (name && !seen.has(k)) { seen.add(k); out.push(name); } };
    (valReport?.entities || []).forEach(e => add(e.tab));
    entityGroups.forEach(g => add(g.entity));
    return out.sort((a, b) => a.localeCompare(b));
  }, [valReport, entityGroups]);

  // Load every file-ready entity for a BU into the Sampling list (filtered to that
  // BU; PRIFAS/shared entities load whole, per the email's one-file-per-PRIFAS rule).
  const loadBUIntoSampling = useCallback(async (bu: string) => {
    if (!valReport) return;
    setBuLoading(true);
    try {
      await ensureTargets();
      if (!relationshipEdgesRef.current) {
        try { relationshipEdgesRef.current = await fetchSamplingRelationships(LAMBDA_URL); } catch { relationshipEdgesRef.current = []; }
      }
      const items = genList ?? await refreshGenerated();
      const targets = samplingTargetsRef.current || [];
      const edges = relationshipEdgesRef.current || [];
      const overrides = compositeOverridesRef.current || undefined;
      const applicable = valReport.entities.filter(e => e.agencies.includes(bu));
      let loadedEntities = 0, masters = 0;
      for (const e of applicable) {
        // file-ready = every expected file present for this BU
        const ready = e.files.every(f => {
          const c = f.counts[bu]; if (!c || c === 'N/A') return true;
          return buFilePresent(valManifestsRef.current || [], e.entity, f.label, bu).present;
        });
        if (!ready) continue;
        const g = items.find(x => matchReportEntity(valReport, x.entity)?.tab === e.tab);
        if (!g) continue;
        const manifest = await readEntityManifests(PLAN_MOCK, g.entity);
        const tagged = await loadGeneratedTagged(g, manifest);
        const shared = isSharedEntity(e.entity);
        const forBU = shared ? tagged : tagged.filter(t => t.source === bu || t.bu === bu);
        if (!forBU.length) continue;
        const results = edges.length ? mergeHierarchy(forBU, targets, edges, overrides) : mergeByRelationships(forBU, targets, overrides);
        addMergeResults(results);
        loadedEntities++; masters += results.length;
      }
      setActiveTab('sampling');
      setGenNote(`BU ${bu}: loaded ${loadedEntities} ready entit${loadedEntities !== 1 ? 'ies' : 'y'} → ${masters} master${masters !== 1 ? 's' : ''} into the sampling list.`);
    } catch (e) {
      console.error('load-bu failed', e);
    } finally {
      setBuLoading(false);
    }
  }, [valReport, ensureTargets, genList, refreshGenerated, addMergeResults]);

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
        <button className={`val-tab-btn ${activeTab === 'completeness' ? 'active' : ''}`} onClick={() => setActiveTab('completeness')}>
          Completeness
        </button>
        <button className={`val-tab-btn ${activeTab === 'bybu' ? 'active' : ''}`} onClick={() => setActiveTab('bybu')}>
          Sample by BU
        </button>
        <button className={`val-tab-btn ${activeTab === 'bufiles' ? 'active' : ''}`} onClick={() => setActiveTab('bufiles')}>
          BU Files
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

          <div className="val-generated">
            <div className="val-generated-head">
              <div>
                <strong>Or load generated files from S3</strong>
                <span className="val-dropzone-hint"> — pull an entity&rsquo;s CV_ files straight from Sampling/Generated and merge them by agency (same grouping as the drop above), no download needed</span>
              </div>
              <button className="val-btn-secondary" onClick={() => refreshGenerated()} disabled={genListLoading}>
                {genListLoading ? <><span className="val-spinner val-spinner-dark" /> Loading…</> : (genList ? '↻ Refresh' : '📂 Browse generated')}
              </button>
            </div>
            {genListError && <div className="val-file-err">{genListError}</div>}
            {genNote && <div className="val-gen-note-inline">{genNote}</div>}
            {(() => {
              const flags = entries.flatMap(e => (e.merged?.warnings || []).map(w => ({ master: e.fileName, w })));
              if (!flags.length) return null;
              const masters = new Set(flags.map(f => f.master)).size;
              return (
                <div className="val-flags">
                  <button className="val-flags-toggle" onClick={() => setShowFlags(s => !s)}>
                    {showFlags ? '▾' : '▸'} ⚠ {flags.length} flagged file{flags.length !== 1 ? 's' : ''} across {masters} master{masters !== 1 ? 's' : ''} — {showFlags ? 'hide' : 'show to diagnose'}
                  </button>
                  {showFlags && (
                    <div className="val-flags-list">
                      {flags.map((f, i) => (
                        <div key={i} className="val-flags-item"><code>{f.master}</code> — {f.w}</div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
            {genList && genList.length === 0 && !genListLoading && (
              <div className="val-muted val-generated-empty">No generated files yet — generate them from the Entity Files tab.</div>
            )}
            {genList && genList.length > 0 && (
              <div className="val-generated-grid">
                {genList.map(g => {
                  const prog = genLoading[g.entity];
                  return (
                    <div key={g.entity} className="val-generated-item">
                      <div className="val-generated-info">
                        <span className="val-generated-entity" title={g.entity}>{g.entity.replace(/_/g, ' ')}</span>
                        <span className="val-muted">
                          {g.files.length} file{g.files.length !== 1 ? 's' : ''}
                          {g.lastModified ? ` · ${g.lastModified.toLocaleDateString()}` : ''}
                        </span>
                      </div>
                      <button className="val-btn-row" disabled={!!prog} onClick={() => loadFromGenerated(g)}>
                        {prog ? <><span className="val-spinner val-spinner-dark" /> {prog.done}/{prog.total}</> : '→ Load & merge'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
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

              <div className="val-batchbar">
                <span className="val-muted"><b>{selectedEntities.size}</b> selected</span>
                <button className="val-btn-secondary" disabled={!selectedEntities.size || batchGen.running} onClick={() => doGenSelected(true)}>Preview selected</button>
                <button className="val-btn-row" disabled={!selectedEntities.size || batchGen.running} onClick={() => doGenSelected(false)}>Generate selected</button>
                {batchGen.running && <span className="val-gen-status"><span className="val-spinner val-spinner-dark" /> {batchGen.dry ? 'previewing' : 'generating'} {batchGen.done}/{batchGen.total}…</span>}
                {selectedEntities.size > 0 && !batchGen.running && <button className="val-link-btn" onClick={() => setSelectedEntities(new Set())}>clear</button>}
              </div>

              <table className="val-table val-bu">
                <thead>
                  <tr>
                    <th className="val-col-check">
                      <input type="checkbox" aria-label="Select all"
                        checked={filteredEntities.length > 0 && filteredEntities.every(g => selectedEntities.has(g.entity))}
                        ref={el => { if (el) el.indeterminate = filteredEntities.some(g => selectedEntities.has(g.entity)) && !filteredEntities.every(g => selectedEntities.has(g.entity)); }}
                        onChange={() => setSelectedEntities(p => {
                          const all = filteredEntities.every(g => p.has(g.entity));
                          const n = new Set(p);
                          filteredEntities.forEach(g => all ? n.delete(g.entity) : n.add(g.entity));
                          return n;
                        })} />
                    </th>
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
                          <td className="val-col-check">
                            <input type="checkbox" aria-label={`Select ${g.entity}`} checked={selectedEntities.has(g.entity)}
                              onClick={e => e.stopPropagation()} onChange={() => toggleEntity(g.entity)} />
                          </td>
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
                                      <span className="val-gen-status">
                                        ✓ Generated <b>{gs.generated.length}</b> file(s) to <code>{gs.folder}</code>
                                        <button className="val-link-btn val-gen-load" onClick={() => loadGeneratedByEntity(g.entity)}>→ load into sampling</button>
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}
                              <table className="val-child-table">
                                <thead><tr><th>SubEntity</th><th>Source</th><th>BU</th><th>Conversion table</th><th>Source file</th><th>Rows</th><th>Imported</th></tr></thead>
                                <tbody>
                                  {g.files.map((f, i) => (
                                    <tr key={i}>
                                      <td>{f.SubEntity || '—'}</td>
                                      <td>{f.SOURCE || '—'}</td>
                                      <td>{f.BU || <span className="val-muted">—</span>}</td>
                                      <td><code>{f.CONVERSION_TABLE_BU}</code></td>
                                      <td className="val-src-file" title={f.SourceFileName}>{f.SourceFileName || <span className="val-muted">—</span>}</td>
                                      <td>{f.tableRows === null ? <span className="val-ready val-ready-blocked">no table</span>
                                        : typeof f.tableRows === 'number' ? f.tableRows.toLocaleString()
                                        : <span className="val-muted">…</span>}</td>
                                      <td>{String(f.FileImportStatus).toUpperCase() === 'Y' ? <span className="val-comp-ok">✓</span> : <span className="val-comp-missing" title="not imported">✗</span>}</td>
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

      {activeTab === 'completeness' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>File Completeness ({PLAN_MOCK})</h2>
            <p>
              Expected master + child files per entity and agency, from the Multi-Agency Entity
              Validation Report, checked against what has been generated to Sampling/Generated.
              Confirm every expected file is present (and the counts line up) before sampling.
              {valReport && <> Agencies in scope: {valReport.agencies.join(', ')}.</>}
            </p>
          </div>

          {valError && <div className="val-error">{valError}</div>}
          {valLoading && <div className="val-loading"><span className="val-spinner val-spinner-dark" /> Loading validation report…</div>}

          {!valLoading && !valReport && (
            <div className="val-dropzone" onClick={() => valReportInputRef.current?.click()}>
              <input ref={valReportInputRef} type="file" accept=".xlsx,.xlsm,.xls" style={{ display: 'none' }}
                onChange={e => { if (e.target.files?.[0]) uploadValReport(e.target.files[0]); e.target.value = ''; }} />
              <span className="val-dropzone-icon">📋</span>
              <p><strong>Upload the Entity Validation Report</strong> to load the completeness view</p>
              <p className="val-dropzone-hint">Entity_Validation_Report_*.xlsx — it will be saved and auto-load next time</p>
            </div>
          )}

          {!valLoading && valReport && (() => {
            const mans = valManifests;
            let totExp = 0, totPresent = 0;
            valReport.entities.forEach(e => e.files.forEach(f => e.agencies.forEach(ag => {
              const c = f.counts[ag]; if (!c || c === 'N/A') return; totExp++;
              if (presentFor(mans, f.label, ag).present) totPresent++;
            })));
            return (
              <>
                <div className="val-cards" style={{ margin: '4px 0 14px' }}>
                  <div className="val-card"><span className="val-card-num">{valReport.entities.length}</span><span className="val-card-label">Entities</span></div>
                  <div className="val-card"><span className="val-card-num">{valReport.agencies.length}</span><span className="val-card-label">Agencies</span></div>
                  <div className="val-card"><span className="val-card-num">{totExp}</span><span className="val-card-label">Expected files</span></div>
                  <div className="val-card"><span className="val-card-num">{totPresent}/{totExp}</span><span className="val-card-label">Present (generated)</span></div>
                </div>

                <div className="val-dash-controls">
                  <span className="val-muted">Expand an entity for expected files vs generated, per agency.</span>
                  <button className="val-btn-secondary" onClick={() => valReportInputRef.current?.click()}>Update report</button>
                  <input ref={valReportInputRef} type="file" accept=".xlsx,.xlsm,.xls" style={{ display: 'none' }}
                    onChange={e => { if (e.target.files?.[0]) uploadValReport(e.target.files[0]); e.target.value = ''; }} />
                </div>

                <div className="val-readiness">
                  <div className="val-readiness-head">
                    <div>
                      <strong>Delivery status</strong>
                      <span className="val-dropzone-hint"> — set from the status emails; edit a dropdown and Save to update the overlay (also drives Sample by BU). Saved to S3, auto-loads next time.</span>
                    </div>
                    <div className="val-readiness-actions">
                      {readinessSavedAt && <span className="val-muted">saved {readinessSavedAt}</span>}
                      <button className="val-btn-secondary" onClick={saveReadiness} disabled={readinessSaving}>
                        {readinessSaving ? <><span className="val-spinner val-spinner-dark" /> Saving…</> : 'Save status'}
                      </button>
                    </div>
                  </div>
                  <div className="val-readiness-grid">
                    {valReport.entities.map(e => {
                      const k = normStr(e.tab);
                      const cur = readiness[k] ?? entityEmailStatus(e.entity).status;
                      return (
                        <label key={e.tab} className="val-readiness-item">
                          <span className="val-readiness-name" title={e.entity}>{e.entity}</span>
                          <select className={`val-readiness-sel ${emailStatusClass(cur)}`} value={cur}
                            onChange={ev => setReadiness(p => ({ ...p, [k]: ev.target.value as EmailStatus }))}>
                            {EMAIL_STATUS_ORDER.map(sv => <option key={sv} value={sv}>{EMAIL_STATUS_LABEL[sv]}</option>)}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <table className="val-table val-bu">
                  <thead>
                    <tr>
                      <th className="val-col-caret"></th>
                      <th>Entity</th>
                      <th>Linking key</th>
                      <th>Agencies</th>
                      <th>Status</th>
                      <th className="val-col-num">Expected</th>
                      <th className="val-col-num">Present</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valReport.entities.map(e => {
                      const open = !!valExpanded[e.tab];
                      let exp = 0, pres = 0;
                      e.files.forEach(f => e.agencies.forEach(ag => { const c = f.counts[ag]; if (!c || c === 'N/A') return; exp++; if (presentFor(mans, f.label, ag).present) pres++; }));
                      return (
                        <React.Fragment key={e.tab}>
                          <tr className="val-bu-row" onClick={() => setValExpanded(p => ({ ...p, [e.tab]: !p[e.tab] }))}>
                            <td className="val-col-caret"><span className="val-caret">{open ? '▾' : '▸'}</span></td>
                            <td className="val-bu-unit">{e.entity}</td>
                            <td className="val-muted" title={e.howItLinks}>{e.key}</td>
                            <td className="val-muted">{e.agencies.join(', ')}</td>
                            <td><span className={`val-repstatus ${repStatusClass(e.status)}`}>{e.status}</span></td>
                            <td className="val-col-num">{exp}</td>
                            <td className="val-col-num">{pres < exp ? <span className="val-pending-count">{pres}/{exp}</span> : `${pres}/${exp}`}</td>
                          </tr>
                          {open && (
                            <tr className="val-bu-detail-row">
                              <td></td>
                              <td colSpan={6}>
                                {e.howItLinks && <div className="val-comp-links"><b>How it links:</b> {e.howItLinks}</div>}
                                <table className="val-child-table val-comp-matrix">
                                  <thead>
                                    <tr><th>Expected file</th><th></th>{e.agencies.map(a => <th key={a} className="val-col-num">{a}</th>)}</tr>
                                  </thead>
                                  <tbody>
                                    {e.files.map((f, fi) => (
                                      <tr key={fi}>
                                        <td>{f.label}</td>
                                        <td className="val-muted">{f.role}</td>
                                        {e.agencies.map(ag => {
                                          const c = f.counts[ag];
                                          if (!c || c === 'N/A') return <td key={ag} className="val-col-num val-muted">—</td>;
                                          const st = presentFor(mans, f.label, ag);
                                          const exact = st.present && st.rows === c.rows;
                                          return (
                                            <td key={ag} className="val-col-num"
                                              title={st.present ? `generated: ${st.rows.toLocaleString()} rows (${st.tables.join(', ')})` : 'not found in Sampling/Generated'}>
                                              {c.rows.toLocaleString()}{' '}
                                              <span className={st.present ? (exact ? 'val-comp-ok' : 'val-comp-warn') : 'val-comp-missing'}>
                                                {st.present ? (exact ? '✓' : '≠') : '✗'}
                                              </span>
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {e.integrity.length > 0 && (
                                  <table className="val-child-table val-comp-integrity">
                                    <thead>
                                      <tr><th>Child integrity (orphans / missing)</th>{e.agencies.map(a => <th key={a} className="val-col-num">{a}</th>)}<th>Status</th></tr>
                                    </thead>
                                    <tbody>
                                      {e.integrity.map((ir, ii) => (
                                        <tr key={ii}>
                                          <td>{ir.child}</td>
                                          {e.agencies.map(ag => { const v = ir.perAgency[ag]; return <td key={ag} className="val-col-num">{v ? `${v.orphans} / ${v.missing}` : '—'}</td>; })}
                                          <td><span className={`val-repstatus ${repStatusClass(ir.status)}`}>{ir.status}</span></td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                                {e.notes.length > 0 && <div className="val-comp-notes"><b>Notes:</b> {e.notes.join(' · ')}</div>}
                                {e.verdict && <div className="val-comp-verdict">{e.verdict}</div>}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </>
            );
          })()}
        </div>
      )}

      {activeTab === 'bybu' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>Sample by BU</h2>
            <p>
              Pick a business unit to see every entity and master/child file it expects
              (from the validation report&rsquo;s <em>Present in agencies</em>), whether those files
              have been generated, and the latest email status. When a BU&rsquo;s files are ready,
              load them into the Sampling tab to run the sample. PRIFAS entities (Suppliers,
              Projects) share one file across all their agencies.
            </p>
          </div>

          {valLoading && <div className="val-loading"><span className="val-spinner val-spinner-dark" /> Loading validation report…</div>}
          {!valLoading && !valReport && (
            <div className="val-error">
              Upload the Entity Validation Report on the <button className="val-link-btn" onClick={() => setActiveTab('completeness')}>Completeness</button> tab first — it drives this view.
            </div>
          )}

          {!valLoading && valReport && (() => {
            const mans = valManifests;
            const assignedTabs = buAssignments[selectedBU];
            const rows = valReport.entities
              .filter(e => assignedTabs ? assignedTabs.includes(e.tab) : e.agencies.includes(selectedBU))
              .map(e => {
                const status = statusForTab(e.tab, e.entity);
                const def = entityEmailStatus(e.entity);
                const note = status === def.status ? def.note : undefined;
                let exp = 0, pres = 0;
                const fileStates = e.files.map(f => {
                  const c = f.counts[selectedBU];
                  if (!c || c === 'N/A') return { label: f.label, role: f.role, na: true, present: false, expected: 0, rows: 0 };
                  exp++;
                  const st = buFilePresent(mans, e.entity, f.label, selectedBU);
                  if (st.present) pres++;
                  return { label: f.label, role: f.role, na: false, present: st.present, expected: c.rows, rows: st.rows };
                });
                return { e, status, note, exp, pres, ready: exp > 0 && pres === exp, fileStates };
              });
            const readyCount = rows.filter(r => r.ready).length;
            const anyReady = rows.some(r => r.ready);
            return (
              <>
                <div className="val-bu-controls">
                  <label className="val-bu-pick">BU
                    <select value={selectedBU} onChange={ev => setSelectedBU(ev.target.value)}>
                      {valReport.agencies.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </label>
                  <span className="val-muted">{readyCount} of {rows.length} entities ready</span>
                  <button className="val-btn-row" disabled={!anyReady || buLoading} onClick={() => loadBUIntoSampling(selectedBU)}>
                    {buLoading ? <><span className="val-spinner" /> Loading…</> : `→ Load ${selectedBU}'s ready entities into Sampling`}
                  </button>
                </div>

                <table className="val-table val-bu">
                  <thead>
                    <tr>
                      <th>Entity</th><th>Linking key</th><th>Email status</th>
                      <th className="val-col-num">Files</th><th>Expected files (✓ present / ✗ missing)</th><th>Ready</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.e.tab}>
                        <td className="val-bu-unit">{r.e.entity}</td>
                        <td className="val-muted" title={r.e.howItLinks}>{r.e.key}</td>
                        <td>
                          <span className={`val-repstatus ${emailStatusClass(r.status)}`}>{EMAIL_STATUS_LABEL[r.status]}</span>
                          {r.note && <span className="val-muted val-es-note"> {r.note}</span>}
                        </td>
                        <td className="val-col-num">{r.pres}/{r.exp}</td>
                        <td className="val-bu-files">
                          {r.fileStates.filter(f => !f.na).map((f, i) => (
                            <span key={i} className={`val-bu-file ${f.present ? 'ok' : 'missing'}`} title={f.present ? `${f.rows.toLocaleString()} rows generated` : 'not generated for this BU'}>
                              {f.present ? '✓' : '✗'} {f.label}
                            </span>
                          ))}
                        </td>
                        <td>{r.ready ? <span className="val-repstatus val-rep-clean">Ready</span> : <span className="val-repstatus val-rep-orphans">{r.exp - r.pres} missing</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="val-muted val-bu-foot">
                  &ldquo;Ready&rdquo; means every expected master/child file for BU {selectedBU} has been generated. Email status is advisory —
                  it reflects which entities the team said are workable now (from the latest status email).
                </p>
              </>
            );
          })()}
        </div>
      )}

      {activeTab === 'bufiles' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>BU Files</h2>
            <p>
              Which entities (and their master/child files) each BU needs — seeded from the validation
              report&rsquo;s <em>Present in agencies</em>. Add, edit or delete assignments as requirements change
              (e.g. add Location to 015) and Save; assignments persist to S3 and drive the Sample by BU tab.
            </p>
          </div>

          {valLoading && <div className="val-loading"><span className="val-spinner val-spinner-dark" /> Loading…</div>}
          {!valLoading && !valReport && (
            <div className="val-error">Upload the Entity Validation Report on the <button className="val-link-btn" onClick={() => setActiveTab('completeness')}>Completeness</button> tab first — it seeds this view.</div>
          )}

          {!valLoading && valReport && (() => {
            const bus = Object.keys(buAssignments).sort();
            const assigned = buAssignments[buFilesSel] || [];
            const reportByTab = new Map(valReport.entities.map(e => [e.tab, e]));
            const addable = availableEntityNames.filter(n => !assigned.some(a => normStr(a) === normStr(n)));
            const addEntity = () => {
              if (!addEntSel) return;
              setBuAssignments(p => ({ ...p, [buFilesSel]: [...(p[buFilesSel] || []), addEntSel] }));
              setAddEntSel('');
            };
            const removeEntity = (name: string) => setBuAssignments(p => ({ ...p, [buFilesSel]: (p[buFilesSel] || []).filter(x => x !== name) }));
            const addBU = () => {
              const b = newBuInput.trim();
              if (!b || buAssignments[b]) return;
              setBuAssignments(p => ({ ...p, [b]: [] })); setBuFilesSel(b); setNewBuInput('');
            };
            const deleteBU = () => {
              if (!buFilesSel || !confirm(`Remove BU ${buFilesSel} and its assignments? (Save to persist.)`)) return;
              setBuAssignments(p => { const n = { ...p }; delete n[buFilesSel]; return n; });
            };
            return (
              <>
                <div className="val-bu-controls">
                  <label className="val-bu-pick">BU
                    <select value={buFilesSel} onChange={e => setBuFilesSel(e.target.value)}>
                      {bus.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </label>
                  <span className="val-muted">{assigned.length} entit{assigned.length !== 1 ? 'ies' : 'y'} assigned</span>
                  <input className="val-search val-bu-newbu" placeholder="new BU #" value={newBuInput} onChange={e => setNewBuInput(e.target.value)} />
                  <button className="val-btn-secondary" onClick={addBU} disabled={!newBuInput.trim()}>Add BU</button>
                  <button className="val-btn-secondary" onClick={saveBuAssignments} disabled={buAssignSaving}>
                    {buAssignSaving ? <><span className="val-spinner val-spinner-dark" /> Saving…</> : 'Save assignments'}
                  </button>
                  {buAssignSavedAt && <span className="val-muted">saved {buAssignSavedAt}</span>}
                  {buFilesSel && <button className="val-link-btn" onClick={deleteBU}>delete BU {buFilesSel}</button>}
                </div>

                <div className="val-bu-addrow">
                  <label className="val-bu-pick">Add entity
                    <select value={addEntSel} onChange={e => setAddEntSel(e.target.value)}>
                      <option value="">— select entity —</option>
                      {addable.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <button className="val-btn-row" onClick={addEntity} disabled={!addEntSel || !buFilesSel}>+ Add to {buFilesSel || 'BU'}</button>
                </div>

                <table className="val-table val-bu">
                  <thead><tr><th>Entity</th><th>Master / child files</th><th>In report</th><th></th></tr></thead>
                  <tbody>
                    {assigned.length === 0 && <tr><td colSpan={4} className="val-muted" style={{ padding: '14px' }}>No entities assigned to {buFilesSel} yet — add one above.</td></tr>}
                    {assigned.map(name => {
                      const e = reportByTab.get(name);
                      return (
                        <tr key={name}>
                          <td className="val-bu-unit">{name}</td>
                          <td className="val-bu-files">
                            {e ? e.files.map((f, i) => <span key={i} className={`val-bu-file ${f.role === 'master' ? 'ok' : ''}`} title={f.role}>{f.label}</span>)
                              : <span className="val-muted">not in the validation report — no file spec</span>}
                          </td>
                          <td>{e ? <span className="val-repstatus val-rep-clean">yes</span> : <span className="val-repstatus val-rep-other">no</span>}</td>
                          <td><button className="val-remove" onClick={() => removeEntity(name)} aria-label={`Remove ${name}`}>×</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="val-muted val-bu-foot">
                  Entities in the report bring their master/child file spec (used by Completeness &amp; Sample by BU).
                  Entities not in the report (e.g. Location) are recorded here as a requirement but need a file spec added to
                  the report before they can be file-checked or sampled. Changes take effect after <b>Save assignments</b>.
                </p>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

export default withAuthenticator(ValidationsPage);
