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
  Tier,
  tierForEntity,
  computeSampleSize,
  parseFilename,
  selectSample,
  buildWorkbook,
  downloadWorkbook,
  matchEntity,
  FileData,
  parsePriorSample,
  verifyReproduction,
  PriorSample,
  parseWorkbookBuffer,
} from './sampling';
import { parseAgencyReport, AgencyReport, buildGroups } from './dashboard';
import { RawFile, MergeResult, SamplingTarget, RelEdge, TaggedFile, groupRawFiles, mergeGroup, mergeByRelationships, mergeHierarchy, resultToFileData, downloadMaster } from './merge';
import { buildPerFileReport, mergeResultToReportFiles, singleFileReport, reportToBuffer, downloadReport, buildTrackingReport, ReportFile } from './excelReport';
import { PlanRow, EntityGroup, groupEntityPlan, READINESS_LABEL } from './entityFiles';
import { GeneratedEntity, ManifestFileRow, EmptyRow, listGeneratedEntities, loadGeneratedTagged, readEntityManifests, readAllManifests, fetchSamplingTargets, fetchSamplingRelationships, safeName } from './generated';
import { ValidationReport, EntityValidation, parseValidationReport, fileMatchesTable, buildCompositeKeyOverrides, entityEmailStatus, isSharedEntity, EMAIL_STATUS_LABEL, EMAIL_STATUS_ORDER, EmailStatus } from './validationReport';

Amplify.configure(config);

const SAMPLING_FOLDER = 'Sampling/';
const LOCAL_FOLDER = 'Sampling/Local/';
const CLIENT_FOLDER = 'Sampling/Client/';
const REPORTS_FOLDER = 'Sampling/Reports/';
const SAMPLING_CONFIG_PATH = 'Sampling/_status/sampling_config_MOCK14.xlsx';
const REPORT_PATH = 'Sampling/_status/agency_report.xlsx';
const VALIDATION_REPORT_PATH = 'Sampling/_status/entity_validation_report.xlsx';
const READINESS_PATH = 'Sampling/_status/entity_readiness.json';
const BU_ASSIGN_PATH = 'Sampling/_status/bu_assignments.json';
const LINK_KEYS_PATH = 'Sampling/_status/entity_link_keys.json';
const ENTITY_CONFIDENCE_PATH = 'Sampling/_status/entity_confidence.json';
const SAMPLED_RUNS_PATH = 'Sampling/_status/sampled_runs.json';
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

type TabId = 'sampling' | 'dashboard' | 'entities' | 'completeness' | 'bybu' | 'bufiles' | 'reproduce';
type GenStatus = 'idle' | 'working' | 'done' | 'error';

interface FileEntry {
  id: string;
  fileName: string;
  entity: string;
  agency: string;
  tab?: string;   // validation-report tab (for confidence + sampled-run tracking)
  sampleBu?: string; // the BU this was loaded for (dashboard check-off); = agency except for HCM (agency is the source)
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
// Some entities are keyed only by a named source SYSTEM instead of a numeric BU
// (AR Customer's files are tagged SALUD / SIFDE with no BU of their own). Map the
// name to its BU so a per-BU run still finds them. Add new named sources here.
const SOURCE_BU_MAP: Record<string, string> = {
  SALUD: '071',
  SIFDE: '081',
};
// Does a file/plan row (source + BU value) belong to the requested BU? Direct match on
// either field; a named source system (SALUD -> 071) also resolves, but ONLY for a
// source-keyed row with no numeric BU of its own — so entities that merely use SALUD /
// SIFDE as a source system while carrying a real BU aren't mis-attached to 071 / 081.
function rowMatchesBU(source: string | undefined, buVal: string | undefined, bu: string): boolean {
  if (source === bu || buVal === bu) return true;
  if (!buVal && source && SOURCE_BU_MAP[source.trim().toUpperCase()] === bu) return true;
  return false;
}

function presentFor(mans: ManifestFileRow[], label: string, agency: string) {
  const hits = mans.filter(m => rowMatchesBU(m.source, m.bu, agency) && fileMatchesTable(label, m.table));
  return { present: hits.length > 0, rows: hits.reduce((s, r) => s + r.rows, 0), tables: Array.from(new Set(hits.map(h => h.table))) };
}

const normStr = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
// A readable, still-matchable label for an extra generated table (e.g.
// SCM_SUPPLIER_SITE_MOCK14_VW_TBL → "Supplier Site"). fileMatchesTable(label,table)
// stays true because the label is derived from the table's own tokens.
function tableLabel(t: string): string {
  const base = String(t || '').replace(/_MOCK\d+.*$/i, '').replace(/_VW.*$/i, '').replace(/^(SCM|FIN)_/i, '');
  return base.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') || String(t);
}
const labelTokens = (s: string) => String(s || '').split(/[^A-Za-z0-9]+/).filter(Boolean).map(x => x.toUpperCase().replace(/S$/, '')).filter(x => x.length > 1);
// Mock/suffix-insensitive table identity (config _VW_TBL vs generated _CONVERTED_VW).
const normTbl = (s: string) => String(s || '').toUpperCase().replace(/_MOCK\d+.*$/, '').replace(/[^A-Z0-9]/g, '');
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

// Plain-English text for why an expected file yielded nothing (for the tooltip).
const EMPTY_REASON_TEXT: Record<string, string> = {
  not_built: 'table not built in Hacienda_ERP yet',
  no_source_field: 'table has no matching source column',
  empty_table: 'table is empty (0 rows)',
  no_rows_for_bu: 'table has no rows for this BU',
};

// If an expected file isn't present, did a generation run process its table but
// find it empty (or not built)? Returns the reason, else null — so the UI can
// show a distinct "empty" state instead of a plain "missing". Matches the
// empties by table + the BU the run targeted (bu === '' = empty entity-wide).
function buFileEmptyReason(empties: EmptyRow[], entity: string, label: string, bu: string): string | null {
  const shared = isSharedEntity(entity);
  const hit = empties.find(m => fileMatchesTable(label, m.table) && (shared || m.bu === bu || m.bu === ''));
  return hit ? hit.reason : null;
}

// Match a validation-report entity (by tab) to its column in the agency report
// (REPORTE DE AGENCIAS), so a BU's attached entities / an entity's BUs can be read.
function agencyColumnForEntity(report: AgencyReport | null, valReport: ValidationReport | null, tab: string): string | null {
  if (!report) return null;
  const e = valReport?.entities.find(x => x.tab === tab);
  const raw = [tab, e?.entity, e?.files.find(f => f.role === 'master')?.label].filter(Boolean) as string[];
  const cands = raw.map(s => normStr(s));
  // Canonical entity names (synonym-aware) so a tab like "PS Items" still resolves
  // to the agency-report column "Peoplesoft Item" even though the names don't overlap.
  const canon = new Set(raw.map(s => matchEntity(s)).filter(Boolean));
  let best: string | null = null, bestScore = 0;
  for (const col of report.entities) {
    const nc = normStr(col);
    let score = 0;
    for (const c of cands) { if (!c) continue; if (nc === c) score = Math.max(score, 3); else if (nc.includes(c) || c.includes(nc)) score = Math.max(score, 2); }
    const cc = matchEntity(col);
    if (cc && canon.has(cc)) score = Math.max(score, 3);
    if (score > bestScore) { bestScore = score; best = col; }
  }
  return bestScore > 0 ? best : null;
}

// #9: HCM Person — one report entity backed by 8 SEPARATE conversion-plan
// entities (each its own Sampling/Generated folder), all linking on PERSON_NUMBER.
// `label` must tokenize into its table name (for presence + merge inclusion);
// `plan` is the conversion-plan entity name used for generation.
const HCM_PERSON_TAB = 'Person';
const HCM_PERSON_SUB: { label: string; plan: string; role: 'master' | 'child' }[] = [
  { label: 'Person', plan: 'Person', role: 'master' },
  { label: 'Person Address', plan: 'Person Address', role: 'child' },
  { label: 'Person Email', plan: 'Person Email', role: 'child' },
  { label: 'Person Name', plan: 'Person Name', role: 'child' },
  { label: 'Person NID', plan: 'Person National Identifier', role: 'child' },
  { label: 'Assignment', plan: 'Assignment', role: 'child' },
  { label: 'Supervisor', plan: 'Supervisor', role: 'child' },
  { label: 'External Bank Account', plan: 'External Bank Accounts', role: 'child' },
];
function hcmPersonEntity(): EntityValidation {
  return {
    tab: HCM_PERSON_TAB, entity: 'Person', key: 'PERSON_NUMBER', keyParts: ['PERSON_NUMBER'],
    howItLinks: 'Sub-entities link to the Person on PERSON_NUMBER.',
    agencies: [], notApplicable: [],
    files: HCM_PERSON_SUB.map(s => ({ label: s.label, role: s.role, counts: {} })),
    integrity: [], notes: ['HCM entity — added for sampling; not part of the validation report.'],
    verdict: '', status: 'STANDALONE',
  };
}
// The generated-folder names (safeName of each sub-entity's plan entity).
const HCM_PERSON_FOLDERS = new Set(HCM_PERSON_SUB.map(s => safeName(s.plan)));

// Entities present in the conversion plan but not in the validation report, wired
// into the report-driven views (Sample by BU / Run entity across BUs). Each is a
// standalone flat table (no child relationships). `plan` = conversion-plan entity
// name used for generation; `target` = its MOCK14 converted view (pinned so target
// resolution is exact); `masterLabel` tokenizes into `target` for presence + merge
// inclusion; `ledger` marks the FIN entities whose source value is a 7-digit ledger
// segment (0150000) whose first 3 digits are the BU. `allBUs` marks an entity the
// agency report doesn't track (Location) — it attaches to every BU and the run
// samples whichever have data.
// `fixedAgency` marks an entity keyed only by a source SYSTEM with no numeric BU
// (Customer and Sponsor lives entirely under PRIFAS): it attaches to that one agency
// and its single sample file is labelled by that name.
const EXTRA_ENTITIES: { tab: string; entity: string; plan: string; target: string; key: string; masterLabel: string; ledger?: boolean; allBUs?: boolean; fixedAgency?: string }[] = [
  { tab: 'GL Balance', entity: 'GL Balance', plan: 'GL Balances', target: 'FIN_GL_BALANCES_MOCK14_VW_TBL', key: 'Segment2 - Agency', masterLabel: 'GL Balances', ledger: true },
  { tab: 'GL Budget Balance', entity: 'GL Budget Balance', plan: 'GL Budget Balances', target: 'FIN_BUDGET_BALANCE_MOCK14_VW_TBL', key: 'Segment2 - Agency', masterLabel: 'Budget Balance', ledger: true },
  { tab: 'Location', entity: 'Location', plan: 'Finance Location', target: 'SCM_LOCATION_MOCK14_VW_CONVERTED', key: 'LOCATION_CODE', masterLabel: 'Location', allBUs: true },
  { tab: 'Customer and Sponsor', entity: 'Customer and Sponsor', plan: 'Customer and Sponsor', target: 'FIN_PRIFAS_CUSTOMER_MOCK14_VW_TBL', key: 'Primary Sponsor Name', masterLabel: 'Customer and Sponsor', fixedAgency: 'PRIFAS' },
];
const EXTRA_ENTITY_TABS = new Set(EXTRA_ENTITIES.map(x => x.tab));
const EXTRA_ENTITY_TARGET: Record<string, string> = Object.fromEntries(EXTRA_ENTITIES.map(x => [x.tab, x.target]));
const LEDGER_ENTITY_TABS = new Set(EXTRA_ENTITIES.filter(x => x.ledger).map(x => x.tab));
const EXTRA_ENTITY_ALLBUS = new Set(EXTRA_ENTITIES.filter(x => x.allBUs).map(x => x.tab));
const EXTRA_ENTITY_FIXED: Record<string, string> = Object.fromEntries(EXTRA_ENTITIES.filter(x => x.fixedAgency).map(x => [x.tab, x.fixedAgency as string]));
function extraEntity(x: { tab: string; entity: string; key: string; masterLabel: string }): EntityValidation {
  return {
    tab: x.tab, entity: x.entity, key: x.key, keyParts: [x.key],
    howItLinks: 'Standalone entity — sampled flat, one row per record.',
    agencies: [], notApplicable: [],
    files: [{ label: x.masterLabel, role: 'master', counts: {} }],
    integrity: [], notes: ['Added for sampling; not part of the validation report.'],
    verdict: '', status: 'STANDALONE',
  };
}
// Whether a generated file's source/BU value belongs to the requested BU. Exact
// match for normal entities; a named source system maps to its BU (SALUD -> 071);
// ledger entities also match a 3-digit BU against the agency prefix of a 7-digit
// segment value (0150000 -> 015, 0450121 -> 045).
function buMatchesGen(bu: string, source: string | undefined, buVal: string | undefined, ledger: boolean): boolean {
  if (rowMatchesBU(source, buVal, bu)) return true;
  if (ledger) {
    const want = bu.replace(/^0+/, '') || '0';
    for (const v of [source, buVal]) if (v && /^\d{7}$/.test(v) && ((v.slice(0, 3).replace(/^0+/, '')) || '0') === want) return true;
  }
  return false;
}

// Pool several generated files of one sub-entity (an agency's source-system
// segment splits of one flat table) into a single parent-only MergeResult: union
// the rows, aligning by column name so a variant with an extra column still fits.
function poolFlatResult(bu: string, label: string, key: string, files: TaggedFile[]): MergeResult {
  const headers: string[] = [];
  const at = new Map<string, number>();
  for (const f of files) for (const h of f.data.headers) {
    const k = String(h ?? ''); const lk = k.toLowerCase();
    if (!at.has(lk)) { at.set(lk, headers.length); headers.push(k); }
  }
  const rows: unknown[][] = [];
  for (const f of files) {
    const cols = f.data.headers.map(h => at.get(String(h ?? '').toLowerCase()) ?? -1);
    for (const r of f.data.rows) {
      const row: unknown[] = new Array(headers.length).fill(null);
      for (let i = 0; i < cols.length; i++) if (cols[i] >= 0) row[cols[i]] = r[i];
      rows.push(row);
    }
  }
  return {
    bu, entityToken: label, parentName: label, key,
    headers, rows, parentHeaders: headers,
    children: [], childrenData: [], integrity: [], warnings: [],
    recordCount: rows.length,
  };
}

// Resolve a report entity (by tab) to its sampling target (root table + children).
// Matches on the entity's master-file label first, then any file, then the target
// display name — so "Supplier" → SCM_SUPPLIER_MOCK14_VW_TBL, "Projects" → Awards.
function resolveEntityTarget(report: ValidationReport | null, targets: SamplingTarget[], tab: string): SamplingTarget | undefined {
  if (!targets.length) return undefined;
  // Injected standalone entities pin their target explicitly (loose name matching
  // is unreliable here — e.g. "Budget Balance" also matches the 911-only view).
  const pinned = EXTRA_ENTITY_TARGET[tab];
  if (pinned) { const t = targets.find(t => t.table === pinned); if (t) return t; }
  const e = report?.entities.find(x => x.tab === tab);
  const master = e?.files.find(f => f.role === 'master');
  // 1. master-file label -> target table (most specific: Suppliers, AP, BPA, Assets).
  const byMaster = master ? targets.find(t => fileMatchesTable(master.label, t.table)) : undefined;
  if (byMaster) return byMaster;
  // 2. entity name/tab exactly matches a target's display (module prefix stripped).
  //    Catches "Purchase Orders" -> SCM_PURCHASE_ORDERS even when the master file
  //    label ("PO FINAL") doesn't tokenize to the table name — must come before the
  //    loose any-file match, or a generic child ("LINES") mis-hits FIN_AR_INVOICES_LINES.
  const wants = [normStr(tab), normStr(e?.entity || '')].filter(Boolean);
  // Ignore the conversion-pipeline suffixes (_FINAL header view, _BY_BU split) so
  // "Purchase Orders" resolves to SCM_PURCHASE_ORDERS_FINAL (its real root table)
  // — the per-source 911/RETIRO roots keep their suffix and stay distinct.
  const disp = (t: SamplingTarget) => normStr(String(t.display || t.table)
    .replace(/^(SCM|FIN|HR|GL|AP|AR|PO)_/i, '').replace(/_FINAL(?=_|$)/i, '').replace(/_BY_BU/i, ''));
  const exact = targets.find(t => wants.includes(disp(t)));
  if (exact) return exact;
  // 3. any file label -> a target table (loose; e.g. Awards children for "Projects").
  const byAnyFile = e ? targets.find(t => e.files.some(f => fileMatchesTable(f.label, t.table))) : undefined;
  if (byAnyFile) return byAnyFile;
  // 4. last resort: longest substring overlap on the display name.
  let best: SamplingTarget | undefined, bestLen = 0;
  for (const t of targets) {
    const d = disp(t);
    for (const w of wants) if (w && d && (d.includes(w) || w.includes(d)) && w.length > bestLen) { bestLen = w.length; best = t; }
  }
  return best;
}

// Merge key overrides for the sampling merge: the report's composite keys plus any
// user-chosen link column (Goal 4), which wins for that entity's root table.
function buildKeyOverrides(
  composite: Map<string, string[]> | null,
  targets: SamplingTarget[],
  report: ValidationReport | null,
  linkKeys: Record<string, string>,
): Map<string, string[]> | undefined {
  const base = new Map<string, string[]>();
  composite?.forEach((v, k) => base.set(k, v));
  for (const tab of Object.keys(linkKeys || {})) {
    const key = linkKeys[tab];
    if (!key) continue;
    const tgt = resolveEntityTarget(report, targets, tab);
    if (tgt) base.set(normTbl(tgt.table), [key]);
  }
  return base.size ? base : undefined;
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
function titleCaseEntity(s: string): string {
  return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
// Client-facing parent-entity label for the sample filename: title-case, singular
// last word, short all-caps acronyms preserved. "SUPPLIERS" → "Supplier",
// "PURCHASE ORDERS" → "Purchase Order", "AP INVOICES" → "AP Invoice", "AR" → "AR".
function parentEntityLabel(entity: string): string {
  const words = String(entity || '').trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    let word = w;
    if (i === words.length - 1 && word.length > 2 && /s$/i.test(word)) word = word.replace(/s$/i, '');
    if (word.length <= 3 && word === word.toUpperCase()) return word; // keep AP / AR / GL / PO
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}
// Zero-pad a numeric BU code to 3 digits (015, 081); leave non-numeric codes as-is.
function bu3(code: string): string {
  const s = String(code || '');
  return /^\d+$/.test(s) ? s.padStart(3, '0') : s;
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

  // ── Reproduce-by-seed state ──
  const repInputRef = useRef<HTMLInputElement>(null);
  const [isRepDragOver, setIsRepDragOver] = useState(false);
  const [repFile, setRepFile] = useState<{ name: string; parsed: PriorSample } | null>(null);
  const [repEntity, setRepEntity] = useState('');
  const [repAgency, setRepAgency] = useState('');
  const [repN, setRepN] = useState('');
  const [repn, setRepn] = useState('');
  const [repSeed, setRepSeed] = useState('');
  const [repResult, setRepResult] = useState<{ indices: number[]; checked: boolean; matched: number; total: number; identical: boolean } | null>(null);
  const [repError, setRepError] = useState('');
  // Manual reproduce (seed only, no file): compute the sampled row positions.
  const [manN, setManN] = useState('');
  const [mann, setMann] = useState('');
  const [manSeed, setManSeed] = useState('');
  const [manIndices, setManIndices] = useState<number[] | null>(null);
  const [manError, setManError] = useState('');

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

  // ── Merge raw parent + child files → master, added straight to the sampling list ──
  // Add one sampling entry per merged master.
  const addMergeResults = useCallback((results: MergeResult[], tab?: string, sampleBu?: string) => {
    results.forEach((result, i) => {
      const id = `m-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      setEntries(prev => [...prev, {
        id,
        fileName: `Consolidated_${result.entityToken}_${result.bu || 'NA'}`,
        entity: matchEntity(result.entityToken) || '',
        agency: result.bu,
        tab,
        sampleBu: sampleBu ?? result.bu, // dashboard tracks the loading BU; for HCM that differs from agency (source)
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


  // ── Bridge: load server-generated CV_ files straight from S3 into the list ──
  const [genList, setGenList] = useState<GeneratedEntity[] | null>(null);
  const [genListError, setGenListError] = useState('');
  const [genNote, setGenNote] = useState('');
  const [showFlags, setShowFlags] = useState(false);
  const samplingTargetsRef = useRef<SamplingTarget[] | null>(null);
  const relationshipEdgesRef = useRef<RelEdge[] | null>(null);
  const compositeOverridesRef = useRef<Map<string, string[]> | null>(null);
  const valReportRef = useRef<ValidationReport | null>(null);
  const valManifestsRef = useRef<ManifestFileRow[] | null>(null);
  const valEmptiesRef = useRef<EmptyRow[] | null>(null);

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
    setGenListError('');
    try {
      const items = await listGeneratedEntities(PLAN_MOCK);
      setGenList(items);
      return items;
    } catch (e) {
      setGenListError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, [PLAN_MOCK]);

  const loadFromGenerated = useCallback(async (g: GeneratedEntity) => {
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
      const tagged = await loadGeneratedTagged(g, manifest);

      const label = g.entity.replace(/_/g, ' ');
      const targets = samplingTargetsRef.current || [];
      const edges = relationshipEdgesRef.current || [];
      const overrides = buildKeyOverrides(compositeOverridesRef.current, samplingTargetsRef.current || [], valReportRef.current, linkKeysRef.current);
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
  const [valEmpties, setValEmpties] = useState<EmptyRow[]>([]);
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

  // Editable BU → entity → included master/child files, seeded from the report's
  // Present-in-agencies (all files) and persisted to S3. (Older saves used
  // BU → string[] of entity names; migrated to the per-file form on load.)
  const [buAssignments, setBuAssignments] = useState<Record<string, Record<string, string[]>>>({});
  const [buAssignSaving, setBuAssignSaving] = useState(false);
  const [buAssignSavedAt, setBuAssignSavedAt] = useState('');

  // Goal 4: per-entity parent→child linking column (the shared Unique ID). Keyed
  // by report tab; overrides the config link field when the merge runs.
  const [linkKeys, setLinkKeys] = useState<Record<string, string>>({});
  const linkKeysRef = useRef<Record<string, string>>({});
  // Column lists per table (from sql_table_columns), cached for the link picker.
  const [tableCols, setTableCols] = useState<Record<string, string[]>>({});
  const tableColsRef = useRef<Record<string, string[]>>({});
  const [colsLoading, setColsLoading] = useState<Record<string, boolean>>({});

  const loadBuAssignments = useCallback(async (report: ValidationReport) => {
    let saved: Record<string, unknown> = {};
    try {
      const { url } = await getUrl({ path: BU_ASSIGN_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (resp.ok) saved = await resp.json();
    } catch { /* not saved yet */ }
    const defFiles = (tab: string) => { const e = report.entities.find(x => x.tab === tab); return e ? e.files.map(f => f.label) : []; };
    const norm = (val: unknown): Record<string, string[]> => {
      if (Array.isArray(val)) { const o: Record<string, string[]> = {}; (val as string[]).forEach(tab => { o[tab] = defFiles(tab); }); return o; }
      return (val && typeof val === 'object') ? (val as Record<string, string[]>) : {};
    };
    const seed = (bu: string): Record<string, string[]> =>
      Object.fromEntries(report.entities.filter(e => e.agencies.includes(bu)).map(e => [e.tab, defFiles(e.tab)]));
    const merged: Record<string, Record<string, string[]>> = {};
    for (const bu of report.agencies) merged[bu] = (bu in saved) ? norm(saved[bu]) : seed(bu);
    for (const bu of Object.keys(saved)) if (!(bu in merged)) merged[bu] = norm(saved[bu]);
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

  // #6: set a BU's assignments to `next` and persist immediately (inline editing
  // on Sample by BU auto-saves, so there is no separate Save button there).
  const persistAssign = useCallback(async (next: Record<string, Record<string, string[]>>) => {
    setBuAssignments(next);
    try { await uploadData({ path: BU_ASSIGN_PATH, data: new Blob([JSON.stringify(next)], { type: 'application/json' }), options: { contentType: 'application/json' } }).result; }
    catch (e) { console.error('persist bu assignments failed', e); }
  }, []);

  // #6: the full SQL table list (~2200), fetched once, for the searchable "add a
  // table" picker — there are far too many for a dropdown, so the user searches.
  const [sqlTables, setSqlTables] = useState<string[]>([]);
  const sqlTablesRef = useRef<string[]>([]);
  const [sqlTablesLoading, setSqlTablesLoading] = useState(false);
  const loadSqlTables = useCallback(async () => {
    if (sqlTablesRef.current.length || sqlTablesLoading) return;
    setSqlTablesLoading(true);
    try {
      const r = await (await fetch(`${LAMBDA_URL}?action=list_sql_tables&db=Hacienda_ERP`)).json();
      const t: string[] = Array.isArray(r.tables) ? r.tables : [];
      setSqlTables(t); sqlTablesRef.current = t;
    } catch (e) { console.error('load sql tables failed', e); }
    finally { setSqlTablesLoading(false); }
  }, [sqlTablesLoading]);
  const [sbuEditTab, setSbuEditTab] = useState('');   // Sample by BU: entity whose file editor is open
  const [tableQuery, setTableQuery] = useState('');   // the "add a table" search text

  const loadLinkKeys = useCallback(async () => {
    try {
      const { url } = await getUrl({ path: LINK_KEYS_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (resp.ok) { const j = await resp.json(); if (j && typeof j === 'object') { setLinkKeys(j as Record<string, string>); linkKeysRef.current = j as Record<string, string>; } }
    } catch { /* not saved yet */ }
  }, []);

  const saveLinkKeys = useCallback(async (next: Record<string, string>) => {
    setLinkKeys(next);
    linkKeysRef.current = next;
    try {
      await uploadData({ path: LINK_KEYS_PATH, data: new Blob([JSON.stringify(next)], { type: 'application/json' }), options: { contentType: 'application/json' } }).result;
    } catch (e) { console.error('save link keys failed', e); }
  }, []);

  // #5: per-BU, per-entity confidence override (tier name). bu -> tab -> tierName.
  const [entityConfidence, setEntityConfidence] = useState<Record<string, Record<string, string>>>({});
  const entityConfidenceRef = useRef<Record<string, Record<string, string>>>({});
  const loadEntityConfidence = useCallback(async () => {
    try {
      const { url } = await getUrl({ path: ENTITY_CONFIDENCE_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (resp.ok) { const j = await resp.json(); if (j && typeof j === 'object') { setEntityConfidence(j); entityConfidenceRef.current = j; } }
    } catch { /* not saved yet */ }
  }, []);
  const saveEntityConfidence = useCallback(async (next: Record<string, Record<string, string>>) => {
    setEntityConfidence(next); entityConfidenceRef.current = next;
    try { await uploadData({ path: ENTITY_CONFIDENCE_PATH, data: new Blob([JSON.stringify(next)], { type: 'application/json' }), options: { contentType: 'application/json' } }).result; }
    catch (e) { console.error('save confidence failed', e); }
  }, []);
  // Resolve the tier for a BU+entity: the override if set, else the entity default.
  const confidenceTierFor = useCallback((bu: string, tab: string | undefined, entity: string): Tier | undefined => {
    const name = (tab && entityConfidenceRef.current[bu]?.[tab]) || '';
    return (name && TIERS[name]) || tierForEntity(entity) || undefined;
  }, []);

  // #6: which (BU, entity tab) have been sampled. bu -> [tab, ...]. Persisted.
  const [sampledRuns, setSampledRuns] = useState<Record<string, string[]>>({});
  const sampledRunsRef = useRef<Record<string, string[]>>({});
  const loadSampledRuns = useCallback(async () => {
    try {
      const { url } = await getUrl({ path: SAMPLED_RUNS_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (resp.ok) { const j = await resp.json(); if (j && typeof j === 'object') { setSampledRuns(j); sampledRunsRef.current = j; } }
    } catch { /* not saved yet */ }
  }, []);
  const recordSampled = useCallback(async (bu: string, tab: string) => {
    if (!bu || !tab) return;
    const cur = sampledRunsRef.current;
    const list = cur[bu] || [];
    if (list.includes(tab)) return;
    const next = { ...cur, [bu]: [...list, tab] };
    setSampledRuns(next); sampledRunsRef.current = next;
    try { await uploadData({ path: SAMPLED_RUNS_PATH, data: new Blob([JSON.stringify(next)], { type: 'application/json' }), options: { contentType: 'application/json' } }).result; }
    catch (e) { console.error('save sampled runs failed', e); }
  }, []);

  // Fetch (and cache) a table's column names from SQL for the link picker.
  const fetchTableColumns = useCallback(async (table: string) => {
    if (!table || tableColsRef.current[table]) return;
    setColsLoading(p => ({ ...p, [table]: true }));
    try {
      const r = await (await fetch(`${LAMBDA_URL}?action=sql_table_columns&table=${encodeURIComponent(table)}&db=Hacienda_ERP`)).json();
      const cols: string[] = r.ok ? (r.columns || []).map((c: { name?: string }) => c.name || '').filter(Boolean) : [];
      tableColsRef.current = { ...tableColsRef.current, [table]: cols };
      setTableCols(c => ({ ...c, [table]: cols }));
    } catch { tableColsRef.current = { ...tableColsRef.current, [table]: [] }; setTableCols(c => ({ ...c, [table]: [] })); }
    finally { setColsLoading(p => ({ ...p, [table]: false })); }
  }, []);

  const reportFilesFor = useCallback((tab: string): string[] => {
    const e = valReport?.entities.find(x => x.tab === tab);
    return e ? e.files.map(f => f.label) : [];
  }, [valReport]);
  const includedFilesFor = useCallback((bu: string, tab: string): string[] =>
    buAssignments[bu]?.[tab] ?? reportFilesFor(tab), [buAssignments, reportFilesFor]);
  const assignedEntitiesFor = useCallback((bu: string): string[] => {
    // #9: HCM Person applies to every BU but isn't in the agency report, so
    // always surface it alongside whatever the report/assignments provide.
    // Always surface entities that aren't in the agency-report assignment: HCM
    // Person (every BU) and the injected standalone entities (where the agency
    // report shows them) — so they appear even for the report's 4 assigned agencies.
    const withInjected = (tabs: string[]) => {
      const out = [...tabs];
      const add = (tab: string) => { if (valReport?.entities.some(e => e.tab === tab) && !out.includes(tab)) out.push(tab); };
      add(HCM_PERSON_TAB); // #9: HCM Person applies to every BU
      EXTRA_ENTITY_ALLBUS.forEach(tab => add(tab)); // untracked injected entities (Location) apply to every BU
      EXTRA_ENTITIES.forEach(x => { if (x.fixedAgency && x.fixedAgency === bu) add(x.tab); }); // fixed single-agency entities (Customer and Sponsor -> PRIFAS)
      const r = report?.bus.find(b => b.unit === bu);
      if (r) for (const x of EXTRA_ENTITIES) {
        if (EXTRA_ENTITY_ALLBUS.has(x.tab) || x.fixedAgency) continue; // already handled above
        const col = agencyColumnForEntity(report, valReport, x.tab);
        if (col && r.statuses[col] != null && String(r.statuses[col]).trim() !== '') add(x.tab);
      }
      return out;
    };
    const assigned = Object.keys(buAssignments[bu] || {});
    if (assigned.length) return withInjected(assigned);
    // Fallback for BUs beyond the validation report's 4 agencies (the agency
    // report lists 58): the entities attached to this BU in the agency report,
    // mapped to the validation report's entity tabs (files come from that spec).
    if (!report || !valReport) return withInjected([]);
    const row = report.bus.find(b => b.unit === bu);
    if (!row) return withInjected([]);
    return withInjected(valReport.entities
      .filter(e => { const col = agencyColumnForEntity(report, valReport, e.tab); return !!col && row.statuses[col] != null && String(row.statuses[col]).trim() !== ''; })
      .map(e => e.tab));
  }, [buAssignments, report, valReport]);

  const applyReport = useCallback((report: ValidationReport, manifests: ManifestFileRow[], empties: EmptyRow[]) => {
    // #9: HCM Person isn't in the validation report — inject it so it appears in
    // the report-driven views (Sample by BU, Completeness, BU Dashboard).
    if (!report.entities.some(e => e.tab === HCM_PERSON_TAB)) {
      report = { ...report, entities: [...report.entities, hcmPersonEntity()] };
    }
    // Standalone entities in the conversion plan but not the validation report
    // (GL Balance, GL Budget Balance, Location) — inject so they're selectable and
    // attach per the agency report.
    const addEntities = EXTRA_ENTITIES.filter(x => !report.entities.some(e => e.tab === x.tab)).map(extraEntity);
    if (addEntities.length) report = { ...report, entities: [...report.entities, ...addEntities] };
    setValReport(report); valReportRef.current = report;
    setValManifests(manifests); valManifestsRef.current = manifests;
    setValEmpties(empties); valEmptiesRef.current = empties;
    compositeOverridesRef.current = buildCompositeKeyOverrides(report, samplingTargetsRef.current || []);
    loadReadiness(report);
    loadBuAssignments(report);
    loadLinkKeys();
    loadEntityConfidence();
    loadSampledRuns();
  }, [loadReadiness, loadBuAssignments, loadLinkKeys, loadEntityConfidence, loadSampledRuns]);

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
      const md = await readAllManifests(PLAN_MOCK).catch(() => ({ files: [] as ManifestFileRow[], empties: [] as EmptyRow[] }));
      const { url } = await getUrl({ path: VALIDATION_REPORT_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error('fetch failed');
      applyReport(parseValidationReport(await resp.arrayBuffer()), md.files, md.empties);
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
      const md = await readAllManifests(PLAN_MOCK).catch(() => ({ files: [] as ManifestFileRow[], empties: [] as EmptyRow[] }));
      applyReport(parseValidationReport(buf), md.files, md.empties);
    } catch (e) {
      setValError(e instanceof Error ? e.message : String(e));
    } finally {
      setValLoading(false); setValLoaded(true);
    }
  }, [applyReport, ensureTargets, PLAN_MOCK]);

  useEffect(() => {
    if ((activeTab === 'sampling' || activeTab === 'dashboard' || activeTab === 'completeness' || activeTab === 'bybu' || activeTab === 'bufiles') && !valLoaded) loadValReport();
  }, [activeTab, valLoaded, loadValReport]);
  // Sampling (entity-run preview) + BU Files + Sample by BU need the conversion
  // plan (entity names, tables) for the report-tab → plan-entity mapping.
  useEffect(() => {
    if ((activeTab === 'sampling' || activeTab === 'bufiles' || activeTab === 'bybu') && !planLoaded && !planLoading) loadPlan();
  }, [activeTab, planLoaded, planLoading, loadPlan]);

  // Map each report entity → the conversion-plan entity name that generates it
  // (by best overlap of the report's file labels with the plan's conversion tables;
  // so report "Contracts" → plan "Blanket Purchase Agreements", "Projects" → "Awards").
  const reportToPlanEntity = React.useMemo(() => {
    const map = new Map<string, string>();
    if (!valReport) return map;
    map.set(HCM_PERSON_TAB, 'Person'); // #9: pin HCM Person to its parent plan entity (many Person* groups would tie)
    for (const x of EXTRA_ENTITIES) map.set(x.tab, x.plan); // injected entities pin their conversion-plan name
    for (const e of valReport.entities) {
      if (e.tab === HCM_PERSON_TAB || EXTRA_ENTITY_TABS.has(e.tab)) continue;
      let best = '', bestScore = 0;
      for (const g of entityGroups) {
        const tables = g.files.map(f => f.CONVERSION_TABLE_BU);
        let score = e.files.reduce((s, f) => s + (tables.some(t => fileMatchesTable(f.label, t)) ? 1 : 0), 0);
        if (normStr(g.entity).includes(normStr(e.tab)) || normStr(e.tab).includes(normStr(g.entity))) score += 0.5;
        if (score > bestScore) { bestScore = score; best = g.entity; }
      }
      if (best && bestScore > 0) map.set(e.tab, best); // accept the best positive match (name-only ok, e.g. Customer)
    }
    return map;
  }, [valReport, entityGroups]);

  // Files that can be assigned to an entity: the report's master/child files, plus
  // any EXTRA tables that entity actually generated (e.g. Supplier Site) that aren't
  // already one of the report files. `gen: true` marks the extras.
  const entityFileOptions = useCallback((tab: string): { label: string; gen: boolean }[] => {
    const e = valReport?.entities.find(x => x.tab === tab);
    const reportLabels = e ? e.files.map(f => f.label) : [];
    const out = reportLabels.map(label => ({ label, gen: false }));
    const plan = reportToPlanEntity.get(tab);
    if (plan) {
      const folder = safeName(plan);
      const tables = Array.from(new Set((valManifests || []).filter(m => m.entity === folder).map(m => m.table).filter(Boolean)));
      for (const t of tables) {
        if (reportLabels.some(l => fileMatchesTable(l, t))) continue; // already a report file
        const label = tableLabel(t);
        if (!out.some(o => normStr(o.label) === normStr(label))) out.push({ label, gen: true });
      }
    }
    return out;
  }, [valReport, valManifests, reportToPlanEntity]);

  // Goal 3/4: resolve an entity to its real sampling target (root table + children).
  const entityTarget = useCallback((tab: string) => resolveEntityTarget(valReport, samplingTargetsRef.current || [], tab), [valReport]);

  // Kick off column loads (parent + children) for the link picker.
  const ensureEntityColumns = useCallback((tab: string) => {
    const tgt = entityTarget(tab);
    if (!tgt) return;
    fetchTableColumns(tgt.table);
    tgt.children.forEach(c => fetchTableColumns(c.table));
  }, [entityTarget, fetchTableColumns]);

  // Columns the parent shares with at least one child (candidate linking keys). If
  // columns haven't loaded yet, offer the parent's columns so the picker isn't empty.
  const entityLinkOptions = useCallback((tab: string): string[] => {
    const tgt = entityTarget(tab);
    if (!tgt) return [];
    const pcols = tableCols[tgt.table] || [];
    const childCols = new Set<string>();
    tgt.children.forEach(c => (tableCols[c.table] || []).forEach(col => childCols.add(col.toLowerCase())));
    const shared = childCols.size ? pcols.filter(col => childCols.has(col.toLowerCase())) : [];
    return shared.length ? shared : pcols;
  }, [entityTarget, tableCols]);

  // The effective linking column for an entity: the user's choice, else the config
  // link field (modal across children), else the report's composite-key first part.
  const effectiveLinkKey = useCallback((tab: string): string => {
    if (linkKeys[tab]) return linkKeys[tab];
    const tgt = entityTarget(tab);
    if (tgt?.children.length) {
      const counts = new Map<string, number>();
      tgt.children.forEach(c => { if (c.link_field) counts.set(c.link_field, (counts.get(c.link_field) || 0) + 1); });
      let best = '', n = 0;
      counts.forEach((v, k) => { if (v > n) { n = v; best = k; } });
      if (best) return best;
    }
    return '';
  }, [linkKeys, entityTarget]);

  // Goal 3: resolve a file label to its real source table name (for display).
  // Among the tables whose name contains all of the label's tokens, pick the
  // tightest (fewest extra tokens) so "LINES" prefers ..._LINES over
  // ..._LINE_LOCATIONS; an exact label match wins outright.
  const bestTableForLabel = useCallback((label: string, tables: string[]): string => {
    const lt = labelTokens(label);
    const exact = tables.find(t => normStr(tableLabel(t)) === normStr(label));
    if (exact) return exact;
    if (!lt.length) return '';
    let best = '', bestExtra = Infinity;
    for (const t of tables) {
      const ct = labelTokens(tableLabel(t));
      if (!lt.every(tok => ct.includes(tok))) continue;
      const extra = ct.length - lt.length;
      if (extra < bestExtra) { bestExtra = extra; best = t; }
    }
    return best;
  }, []);

  const fileTableName = useCallback((tab: string, label: string): string => {
    const tgt = entityTarget(tab);
    const ent = valReport?.entities.find(x => x.tab === tab);
    const masterLbl = ent?.files.find(f => f.role === 'master')?.label;
    if (tgt && masterLbl && normStr(masterLbl) === normStr(label)) return tgt.table;
    const fromChildren = bestTableForLabel(label, (tgt?.children || []).map(c => c.table));
    if (fromChildren) return fromChildren;
    const plan = reportToPlanEntity.get(tab);
    if (plan) {
      const folder = safeName(plan);
      const manTables = (valManifests || []).filter(mm => mm.entity === folder).map(mm => mm.table).filter(Boolean);
      const fromMan = bestTableForLabel(label, manTables);
      if (fromMan) return fromMan;
    }
    return '';
  }, [entityTarget, valReport, reportToPlanEntity, valManifests, bestTableForLabel]);

  // ── Sample by BU ──
  const [selectedBU, setSelectedBU] = useState('');
  const [sampleEntitySel, setSampleEntitySel] = useState(''); // '' = all entities
  const [buLoading, setBuLoading] = useState(false);
  useEffect(() => {
    if (valReport && !selectedBU && valReport.agencies.length) setSelectedBU(valReport.agencies[0]);
  }, [valReport, selectedBU]);

  // Every BU we can sample: the agency report's 58 BUs, plus the validation
  // report's agencies and any manually-assigned BUs. Sorted, deduped.
  const sampleBUOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (b: string) => { const v = String(b || '').trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } };
    (report?.bus || []).forEach(b => add(b.unit));
    (valReport?.agencies || []).forEach(add);
    Object.keys(buAssignments).forEach(add);
    return out.sort();
  }, [report, valReport, buAssignments]);

  // ── BU Files editor state ──
  const [buFilesSel, setBuFilesSel] = useState('');
  const [newBuInput, setNewBuInput] = useState('');
  const [addEntSel, setAddEntSel] = useState('');
  const [buFilesExpanded, setBuFilesExpanded] = useState<Record<string, boolean>>({});
  const [addFileInput, setAddFileInput] = useState<Record<string, string>>({});
  useEffect(() => {
    if (sampleBUOptions.length && (!buFilesSel || !sampleBUOptions.includes(buFilesSel))) {
      setBuFilesSel(Object.keys(buAssignments).sort()[0] || sampleBUOptions[0]);
    }
  }, [sampleBUOptions, buFilesSel, buAssignments]);

  // Entities available to assign: report entities (by tab) + conversion-plan entities.
  const availableEntityNames = React.useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    const add = (name: string) => { const k = normStr(name); if (name && !seen.has(k)) { seen.add(k); out.push(name); } };
    (valReport?.entities || []).forEach(e => add(e.tab));
    entityGroups.forEach(g => add(g.entity));
    return out.sort((a, b) => a.localeCompare(b));
  }, [valReport, entityGroups]);

  // Keep only the tagged files the BU includes for this entity. Master = the
  // root/target table (kept if the master label is included); each child = its
  // most-specific report label (or the derived label for an extra generated table).
  // So unchecking "Contacts" drops the contacts file without the master label
  // over-matching every child.
  const filterIncludedFiles = useCallback((bu: string, e: EntityValidation, tagged: TaggedFile[]): TaggedFile[] => {
    const included = includedFilesFor(bu, e.tab);
    const rootSet = new Set((samplingTargetsRef.current || []).map(t => normTbl(t.table)));
    const masterIncluded = e.files.some(f => f.role === 'master' && included.includes(f.label));
    const childFiles = e.files.filter(f => f.role !== 'master');
    return tagged.filter(t => {
      if (!t.table) return true;
      const nt = normStr(t.table);
      if (rootSet.has(normTbl(t.table))) return masterIncluded;
      let best = '', bestTok = 0;
      for (const f of childFiles) {
        const toks = labelTokens(f.label);
        if (toks.length && toks.every(tk => nt.includes(tk)) && toks.length > bestTok) { best = f.label; bestTok = toks.length; }
      }
      const label = best || tableLabel(t.table);
      return included.some(lbl => normStr(lbl) === normStr(label));
    });
  }, [includedFilesFor]);

  // An injected entity's sub-entities from the live plan, each with the converted
  // tables it covers — only rows flagged "On Conversion Plan" = Y (so a table
  // flipped to Y later is picked up on its own). Files are grouped by sub-entity
  // so each becomes its own pooled, sampled sheet.
  const injectedSubEntities = useCallback((planEntity: string): { label: string; tables: Set<string> }[] => {
    const g = entityGroups.find(x => x.entity === planEntity);
    if (!g) return [];
    // Finance Location was added by request while its plan rows are still flagged N,
    // so it's exempt from the On-Conversion-Plan gate (the others honour the flag).
    const requireY = planEntity.trim().toLowerCase() !== 'finance location';
    const bySub = new Map<string, Set<string>>();
    for (const f of g.files) {
      if (requireY && String(f['On Conversion Plan'] || '').trim().toUpperCase() !== 'Y') continue;
      const t = normTbl(f.CONVERSION_TABLE_BU || '');
      if (!t) continue;
      const sub = (f.SubEntity || '').trim() || planEntity;
      if (!bySub.has(sub)) bySub.set(sub, new Set());
      bySub.get(sub)!.add(t);
    }
    return Array.from(bySub.entries()).map(([label, tables]) => ({ label, tables }));
  }, [entityGroups]);

  // Load the BU's entities (all, or just onlyEntity) into the sampling list —
  // filtered to the BU and to the files that BU includes for each entity.
  // Build (but don't add) the merge results for a BU's entities — the merge core,
  // reused by loading into the list and by the entity-wide batch run.
  const buildBUResults = useCallback(async (bu: string, onlyEntity?: string): Promise<{ e: EntityValidation; results: MergeResult[] }[]> => {
    if (!valReport) return [];
    await ensureTargets();
    if (!relationshipEdgesRef.current) {
      try { relationshipEdgesRef.current = await fetchSamplingRelationships(LAMBDA_URL); } catch { relationshipEdgesRef.current = []; }
    }
    const items = await refreshGenerated(); // fresh, so files generated this run are seen
    const targets = samplingTargetsRef.current || [];
    const edges = relationshipEdgesRef.current || [];
    const overrides = buildKeyOverrides(compositeOverridesRef.current, samplingTargetsRef.current || [], valReportRef.current, linkKeysRef.current);
    const entTabs = assignedEntitiesFor(bu).filter(t => !onlyEntity || t === onlyEntity);
    const applicable = valReport.entities.filter(e => entTabs.includes(e.tab));
    const out: { e: EntityValidation; results: MergeResult[] }[] = [];
    for (const e of applicable) {
      if (e.tab === HCM_PERSON_TAB) {
        // #9: Person's files live across 8 conversion-plan folders — gather every
        // one generated for this BU and merge via the target graph (Part 1 config).
        let tagged: TaggedFile[] = [];
        for (const g of items.filter(x => HCM_PERSON_FOLDERS.has(x.entity))) {
          const manifest = await readEntityManifests(PLAN_MOCK, g.entity);
          // HCM tables exist in two mocks (MOCK04HCM + MOCK14) that normalize to
          // the same identity — keep only the current mock so records aren't doubled.
          const buFiles = g.files.filter(fn => { const m = manifest.get(fn); return m && m.table.toUpperCase().includes(PLAN_MOCK) && (m.source === bu || m.bu === bu); });
          if (!buFiles.length) continue;
          tagged = tagged.concat(await loadGeneratedTagged({ ...g, files: buFiles }, manifest));
        }
        const forBU = filterIncludedFiles(bu, e, tagged.filter(t => t.source === bu || t.bu === bu));
        // Pool the agency's files across its HR source systems (RHUM/DOE/KRONOSPOL/
        // FIMAS) by table, tagged with the BU as the source. The merge groups by
        // source and labels the result with it, so this yields ONE result sampled
        // from the agency's full population and named by the BU — instead of one
        // mislabeled "Person BU RHUM" file per source system.
        const byTbl = new Map<string, TaggedFile[]>();
        for (const t of forBU) { const k = normTbl(t.table || t.name); const a = byTbl.get(k); if (a) a.push(t); else byTbl.set(k, [t]); }
        const pooled: TaggedFile[] = [];
        byTbl.forEach(grp => {
          const first = grp[0];
          pooled.push({ name: first.name, table: first.table, source: bu, bu, data: { headers: first.data.headers, rows: grp.length === 1 ? first.data.rows : grp.flatMap(x => x.data.rows), sheetName: first.data.sheetName } });
        });
        if (pooled.length) out.push({ e, results: edges.length ? mergeHierarchy(pooled, targets, edges, overrides) : mergeByRelationships(pooled, targets, overrides) });
        continue;
      }
      if (EXTRA_ENTITY_TABS.has(e.tab)) {
        // Injected flat entities: pool each Y sub-entity's source-system segments for
        // this agency into one population, so the agency yields one sampled sheet per
        // sub-entity (not one per 7-digit ledger segment).
        const plan = reportToPlanEntity.get(e.tab);
        const subs = plan ? injectedSubEntities(plan) : [];
        if (!subs.length) continue; // nothing flagged On Conversion Plan = Y (e.g. Location until they flip it)
        const g = items.find(x => matchReportEntity(valReport, x.entity)?.tab === e.tab);
        if (!g) continue;
        const manifest = await readEntityManifests(PLAN_MOCK, g.entity);
        const ledger = LEDGER_ENTITY_TABS.has(e.tab);
        const buFiles = g.files.filter(fn => { const m = manifest.get(fn); return m && buMatchesGen(bu, m.source, m.bu, ledger); });
        if (!buFiles.length) continue;
        const tagged = await loadGeneratedTagged({ ...g, files: buFiles }, manifest);
        const results: MergeResult[] = [];
        for (const sub of subs) {
          const subFiles = tagged.filter(t => sub.tables.has(normTbl(t.table || '')));
          if (subFiles.length) results.push(poolFlatResult(bu, sub.label, e.key, subFiles));
        }
        if (results.length) out.push({ e, results });
        continue;
      }
      const included = includedFilesFor(bu, e.tab);
      const ready = e.files.filter(f => included.includes(f.label)).every(f => {
        const c = f.counts[bu]; if (!c || c === 'N/A') return true;
        return buFilePresent(valManifestsRef.current || [], e.entity, f.label, bu).present;
      });
      if (!ready) continue;
      // Find the generated folder by the plan entity that produced it (the same
      // mapping used to generate), so a tab whose name doesn't overlap its folder
      // still resolves — e.g. "Contracts" → Blanket_Purchase_Agreements. Fall back
      // to the folder→tab name match for anything not in the plan map.
      const planFolder = reportToPlanEntity.get(e.tab);
      const g = (planFolder && items.find(x => x.entity === safeName(planFolder)))
        || items.find(x => matchReportEntity(valReport, x.entity)?.tab === e.tab);
      if (!g) continue;
      const manifest = await readEntityManifests(PLAN_MOCK, g.entity);
      // Only download this BU's files (agency-coded source/bu), not the whole
      // entity folder. Fall back to all files for a no-agency PRIFAS entity.
      // Ledger entities carry a 7-digit segment source (0150000) whose agency
      // prefix is the BU — match on that.
      const ledger = LEDGER_ENTITY_TABS.has(e.tab);
      const buFiles = g.files.filter(fn => { const m = manifest.get(fn); return m && buMatchesGen(bu, m.source, m.bu, ledger); });
      const downloadG = buFiles.length ? { ...g, files: buFiles } : (isSharedEntity(e.entity) ? g : { ...g, files: [] });
      if (!downloadG.files.length) continue;
      const tagged = await loadGeneratedTagged(downloadG, manifest);
      let forBU = tagged.filter(t => buMatchesGen(bu, t.source, t.bu, ledger));
      if (!forBU.length && isSharedEntity(e.entity)) forBU = tagged;
      forBU = filterIncludedFiles(bu, e, forBU);
      if (!forBU.length) continue;
      const results = edges.length ? mergeHierarchy(forBU, targets, edges, overrides) : mergeByRelationships(forBU, targets, overrides);
      out.push({ e, results });
    }
    return out;
  }, [valReport, ensureTargets, refreshGenerated, assignedEntitiesFor, includedFilesFor, filterIncludedFiles, reportToPlanEntity, injectedSubEntities]);

  const loadBUIntoSampling = useCallback(async (bu: string, onlyEntity?: string) => {
    if (!valReport) return;
    setBuLoading(true);
    try {
      const built = await buildBUResults(bu, onlyEntity);
      let loadedEntities = 0, masters = 0;
      for (const { e, results } of built) { addMergeResults(results, e.tab, bu); loadedEntities++; masters += results.length; }
      setActiveTab('sampling');
      setGenNote(`BU ${bu}${onlyEntity ? ' · ' + onlyEntity : ''}: loaded ${loadedEntities} entit${loadedEntities !== 1 ? 'ies' : 'y'} → ${masters} master${masters !== 1 ? 's' : ''} into the sampling list.`);
    } catch (e) {
      console.error('load-bu failed', e);
    } finally {
      setBuLoading(false);
    }
  }, [valReport, buildBUResults, addMergeResults]);

  // Generate only the files a BU needs (per-BU, small/fast), for the assigned
  // entities (all, or just onlyEntity) whose included files aren't present yet.
  const [buPrep, setBuPrep] = useState<{ running: boolean; done: number; total: number; current: string }>({ running: false, done: 0, total: 0, current: '' });
  const buEntitiesToGenerate = useCallback((bu: string, onlyEntity?: string) => {
    if (!valReport) return [] as { tab: string; plan: string }[];
    const mans = valManifestsRef.current || [];
    const entTabs = assignedEntitiesFor(bu).filter(t => !onlyEntity || t === onlyEntity);
    const out: { tab: string; plan: string }[] = [];
    for (const e of valReport.entities.filter(x => entTabs.includes(x.tab))) {
      if (e.tab === HCM_PERSON_TAB) {
        // #9: Person spans 8 conversion-plan entities — generate each included
        // sub-entity whose file isn't present yet for this BU.
        const included = includedFilesFor(bu, e.tab);
        for (const s of HCM_PERSON_SUB) {
          if (included.includes(s.label) && !buFilePresent(mans, e.entity, s.label, bu).present) out.push({ tab: e.tab, plan: s.plan });
        }
        continue;
      }
      const plan = reportToPlanEntity.get(e.tab);
      if (!plan) continue;
      // Injected standalone entities have no report counts (the count short-circuit
      // would always read "present"), so (re)generate to ensure this BU's files exist.
      if (EXTRA_ENTITY_TABS.has(e.tab)) { out.push({ tab: e.tab, plan }); continue; }
      const included = includedFilesFor(bu, e.tab);
      // Skip only files explicitly marked not-applicable for this agency (N/A or a
      // dash). An undefined count means the BU is beyond the validation report's
      // agencies — the agency report still attaches the entity there, so require the
      // actual file and generate it if missing (otherwise a whole entity like
      // Contracts only ever generates its 4 report agencies).
      const present = e.files.filter(f => included.includes(f.label)).every(f => { const c = f.counts[bu]; if (c === 'N/A' || c === null) return true; return buFilePresent(mans, e.entity, f.label, bu).present; });
      if (!present) out.push({ tab: e.tab, plan });
    }
    return out;
  }, [valReport, assignedEntitiesFor, includedFilesFor, reportToPlanEntity]);

  const prepareBU = useCallback(async (bu: string, onlyEntity?: string) => {
    if (!valReport) return;
    const toGen = buEntitiesToGenerate(bu, onlyEntity);
    if (!confirm(`Generate ${toGen.length} entit${toGen.length !== 1 ? 'ies' : 'y'} for BU ${bu} (only ${bu}'s files)${onlyEntity ? ` · ${onlyEntity}` : ''} and load into Sampling?\n${toGen.map(t => '• ' + t.tab).join('\n') || '(nothing missing — will just load)'}\n\nThis reads the conversion tables and writes CV_ files to S3.`)) return;
    setBuPrep({ running: true, done: 0, total: toGen.length, current: '' });
    const actor = userEmail ? `&actor=${encodeURIComponent(userEmail)}` : '';
    for (let i = 0; i < toGen.length; i++) {
      setBuPrep({ running: true, done: i, total: toGen.length, current: toGen[i].tab });
      try {
        const url = `${LAMBDA_URL}?action=generate_entity_files&mock=${PLAN_MOCK}&entity=${encodeURIComponent(toGen[i].plan)}&bu=${encodeURIComponent(bu)}${actor}`;
        const d = await (await fetch(url)).json();
        if (!d.ok) console.error('per-BU gen failed', toGen[i], d.error);
      } catch (e) { console.error('per-BU gen error', toGen[i], e); }
    }
    try { const md = await readAllManifests(PLAN_MOCK); setValManifests(md.files); valManifestsRef.current = md.files; setValEmpties(md.empties); valEmptiesRef.current = md.empties; } catch { /* keep old */ }
    setBuPrep({ running: false, done: 0, total: 0, current: '' });
    await loadBUIntoSampling(bu, onlyEntity);
  }, [valReport, buEntitiesToGenerate, userEmail, loadBUIntoSampling]);

  // Sampling config (the example report's data) loaded once from S3; drives the
  // Configuration sheet of each per-run tracking report.
  const samplingConfigRef = useRef<{ headers: string[]; rows: unknown[][] } | null>(null);
  const samplingConfigLoadingRef = useRef(false);
  const ensureSamplingConfig = useCallback(async () => {
    if (samplingConfigRef.current || samplingConfigLoadingRef.current) return;
    samplingConfigLoadingRef.current = true;
    try {
      const { url } = await getUrl({ path: SAMPLING_CONFIG_PATH, options: { validateObjectExistence: true } });
      const resp = await fetch(url.toString());
      const fd = resp.ok ? parseWorkbookBuffer(await resp.arrayBuffer()) : null;
      samplingConfigRef.current = fd ? { headers: fd.headers.map(String), rows: fd.rows } : { headers: [], rows: [] };
    } catch {
      samplingConfigRef.current = { headers: [], rows: [] };
    } finally {
      samplingConfigLoadingRef.current = false;
    }
  }, []);

  // The config rows for one entity (matched on the config's Entity column).
  const configForEntity = useCallback((entity: string): { headers: string[]; rows: unknown[][] } | null => {
    const cfg = samplingConfigRef.current;
    if (!cfg || !cfg.headers.length) return cfg;
    const entIdx = cfg.headers.findIndex(h => String(h).trim().toLowerCase() === 'entity');
    if (entIdx < 0) return { headers: cfg.headers, rows: cfg.rows };
    const target = normStr(entity);
    const rows = cfg.rows.filter(r => {
      const ce = normStr(String(r[entIdx] ?? ''));
      return !!ce && !!target && (ce === target || ce.includes(target) || target.includes(ce));
    });
    return { headers: cfg.headers, rows };
  }, []);

  // Size, seed-select, build the per-file report, and write it to Local (full) +
  // Client (no Sizing). Shared by the single-entry Generate button and the
  // entity-wide batch run. `download` triggers a local copy (skipped for batches).
  const sampleAndWriteResult = useCallback(async (
    p: { entity: string; agency: string; tab?: string; bu?: string; N: number; data: FileData; merged?: MergeResult; download: boolean }
  ): Promise<{ seed: number; n: number } | null> => {
    const tier = confidenceTierFor(p.agency, p.tab, p.entity); // #5: per-BU confidence override, else default
    if (!tier || !p.N) return null;
    const n = computeSampleSize(p.N, tier);
    const seed = Math.floor(Math.random() * 2 ** 32) >>> 0;
    const selectedIndices = selectSample(p.N, n, seed);
    const now = new Date();
    const agency = p.agency || 'NA';
    const st = stamp(now);
    // Client naming convention: "<Parent Entity> BU <3-digit BU>-Sample Converted Data <timestamp>.xlsx".
    // #7: the trailing timestamp makes every run its own file (no overwrite) and
    // matches it to its tracking report, which shares the same stamp via `base`.
    const base = `${parentEntityLabel(p.entity)} BU ${bu3(agency)}-Sample Converted Data ${st}`;
    const meta = { entity: p.entity, agency, tier, N: p.N, n, seed, generatedAt: now.toISOString(), generatedBy: userEmail, selectedIndices };
    // Each source file gets its own Sample + Population sheet, linked by the shared
    // Unique ID (highlighted); a merged entry contributes its parent + every child.
    const files = p.merged
      ? mergeResultToReportFiles(p.merged, selectedIndices, titleCaseEntity(p.entity))
      : [singleFileReport(titleCaseEntity(p.entity), p.data.sheetName || p.entity, p.data.headers, p.data.rows, selectedIndices)];
    // Population sheets are dropped from the internal (Local) copy for entities whose
    // populations are too large to be useful there — HCM Person (165-col Person Name ×
    // 8 sub-entities) and Purchase Orders. The team reads the full data from the DB; the
    // client/server copies never carry Population.
    const withPop = p.tab !== HCM_PERSON_TAB && matchEntity(p.entity) !== 'PURCHASE ORDERS';
    const full = buildPerFileReport(files, meta, { includeSizing: true, includePopulation: withPop, integrity: p.merged?.integrity });
    const client = buildPerFileReport(files, meta, { includeSizing: false, includePopulation: false }); // client + server copy: Sample sheets only
    await uploadData({ path: `${LOCAL_FOLDER}${base}.xlsx`, data: new Blob([await reportToBuffer(full)], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;
    const clientKey = `${CLIENT_FOLDER}${base}.xlsx`;
    await uploadData({ path: clientKey, data: new Blob([await reportToBuffer(client)], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;

    // One copy of the client file must also land in the SQL Server box's watched
    // ToPublish folder on every run. The browser can't reach the box, so the
    // Lambda pulls the just-uploaded client file down via SSM. Never fail the
    // sample over this — record whatever status comes back in the tracking report.
    let serverPath = '', serverStatus = '';
    try {
      const pub = await (await fetch(`${LAMBDA_URL}?action=publish_to_server&key=${encodeURIComponent(clientKey)}`)).json();
      serverStatus = pub.status || (pub.ok ? 'Success' : 'Failed');
      serverPath = pub.dest || '';
      if (!pub.ok) console.error('publish to server did not confirm', pub);
    } catch (err) {
      serverStatus = 'Error';
      console.error('publish to server failed', err);
    }

    // Per-run tracking report → Sampling/Reports/ (one per run, timestamped) so a
    // suspect record traces to who/when/seed, the config, and the source files.
    try {
      await ensureSamplingConfig();
      const reportName = `${base} - Tracking Report.xlsx`; // base already carries the run stamp (#7)
      const trk = buildTrackingReport({
        entity: p.entity, agency, mock: PLAN_MOCK,
        tierName: tier.name, confidence: tier.confidence, Z: tier.Z, e: tier.e, p: tier.p,
        N: p.N, n, seed, generatedAt: now.toISOString(), generatedBy: userEmail,
        sampleFile: `${base}.xlsx`,
        localPath: `${LOCAL_FOLDER}${base}.xlsx`,
        clientPath: clientKey,
        serverPath, serverStatus,
        reportPath: `${REPORTS_FOLDER}${reportName}`,
      }, configForEntity(p.entity), p.merged);
      await uploadData({ path: `${REPORTS_FOLDER}${reportName}`, data: new Blob([await reportToBuffer(trk)], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;
    } catch (err) {
      console.error('tracking report failed', err); // never fail the sample over the report
    }

    if (p.download) await downloadReport(full, `${base}.xlsx`);
    if (p.tab) await recordSampled(p.bu ?? agency, p.tab); // #6: check off the loading BU (= agency except HCM)
    return { seed, n };
  }, [userEmail, ensureSamplingConfig, configForEntity, PLAN_MOCK, confidenceTierFor, recordSampled]);

  // Injected entities: one workbook per agency with a sampled sheet per sub-entity
  // (each pooled population sized independently), written to Local + Client + box.
  const sampleAndWriteInjected = useCallback(async (e: EntityValidation, bu: string, results: MergeResult[]): Promise<{ seed: number; n: number } | null> => {
    const tier = confidenceTierFor(bu, e.tab, e.entity);
    if (!tier) return null;
    const files: ReportFile[] = [];
    let totalN = 0, totaln = 0, firstSeed = 0;
    for (const r of results) {
      if (!r.recordCount) continue;
      const n = computeSampleSize(r.recordCount, tier);
      const seed = Math.floor(Math.random() * 2 ** 32) >>> 0;
      if (!firstSeed) firstSeed = seed;
      files.push(...mergeResultToReportFiles(r, selectSample(r.recordCount, n, seed), r.entityToken));
      totalN += r.recordCount; totaln += n;
    }
    if (!files.length) return null;
    const now = new Date();
    const st = stamp(now);
    const agency = bu || 'NA';
    const base = `${parentEntityLabel(e.entity)} BU ${bu3(agency)}-Sample Converted Data ${st}`;
    const meta = { entity: e.entity, agency, tier, N: totalN, n: totaln, seed: firstSeed, generatedAt: now.toISOString(), generatedBy: userEmail, selectedIndices: [] as number[] };
    const full = buildPerFileReport(files, meta, { includeSizing: true });
    const client = buildPerFileReport(files, meta, { includeSizing: false, includePopulation: false });
    await uploadData({ path: `${LOCAL_FOLDER}${base}.xlsx`, data: new Blob([await reportToBuffer(full)], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;
    const clientKey = `${CLIENT_FOLDER}${base}.xlsx`;
    await uploadData({ path: clientKey, data: new Blob([await reportToBuffer(client)], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;
    let serverPath = '', serverStatus = '';
    try {
      const pub = await (await fetch(`${LAMBDA_URL}?action=publish_to_server&key=${encodeURIComponent(clientKey)}`)).json();
      serverStatus = pub.status || (pub.ok ? 'Success' : 'Failed'); serverPath = pub.dest || '';
    } catch { serverStatus = 'Error'; }
    try {
      await ensureSamplingConfig();
      const reportName = `${base} - Tracking Report.xlsx`;
      const trk = buildTrackingReport({
        entity: e.entity, agency, mock: PLAN_MOCK,
        tierName: tier.name, confidence: tier.confidence, Z: tier.Z, e: tier.e, p: tier.p,
        N: totalN, n: totaln, seed: firstSeed, generatedAt: now.toISOString(), generatedBy: userEmail,
        sampleFile: `${base}.xlsx`, localPath: `${LOCAL_FOLDER}${base}.xlsx`, clientPath: clientKey,
        serverPath, serverStatus, reportPath: `${REPORTS_FOLDER}${reportName}`,
      }, configForEntity(e.entity), undefined);
      await uploadData({ path: `${REPORTS_FOLDER}${reportName}`, data: new Blob([await reportToBuffer(trk)], { type: XLSX_CT }), options: { contentType: XLSX_CT } }).result;
    } catch (err) { console.error('tracking report failed', err); }
    await recordSampled(bu, e.tab);
    return { seed: firstSeed, n: totaln };
  }, [userEmail, ensureSamplingConfig, configForEntity, PLAN_MOCK, confidenceTierFor, recordSampled]);

  // ── Sampling: generate → upload to Local (full) + Client (no Sizing) + local download ──
  const generate = async (entry: FileEntry) => {
    if (!entry.data || !entry.entity) return;
    patch(entry.id, { genStatus: 'working', genError: '' });
    try {
      const r = await sampleAndWriteResult({ entity: entry.entity, agency: entry.agency || 'NA', tab: entry.tab, bu: entry.sampleBu ?? entry.agency, N: entry.N, data: entry.data, merged: entry.merged || undefined, download: true });
      if (!r) { patch(entry.id, { genStatus: 'error', genError: 'No sampling classification for this entity.' }); return; }
      patch(entry.id, { genStatus: 'done', generated: { seed: r.seed, n: r.n, at: new Date().toLocaleString() } });
    } catch (err) {
      patch(entry.id, { genStatus: 'error', genError: err instanceof Error ? err.message : String(err) });
    }
  };

  const nFor = (entry: FileEntry): number | null => {
    const tier = entry.entity ? confidenceTierFor(entry.agency, entry.tab, entry.entity) : null;
    if (!tier || !entry.N) return null;
    return computeSampleSize(entry.N, tier);
  };
  const tierFor = (entry: FileEntry): Tier | undefined =>
    (entry.entity ? confidenceTierFor(entry.agency, entry.tab, entry.entity) : undefined);

  // ── Goal 5: run an entity across every BU it's attached to (agency report) ──
  const [entityRunSel, setEntityRunSel] = useState('');
  const [entityRun, setEntityRun] = useState<{ running: boolean; done: number; total: number; current: string; note: string }>({ running: false, done: 0, total: 0, current: '', note: '' });
  // Sample-size preview: each attached BU with its N -> tier -> computed n, shown
  // before the entity run (sizing stays automatic; this is confirm + transparency).
  const [entityPreview, setEntityPreview] = useState<{ open: boolean; loading: boolean; entity: string; error: string; rows: { bu: string; tierName: string; N: number; n: number }[] }>({ open: false, loading: false, entity: '', error: '', rows: [] });

  const attachedBUsForEntity = useCallback((entityTab: string): string[] => {
    if (!report) return [];
    // HCM Person and untracked injected entities (Location) aren't in the agency
    // report — they apply to every BU, so the entity-run spans them all (the preview
    // sizes each; BUs with no data show N=0).
    if (entityTab === HCM_PERSON_TAB || EXTRA_ENTITY_ALLBUS.has(entityTab)) return report.bus.map(b => b.unit);
    // Fixed single-agency entities (Customer and Sponsor) aren't in the agency report;
    // they run once under their one named agency (PRIFAS).
    if (EXTRA_ENTITY_FIXED[entityTab]) return [EXTRA_ENTITY_FIXED[entityTab]];
    const col = agencyColumnForEntity(report, valReport, entityTab);
    if (!col) return [];
    return report.bus.filter(b => { const s = b.statuses[col]; return s != null && String(s).trim() !== ''; }).map(b => b.unit);
  }, [report, valReport]);

  const runEntityAcrossBUs = useCallback(async (entityTab: string) => {
    if (!valReport) return;
    if (!report) { setEntityRun({ running: false, done: 0, total: 0, current: '', note: 'Agency report not loaded yet — open the BU Dashboard once so it loads, then retry.' }); return; }
    const allBus = attachedBUsForEntity(entityTab);
    if (!allBus.length) { setEntityRun({ running: false, done: 0, total: 0, current: '', note: `No BUs are attached to "${entityTab}" in the agency report.` }); return; }
    // Resume-safe: skip BUs already sampled for this entity so a re-run only does
    // the rest. Every entity runs all its BUs in one pass now — HCM Person's copies
    // no longer carry the huge Population sheets, so the bulk build is light. An
    // individual oversized BU is still skipped by the size guard below.
    const RUN_CAP = 500;
    const alreadyDone = allBus.filter(bu => (sampledRunsRef.current[bu] || []).includes(entityTab)).length;
    const remaining = allBus.filter(bu => !(sampledRunsRef.current[bu] || []).includes(entityTab));
    const bus = remaining.slice(0, RUN_CAP);
    const stillLeft = remaining.length - bus.length;
    if (!bus.length) { setEntityRun({ running: false, done: 0, total: 0, current: '', note: `All ${allBus.length} BUs for "${entityTab}" are already sampled.` }); return; }
    setEntityPreview(p => ({ ...p, open: false })); // preview (if open) served as the confirmation
    setEntityRun({ running: true, done: 0, total: bus.length, current: '', note: '' });
    const actor = userEmail ? `&actor=${encodeURIComponent(userEmail)}` : '';
    let reports = 0; const skipped: string[] = []; const tooLarge: string[] = [];
    for (let i = 0; i < bus.length; i++) {
      const bu = bus[i];
      setEntityRun({ running: true, done: i, total: bus.length, current: bu, note: '' });
      try {
        // 1) generate this BU's missing files for the entity
        const toGen = buEntitiesToGenerate(bu, entityTab);
        for (const t of toGen) {
          try { const d = await (await fetch(`${LAMBDA_URL}?action=generate_entity_files&mock=${PLAN_MOCK}&entity=${encodeURIComponent(t.plan)}&bu=${encodeURIComponent(bu)}${actor}`)).json(); if (!d.ok) console.error('gen failed', bu, t, d.error); }
          catch (e) { console.error('gen error', bu, t, e); }
        }
        if (toGen.length) { try { const md = await readAllManifests(PLAN_MOCK); setValManifests(md.files); valManifestsRef.current = md.files; setValEmpties(md.empties); valEmptiesRef.current = md.empties; } catch { /* keep old */ } }
        // 2) build + sample each master for this BU
        const built = await buildBUResults(bu, entityTab);
        for (const { e, results } of built) {
          if (EXTRA_ENTITY_TABS.has(e.tab)) {
            // Injected entity: one workbook per agency, a sampled sheet per pooled
            // sub-entity. Flat sheets tolerate far more rows than a wide HCM master.
            const totalRows = results.reduce((s, r) => s + r.recordCount, 0);
            if (totalRows > 50000) { tooLarge.push(`${bu} (${totalRows.toLocaleString()})`); continue; }
            const r = await sampleAndWriteInjected(e, bu, results);
            if (r) reports++; else skipped.push(`${bu}/${e.entity}`);
            continue;
          }
          for (const result of results) {
            const entity = matchEntity(result.entityToken) || e.entity;
            // Skip masters too large to build client-side. Only HCM Person's wide,
            // multi-sub-entity workbooks need the tight cap; flatter entities (e.g.
            // PS Items) build fine with far more rows. The total-rows guard still
            // catches genuinely huge parent+child sets. Flagged; the CV_ files hold it.
            const childRows = result.childrenData.reduce((s, c) => s + c.rows.length, 0);
            // Population sheets are gone (HCM Person too), so the workbook build is
            // cheap; the total-rows guard is what protects against a huge parent+child
            // load. One cap for everyone now.
            if (result.recordCount > 50000 || result.recordCount + childRows > 100000) { tooLarge.push(`${bu} (${result.recordCount.toLocaleString()})`); continue; }
            // Label by the requested agency, not result.bu. For source-grouped
            // entities (Purchase Orders, BPA, AR/AP Invoices) the merge sets
            // result.bu to the source system (e.g. PRIFAS), which would name the
            // file "BU PRIFAS" and size it against the wrong confidence tier. This
            // BU's files were gathered for `bu`, so `bu` is the true agency.
            const r = await sampleAndWriteResult({ entity, agency: bu, tab: e.tab, bu, N: result.recordCount, data: resultToFileData(result), merged: result, download: false });
            if (r) reports++; else skipped.push(`${bu}/${entity}`);
          }
        }
      } catch (e) { console.error('run entity across BU failed', bu, e); }
    }
    setEntityRun({ running: false, done: bus.length, total: bus.length, current: '', note: `Done — ${reports} sampled across ${bus.length} BU${bus.length !== 1 ? 's' : ''}${alreadyDone ? ` (+${alreadyDone} earlier)` : ''}${tooLarge.length ? ` · ${tooLarge.length} too large to build here: ${tooLarge.join(', ')}` : ''}${stillLeft ? ` · ${stillLeft} more remaining — reload + run again` : ''}${skipped.length ? ` · ${skipped.length} no-data` : ''}.` });
  }, [valReport, report, attachedBUsForEntity, buEntitiesToGenerate, buildBUResults, sampleAndWriteResult, sampleAndWriteInjected, userEmail]);

  // Preview the per-BU sample sizes for an entity before running. N is estimated
  // from the entity's dry-run (root-table row count per BU); n = Cochran(N, tier).
  const openEntityPreview = useCallback(async (entityTab: string) => {
    if (!valReport || !report) return;
    const bus = attachedBUsForEntity(entityTab);
    if (!bus.length) { setEntityRun(s => ({ ...s, note: `No BUs are attached to "${entityTab}" in the agency report.` })); return; }
    setEntityPreview({ open: true, loading: true, entity: entityTab, error: '', rows: [] });
    try {
      const plan = reportToPlanEntity.get(entityTab);
      const rootNorm = normTbl(resolveEntityTarget(valReport, samplingTargetsRef.current || [], entityTab)?.table || '');
      const cls = matchEntity(resolveEntityTarget(valReport, samplingTargetsRef.current || [], entityTab)?.table || '') || matchEntity(entityTab) || '';
      let planned: { table: string; source: string; bu: string; rows: number }[] = [];
      if (plan) {
        const d = await (await fetch(`${LAMBDA_URL}?action=generate_entity_files&mock=${PLAN_MOCK}&entity=${encodeURIComponent(plan)}&dry_run=1`)).json();
        if (d.ok) planned = d.planned || [];
      }
      const rootEntries = planned.filter(p => normTbl(p.table) === rootNorm);
      const isHcm = entityTab === HCM_PERSON_TAB;
      const rows = bus.map(bu => {
        let N: number;
        if (isHcm) {
          // #9: a BU can span several HCM source systems (and two mocks that
          // normalize the same), so sum the current-mock entries for the BU.
          N = rootEntries.filter(p => p.table.toUpperCase().includes(PLAN_MOCK) && (p.source === bu || p.bu === bu)).reduce((s, p) => s + p.rows, 0);
        } else {
          const hit = rootEntries.find(p => rowMatchesBU(p.source, p.bu, bu));
          N = hit ? hit.rows : rootEntries.reduce((s, p) => s + p.rows, 0);
        }
        const tier = confidenceTierFor(bu, entityTab, cls);
        const n = tier && N ? computeSampleSize(N, tier) : 0;
        return { bu, tierName: tier?.name || '—', N, n };
      });
      setEntityPreview({ open: true, loading: false, entity: entityTab, error: rootEntries.length ? '' : 'Could not size from the conversion plan — sizes will be computed per BU during the run.', rows });
    } catch (err) {
      setEntityPreview({ open: true, loading: false, entity: entityTab, error: err instanceof Error ? err.message : String(err), rows: bus.map(bu => ({ bu, tierName: '—', N: 0, n: 0 })) });
    }
  }, [valReport, report, attachedBUsForEntity, reportToPlanEntity, confidenceTierFor, PLAN_MOCK]);

  // ── Reproduce a prior sample from its recorded seed ──
  const addRepFile = async (file: File) => {
    setRepError('');
    setRepResult(null);
    try {
      const parsed = parsePriorSample(await file.arrayBuffer());
      if (!parsed.population) {
        setRepFile(null);
        setRepError('This workbook has no "Population" sheet. Reproduction needs the full sample workbook (the copy that still carries its Population sheet).');
        return;
      }
      const sz = parsed.sizing;
      const guess = parseFilename(file.name);
      setRepFile({ name: file.name, parsed });
      setRepEntity(sz?.entity || guess.entity || '');
      setRepAgency(sz?.agency || guess.agency || '');
      setRepN(String(sz?.N ?? parsed.population.rows.length));
      setRepn(sz?.n != null ? String(sz.n) : '');
      setRepSeed(sz?.seed != null ? String(sz.seed) : '');
    } catch (err) {
      setRepFile(null);
      setRepError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRepDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsRepDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) addRepFile(f);
  };

  // Manual: compute the seeded selection (row positions) from N / n / seed alone.
  const computeManualSelection = () => {
    setManError(''); setManIndices(null);
    const N = parseInt(manN, 10), n = parseInt(mann, 10), seed = Number(manSeed);
    if (!Number.isFinite(N) || N <= 0) { setManError('Enter a valid population size (N).'); return; }
    if (!Number.isFinite(n) || n <= 0) { setManError('Enter the sample size (n).'); return; }
    if (!Number.isInteger(seed)) { setManError('Enter a numeric integer seed.'); return; }
    setManIndices(selectSample(N, n, seed));
  };

  const reproduce = () => {
    setRepError('');
    const pop = repFile?.parsed.population;
    if (!pop) return;
    const N = parseInt(repN, 10), n = parseInt(repn, 10), seed = Number(repSeed);
    if (!Number.isFinite(N) || N <= 0) { setRepError('Enter a valid population size (N).'); return; }
    if (!Number.isFinite(n) || n <= 0) { setRepError('Enter the sample size (n) from the original run.'); return; }
    if (!Number.isInteger(seed)) { setRepError('Enter the numeric seed from the original run (an integer).'); return; }
    const indices = selectSample(N, n, seed);
    const sample = repFile?.parsed.sample;
    if (sample) {
      const v = verifyReproduction(pop, sample, indices);
      setRepResult({ indices, checked: true, matched: v.matched, total: v.total, identical: v.identical });
    } else {
      setRepResult({ indices, checked: false, matched: 0, total: 0, identical: false });
    }
  };

  const downloadReproduced = () => {
    const pop = repFile?.parsed.population;
    if (!pop || !repResult) return;
    const N = parseInt(repN, 10), n = parseInt(repn, 10), seed = Number(repSeed);
    const entity = (repEntity || 'SAMPLE').trim();
    const agency = (repAgency || 'NA').trim();
    const tierName = (repFile?.parsed.sizing?.tierName || '').toUpperCase();
    const tier = tierForEntity(entity) || TIERS[tierName] || { name: tierName || '—', confidence: 0, Z: 0, e: 0, p: 0 };
    const now = new Date();
    const meta = {
      entity, agency, tier, N, n, seed,
      generatedAt: now.toISOString(), generatedBy: userEmail, selectedIndices: repResult.indices,
    };
    const wb = buildWorkbook(pop, meta, true);
    downloadWorkbook(wb, `${parentEntityLabel(entity)} BU ${bu3(agency)}-Sample Converted Data (Reproduced ${stamp(now)}).xlsx`);
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
    if ((activeTab === 'sampling' || activeTab === 'dashboard' || activeTab === 'bybu') && !reportLoaded) loadReport();
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

  // Shared sample-size preview (rendered inside whichever entity-run panel is active).
  const entityPreviewPanel = entityPreview.open ? (
    <div className="val-preview">
      <div className="val-preview-head">
        <strong>Sample sizes for &ldquo;{valReport?.entities.find(e => e.tab === entityPreview.entity)?.entity || entityPreview.entity}&rdquo;</strong>
        <span className="val-muted"> — {entityPreview.rows.length} BU{entityPreview.rows.length !== 1 ? 's' : ''}, sized automatically (N × confidence tier). Review, then run.</span>
        <button className="val-link-btn" onClick={() => setEntityPreview(p => ({ ...p, open: false }))}>close</button>
      </div>
      {entityPreview.loading ? (
        <div className="val-muted"><span className="val-spinner val-spinner-dark" /> Sizing each BU…</div>
      ) : (
        <>
          {entityPreview.error && <div className="val-note val-reproduce-warn">{entityPreview.error}</div>}
          <div className="val-preview-scroll">
            <table className="val-table val-preview-table">
              <thead><tr><th>BU</th><th>Confidence</th><th className="val-col-num">Population (N)</th><th className="val-col-num">Sample (n)</th></tr></thead>
              <tbody>
                {entityPreview.rows.map(r => (
                  <tr key={r.bu}>
                    <td className="val-bu-unit">{r.bu}</td>
                    <td>{r.tierName !== '—' ? <span className={`val-class val-class-${r.tierName.toLowerCase()}`}>{r.tierName}</span> : <span className="val-muted">—</span>}</td>
                    <td className="val-col-num">{r.N ? r.N.toLocaleString() : <span className="val-muted">on run</span>}</td>
                    <td className="val-col-num val-n">{r.n || <span className="val-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td>Total</td><td></td><td className="val-col-num">{entityPreview.rows.reduce((s, r) => s + r.N, 0).toLocaleString()}</td><td className="val-col-num val-n">{entityPreview.rows.reduce((s, r) => s + r.n, 0)}</td></tr></tfoot>
            </table>
          </div>
          <div className="val-preview-actions">
            <button className="val-btn-row" disabled={entityRun.running} onClick={() => runEntityAcrossBUs(entityPreview.entity)}>
              ▶ Generate + sample {entityPreview.rows.length} BU{entityPreview.rows.length !== 1 ? 's' : ''} (writes real ERP data)
            </button>
            <button className="val-btn-secondary" onClick={() => setEntityPreview(p => ({ ...p, open: false }))}>Cancel</button>
          </div>
        </>
      )}
    </div>
  ) : null;

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
              Sampling is automated. Pick an entity below to generate and sample every BU it&rsquo;s
              attached to, or use the <button className="val-link-btn" onClick={() => setActiveTab('bybu')}>Sample by BU</button> tab
              to run a single business unit. Each run sizes the population with the Framework V2
              formula, draws a seeded random sample, and writes the workbook to <strong>Local</strong> +
              <strong> Client</strong> plus a tracking report to <strong>Reports</strong>. Everything runs in your browser.
            </p>
            <div className="val-note">
              n = N·Z²·p·(1−p) / [ e²·(N−1) + Z²·p·(1−p) ], rounded up. Tiers: HIGH 99% ·
              MODERATE 95% · LOW 90% · AUTO 85%. Selection uses a recorded random seed so any
              sample can be reproduced.
            </div>
          </div>

          {valReport ? (
            <div className="val-entityrun val-entityrun-primary">
              <div className="val-entityrun-head">
                <strong>Run one entity across every BU it&rsquo;s attached to</strong>
                <span className="val-dropzone-hint"> — generates each BU&rsquo;s files and writes a sample + tracking report to Sampling/Local + Client + Reports, using the agency report for the BU list.</span>
              </div>
              <div className="val-entityrun-row">
                <label className="val-bu-pick">Entity
                  <select value={entityRunSel} onChange={ev => setEntityRunSel(ev.target.value)} disabled={entityRun.running}>
                    <option value="">— select entity —</option>
                    {valReport.entities.map(e => <option key={e.tab} value={e.tab}>{e.entity || e.tab}</option>)}
                  </select>
                </label>
                <button className="val-btn-row" disabled={!entityRunSel || entityRun.running} onClick={() => openEntityPreview(entityRunSel)}>
                  {entityRun.running ? <><span className="val-spinner" /> {entityRun.current || 'starting'} ({entityRun.done}/{entityRun.total})…</> : '▶ Preview + sample all attached BUs'}
                </button>
                {entityRunSel && !entityRun.running && (
                  <span className="val-muted">{attachedBUsForEntity(entityRunSel).length} BU{attachedBUsForEntity(entityRunSel).length !== 1 ? 's' : ''} attached{!report ? ' · loading agency report…' : ''}</span>
                )}
              </div>
              {entityRun.note && <div className="val-gen-note-inline">{entityRun.note}</div>}
              {entityPreviewPanel}
            </div>
          ) : (
            <div className="val-note">{valLoading ? 'Loading entities from the validation report…' : 'Upload the Entity Validation Report on the Completeness tab to enable entity runs.'}</div>
          )}

          <div className="val-reproduce-cta">
            <div>
              <strong>Reproduce a prior sample</strong>
              <span className="val-dropzone-hint"> — re-draw an earlier run&rsquo;s exact selection from its recorded seed, for audit or a row-by-row comparison.</span>
            </div>
            <button className="val-btn-secondary" onClick={() => setActiveTab('reproduce')}>🎯 Reproduce by seed →</button>
          </div>

          <div className="val-generated">
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
                  const cls = tierFor(entry)?.name || null; // reflects the per-BU confidence override
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
            <p>Sampling completion per Business Unit — how many of each BU&rsquo;s expected entities (from the agency report) have a completed sample run. Starts at 0 and checks off automatically as you run samples. Expand a BU to see which entities are still to sample.</p>
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

          {!reportLoading && report && (() => {
            // #4: completion here tracks SAMPLING, not conversion status. Expected =
            // the entities attached to each BU (agency report); done = those with a
            // completed sample run. Starts at 0 and checks off as runs happen.
            const entLabel = (tab: string) => valReport?.entities.find(e => e.tab === tab)?.entity || tab;
            const rows = filteredGroups.map(g => {
              const ents = valReport ? assignedEntitiesFor(g.code) : [];
              const sampledList = sampledRuns[g.code] || [];
              const done = ents.filter(t => sampledList.includes(t)).length;
              return { g, ents, sampledList, done, fr: ents.length ? done / ents.length : 0 };
            }).sort((a, b) => a.fr - b.fr || a.g.code.localeCompare(b.g.code));
            const expTotal = rows.reduce((s, r) => s + r.ents.length, 0);
            const doneTotal = rows.reduce((s, r) => s + r.done, 0);
            const busDone = rows.filter(r => r.ents.length > 0 && r.done === r.ents.length).length;
            return (
            <>
              <div className="val-dash-top">
                <div className="val-dash-chart">
                  <Donut completed={doneTotal} partial={0} pending={Math.max(0, expTotal - doneTotal)} />
                </div>
                <div className="val-dash-stats">
                  <div className="val-legend">
                    <span className="val-legend-item"><i className="val-dot val-dot-completed" /> Sampled <b>{doneTotal}</b></span>
                    <span className="val-legend-item"><i className="val-dot val-dot-pending" /> Remaining <b>{Math.max(0, expTotal - doneTotal)}</b></span>
                  </div>
                  <div className="val-cards">
                    <div className="val-card"><span className="val-card-num">{rows.length}</span><span className="val-card-label">Business Units</span></div>
                    <div className="val-card"><span className="val-card-num">{expTotal}</span><span className="val-card-label">Entities to sample</span></div>
                    <div className="val-card"><span className="val-card-num">{busDone}</span><span className="val-card-label">BUs fully sampled</span></div>
                  </div>
                  <button className="val-btn-secondary" onClick={() => reportInputRef.current?.click()}>Update report</button>
                  <input ref={reportInputRef} type="file" accept=".xlsx,.xlsm,.xls" style={{ display: 'none' }}
                    onChange={e => { if (e.target.files?.[0]) uploadReport(e.target.files[0]); e.target.value = ''; }} />
                </div>
              </div>

              <div className="val-dash-controls">
                <input className="val-search" placeholder="Filter by BU number or name…" value={filter} onChange={e => setFilter(e.target.value)} />
                <span className="val-muted">{rows.length} of {groups.length} · sorted by least sampled</span>
              </div>

              <table className="val-table val-bu">
                <thead>
                  <tr>
                    <th className="val-col-caret"></th>
                    <th>BU</th>
                    <th>Agency</th>
                    <th className="val-col-progress">Sampling completion</th>
                    <th className="val-col-num" title="Entities sampled for this BU (a sample run checks one off)">Sampled</th>
                    <th className="val-col-num" title="Entities attached to this BU that need a sample">Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ g, ents, sampledList, done, fr }) => {
                    const open = !!expanded[g.code];
                    const pct = Math.round(fr * 100);
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
                          <td className="val-col-num">
                            {ents.length
                              ? <span className={done === ents.length ? 'val-comp-ok' : done ? 'val-comp-warn' : 'val-muted'}>{done}</span>
                              : <span className="val-muted">—</span>}
                          </td>
                          <td className="val-col-num">{ents.length || <span className="val-muted">—</span>}</td>
                        </tr>
                        {open && (
                          <tr className="val-bu-detail-row">
                            <td></td>
                            <td colSpan={5}>
                              {ents.length > 0 ? (
                                <div className="val-samp-progress">
                                  <span className="val-samp-progress-label">{done} of {ents.length} entities sampled for BU {g.code}:</span>
                                  {ents.map(t => (
                                    <span key={t} className={`val-samp-badge ${sampledList.includes(t) ? 'done' : ''}`}>
                                      {sampledList.includes(t) ? '✓' : '○'} {entLabel(t)}
                                    </span>
                                  ))}
                                </div>
                              ) : <span className="val-muted">No entities attached to this BU in the agency report.</span>}
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
            // #7: an entity marked "Delivered / ready" counts as present everywhere
            // (all its tables are updated and ready to sample).
            const deliveredFor = (e: EntityValidation) => statusForTab(e.tab, e.entity) === 'ready';
            let totExp = 0, totPresent = 0;
            valReport.entities.forEach(e => { const d = deliveredFor(e); e.files.forEach(f => e.agencies.forEach(ag => {
              const c = f.counts[ag]; if (!c || c === 'N/A') return; totExp++;
              if (d || presentFor(mans, f.label, ag).present) totPresent++;
            })); });
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
                      const delivered = deliveredFor(e);
                      let exp = 0, pres = 0;
                      e.files.forEach(f => e.agencies.forEach(ag => { const c = f.counts[ag]; if (!c || c === 'N/A') return; exp++; if (delivered || presentFor(mans, f.label, ag).present) pres++; }));
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
                                          if (delivered && !st.present) return (
                                            <td key={ag} className="val-col-num" title="Delivered / ready — tables updated and available to sample">
                                              {c.rows.toLocaleString()} <span className="val-comp-ok">✓</span>
                                            </td>
                                          );
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
              Pick a business unit — every BU from the agency report (all with expected FIN/SCM
              files) — to see the entities and master/child files it expects, whether those files
              have been generated, and the latest email status. When a BU&rsquo;s files are ready,
              load them into the Sampling tab to run the sample. For BUs beyond the validation
              report&rsquo;s agencies, the entity list is derived from the agency report and the file
              spec comes from the validation report. PRIFAS entities (Suppliers, Projects) share
              one file across all their agencies.
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
            const emp = valEmpties;
            const entTabs = assignedEntitiesFor(selectedBU);
            const shownTabs = sampleEntitySel ? entTabs.filter(t => t === sampleEntitySel) : entTabs;
            // #6: edit a BU's expected files inline (auto-saves). Removing drops a
            // label; adding picks a real table from the searchable list (2000+ tables).
            const toggleFileBU = (tab: string, label: string) => {
              const cur = buAssignments[selectedBU]?.[tab] ?? reportFilesFor(tab);
              const nextList = cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label];
              persistAssign({ ...buAssignments, [selectedBU]: { ...(buAssignments[selectedBU] || {}), [tab]: nextList } });
            };
            const addTableBU = (tab: string, table: string) => {
              const label = tableLabel(table);
              const cur = buAssignments[selectedBU]?.[tab] ?? reportFilesFor(tab);
              if (!cur.some(x => normStr(x) === normStr(label))) {
                persistAssign({ ...buAssignments, [selectedBU]: { ...(buAssignments[selectedBU] || {}), [tab]: [...cur, label] } });
              }
              setTableQuery('');
            };
            const tq = tableQuery.trim().toUpperCase();
            const tableHits = tq.length >= 2 ? sqlTables.filter(t => t.toUpperCase().includes(tq)) : [];
            // The validation report carries expected counts only for its own
            // agencies; for the other agency-report BUs we expect every included
            // file and read presence from the generation manifest instead.
            const buHasVal = valReport.agencies.includes(selectedBU);
            const rows = valReport.entities
              .filter(e => shownTabs.includes(e.tab))
              .map(e => {
                const status = statusForTab(e.tab, e.entity);
                const def = entityEmailStatus(e.entity);
                const note = status === def.status ? def.note : undefined;
                const included = includedFilesFor(selectedBU, e.tab);
                let exp = 0, pres = 0;
                const fileStates = included.map(lbl => {
                  const rf = e.files.find(f => f.label === lbl);
                  const c = rf ? rf.counts[selectedBU] : undefined;
                  if (buHasVal && rf && e.tab !== HCM_PERSON_TAB && (!c || c === 'N/A')) return { label: lbl, role: rf.role, na: true, present: false, rows: 0, emptyReason: null as string | null };
                  exp++;
                  const st = buFilePresent(mans, e.entity, lbl, selectedBU);
                  if (st.present) pres++;
                  const emptyReason = st.present ? null : buFileEmptyReason(emp, e.entity, lbl, selectedBU);
                  return { label: lbl, role: rf ? rf.role : 'child', na: false, present: st.present, rows: st.rows, emptyReason };
                });
                const emptyN = fileStates.filter(f => !f.na && !f.present && f.emptyReason).length;
                return { e, status, note, exp, pres, emptyN, ready: exp > 0 && pres === exp, fileStates };
              });
            const readyCount = rows.filter(r => r.ready).length;
            const anyReady = rows.some(r => r.ready);
            const scope = sampleEntitySel || undefined;
            const needGen = buEntitiesToGenerate(selectedBU, scope).length;
            const busy = buLoading || buPrep.running;
            const scopeLabel = scope ? (valReport.entities.find(e => e.tab === scope)?.entity || scope) : `BU ${selectedBU}`;
            return (
              <>
                <div className="val-entityrun">
                  <div className="val-entityrun-head">
                    <strong>Run one entity across every BU it&rsquo;s attached to</strong>
                    <span className="val-dropzone-hint"> — generates each BU&rsquo;s files and writes a sample report to Sampling/Local + Client, using the agency report for the BU list.</span>
                  </div>
                  <div className="val-entityrun-row">
                    <label className="val-bu-pick">Entity
                      <select value={entityRunSel} onChange={ev => setEntityRunSel(ev.target.value)} disabled={entityRun.running}>
                        <option value="">— select entity —</option>
                        {valReport.entities.map(e => <option key={e.tab} value={e.tab}>{e.entity || e.tab}</option>)}
                      </select>
                    </label>
                    <button className="val-btn-row" disabled={!entityRunSel || entityRun.running} onClick={() => runEntityAcrossBUs(entityRunSel)}>
                      {entityRun.running ? <><span className="val-spinner" /> {entityRun.current || 'starting'} ({entityRun.done}/{entityRun.total})…</> : '▶ Generate + sample all attached BUs'}
                    </button>
                    {entityRunSel && !entityRun.running && (
                      <span className="val-muted">{attachedBUsForEntity(entityRunSel).length} BU{attachedBUsForEntity(entityRunSel).length !== 1 ? 's' : ''} attached{!report ? ' · loading agency report…' : ''}</span>
                    )}
                  </div>
                  {entityRun.note && <div className="val-gen-note-inline">{entityRun.note}</div>}
                  {entityPreviewPanel}
                </div>

                <div className="val-bu-controls">
                  <label className="val-bu-pick">BU
                    <select value={selectedBU} onChange={ev => { setSelectedBU(ev.target.value); setSampleEntitySel(''); }} disabled={busy}>
                      {sampleBUOptions.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </label>
                  <label className="val-bu-pick">Entity
                    <select value={sampleEntitySel} onChange={ev => setSampleEntitySel(ev.target.value)} disabled={busy}>
                      <option value="">All entities</option>
                      {entTabs.map(t => <option key={t} value={t}>{valReport.entities.find(e => e.tab === t)?.entity || t}</option>)}
                    </select>
                  </label>
                  <span className="val-muted">{readyCount} of {rows.length} ready · {needGen ? `${needGen} to generate` : 'all present'}</span>
                  <button className="val-btn-row" disabled={busy} onClick={() => prepareBU(selectedBU, scope)}>
                    {buPrep.running ? <><span className="val-spinner" /> Generating {buPrep.current} ({buPrep.done}/{buPrep.total})…</> : `⚙ Generate & load ${scopeLabel}`}
                  </button>
                  <button className="val-btn-secondary" disabled={!anyReady || busy} onClick={() => loadBUIntoSampling(selectedBU, scope)}>
                    {buLoading ? <><span className="val-spinner val-spinner-dark" /> Loading…</> : `Load present only`}
                  </button>
                </div>

                <table className="val-table val-bu">
                  <thead>
                    <tr>
                      <th>Entity</th><th>Linking key</th><th>Email status</th>
                      <th className="val-col-num">Files</th><th>Expected files (✓ present / ⊘ empty / ✗ not generated)</th><th>Ready</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <React.Fragment key={r.e.tab}>
                      <tr>
                        <td className="val-bu-unit">{r.e.entity}</td>
                        <td className="val-muted" title={r.e.howItLinks}>{r.e.key}</td>
                        <td>
                          <span className={`val-repstatus ${emailStatusClass(r.status)}`}>{EMAIL_STATUS_LABEL[r.status]}</span>
                          {r.note && <span className="val-muted val-es-note"> {r.note}</span>}
                        </td>
                        <td className="val-col-num">{r.pres}/{r.exp}</td>
                        <td className="val-bu-files">
                          {r.fileStates.filter(f => !f.na).map((f, i) => {
                            const cls = f.present ? 'ok' : (f.emptyReason ? 'empty' : 'missing');
                            const sym = f.present ? '✓' : (f.emptyReason ? '⊘' : '✗');
                            const title = f.present ? `${f.rows.toLocaleString()} rows generated`
                              : f.emptyReason ? `empty — ${EMPTY_REASON_TEXT[f.emptyReason] || f.emptyReason}`
                              : 'not generated for this BU';
                            return <span key={i} className={`val-bu-file ${cls}`} title={title}>{sym} {f.label}</span>;
                          })}
                          <button className="val-file-edit" title="Add or remove this entity's expected files"
                            onClick={() => { const open = sbuEditTab === r.e.tab; setSbuEditTab(open ? '' : r.e.tab); setTableQuery(''); if (!open) loadSqlTables(); }}>
                            {sbuEditTab === r.e.tab ? '✕ done' : '✎ edit'}
                          </button>
                        </td>
                        <td>{r.ready ? <span className="val-repstatus val-rep-clean">Ready</span> : <span className="val-repstatus val-rep-orphans" title={r.emptyN ? `${r.emptyN} empty (table has no rows) · ${r.exp - r.pres - r.emptyN} not generated` : undefined}>{r.exp - r.pres} missing</span>}</td>
                      </tr>
                      {sbuEditTab === r.e.tab && (
                        <tr className="val-bu-detail-row">
                          <td colSpan={6}>
                            <div className="val-fileedit">
                              <div className="val-fileedit-head">Expected files for <b>{r.e.entity}</b> · BU {selectedBU} <span className="val-muted">— changes auto-save</span></div>
                              <div className="val-fileedit-chips">
                                {includedFilesFor(selectedBU, r.e.tab).map(lbl => (
                                  <span key={lbl} className="val-bu-file ok val-fileedit-chip">{lbl}
                                    <button className="val-chip-x" title="remove this file" onClick={() => toggleFileBU(r.e.tab, lbl)}>×</button>
                                  </span>
                                ))}
                                {includedFilesFor(selectedBU, r.e.tab).length === 0 && <span className="val-muted">No files — search below to add one.</span>}
                              </div>
                              <div className="val-fileedit-add">
                                <input className="val-search" placeholder="search tables to add a child (e.g. SUPPLIER_SITE)…" value={tableQuery} onChange={e => setTableQuery(e.target.value)} autoFocus />
                                {sqlTablesLoading && <span className="val-muted"> loading table list…</span>}
                                {tq.length >= 2 && (
                                  <div className="val-tablepick">
                                    {tableHits.length === 0 && <div className="val-muted">no tables match &ldquo;{tableQuery}&rdquo;</div>}
                                    {tableHits.slice(0, 30).map(t => (
                                      <button key={t} className="val-tablepick-item" onClick={() => addTableBU(r.e.tab, t)} title={`Add as "${tableLabel(t)}"`}>{t}</button>
                                    ))}
                                    {tableHits.length > 30 && <div className="val-muted">+{tableHits.length - 30} more — refine your search</div>}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
                <p className="val-muted val-bu-foot">
                  &ldquo;Ready&rdquo; means every expected master/child file for BU {selectedBU} has been generated.
                  <b> Generate &amp; load</b> produces only this BU&rsquo;s files for any entity that&rsquo;s missing (small, fast — no
                  need to pre-generate every entity) and loads them into Sampling. Email status is advisory — it reflects which
                  entities the team said are workable now.
                </p>
              </>
            );
          })()}
        </div>
      )}

      {activeTab === 'bufiles' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>BU Files — configuration</h2>
            <p>
              Which entities (and their master/child files) each BU needs — seeded from the validation
              report&rsquo;s <em>Present in agencies</em>. Each entity shows its real <strong>table name</strong>
              (e.g. <code>SCM_SUPPLIER_MOCK14_VW_TBL</code>) so you know exactly what you&rsquo;re wiring, and a
              <strong> Link parent&nbsp;→&nbsp;children</strong> picker lets you choose the shared Unique ID
              (Supplier&nbsp;Name, Order, …) that joins the files. Add, edit or delete assignments as
              requirements change and Save; everything persists to S3 and drives the Sample by BU tab.
            </p>
          </div>

          {valLoading && <div className="val-loading"><span className="val-spinner val-spinner-dark" /> Loading…</div>}
          {!valLoading && !valReport && (
            <div className="val-error">Upload the Entity Validation Report on the <button className="val-link-btn" onClick={() => setActiveTab('completeness')}>Completeness</button> tab first — it seeds this view.</div>
          )}

          {!valLoading && valReport && (() => {
            const bus = sampleBUOptions;
            const assigned = assignedEntitiesFor(buFilesSel);
            const reportByTab = new Map(valReport.entities.map(e => [e.tab, e]));
            const addable = availableEntityNames.filter(n => !assigned.some(a => normStr(a) === normStr(n)));
            const addEntity = () => {
              if (!addEntSel) return;
              setBuAssignments(p => ({ ...p, [buFilesSel]: { ...(p[buFilesSel] || {}), [addEntSel]: reportFilesFor(addEntSel) } }));
              setBuFilesExpanded(p => ({ ...p, [addEntSel]: true }));
              setAddEntSel('');
            };
            const removeEntity = (name: string) => setBuAssignments(p => { const inner = { ...(p[buFilesSel] || {}) }; delete inner[name]; return { ...p, [buFilesSel]: inner }; });
            const toggleFile = (name: string, label: string) => setBuAssignments(p => {
              const cur = p[buFilesSel]?.[name] ?? reportFilesFor(name);
              const next = cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label];
              return { ...p, [buFilesSel]: { ...(p[buFilesSel] || {}), [name]: next } };
            });
            const addCustomFile = (name: string, raw: string) => {
              const label = raw.trim(); if (!label) return;
              setBuAssignments(p => {
                const cur = p[buFilesSel]?.[name] ?? reportFilesFor(name);
                if (cur.some(x => normStr(x) === normStr(label))) return p;
                return { ...p, [buFilesSel]: { ...(p[buFilesSel] || {}), [name]: [...cur, label] } };
              });
              setAddFileInput(p => ({ ...p, [name]: '' }));
            };
            const addBU = () => {
              const b = newBuInput.trim();
              if (!b || buAssignments[b]) return;
              setBuAssignments(p => ({ ...p, [b]: {} })); setBuFilesSel(b); setNewBuInput('');
            };
            const deleteBU = () => {
              if (!buFilesSel || !confirm(`Remove BU ${buFilesSel} and its assignments? (Save to persist.)`)) return;
              setBuAssignments(p => { const n = { ...p }; delete n[buFilesSel]; return n; });
            };
            const setConfidence = (tab: string, val: string) => setEntityConfidence(p => {
              const inner = { ...(p[buFilesSel] || {}) };
              if (val) inner[tab] = val; else delete inner[tab];
              const next = { ...p, [buFilesSel]: inner };
              entityConfidenceRef.current = next;
              return next;
            });
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
                  <button className="val-btn-secondary" onClick={() => { saveBuAssignments(); saveLinkKeys(linkKeysRef.current); saveEntityConfidence(entityConfidenceRef.current); }} disabled={buAssignSaving}>
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
                  <span className="val-muted">expand an entity to pick its master/child files</span>
                </div>

                <table className="val-table val-bu">
                  <thead><tr><th className="val-col-caret"></th><th>Entity</th><th>Files included</th><th>Confidence</th><th>In report</th><th></th></tr></thead>
                  <tbody>
                    {assigned.length === 0 && <tr><td colSpan={6} className="val-muted" style={{ padding: '14px' }}>No entities assigned to {buFilesSel} yet — add one above.</td></tr>}
                    {assigned.map(name => {
                      const ent = reportByTab.get(name);
                      const options = entityFileOptions(name);
                      const included = includedFilesFor(buFilesSel, name);
                      const custom = included.filter(lbl => !options.some(o => normStr(o.label) === normStr(lbl)));
                      const open = !!buFilesExpanded[name];
                      const total = options.length + custom.length;
                      const tgt = entityTarget(name);
                      const linkOpts = entityLinkOptions(name);
                      const curLink = effectiveLinkKey(name);
                      return (
                        <React.Fragment key={name}>
                          <tr className="val-bu-row" onClick={() => { const willOpen = !open; setBuFilesExpanded(p => ({ ...p, [name]: willOpen })); if (willOpen) ensureEntityColumns(name); }}>
                            <td className="val-col-caret"><span className="val-caret">{open ? '▾' : '▸'}</span></td>
                            <td className="val-bu-unit">
                              {ent?.entity || name}
                              {tgt && <div className="val-bu-tablename" title={tgt.table}>{tgt.table}</div>}
                            </td>
                            <td className="val-muted">{included.length} of {total} file{total !== 1 ? 's' : ''}</td>
                            <td onClick={e => e.stopPropagation()}>
                              <select className="val-conf-select" value={entityConfidence[buFilesSel]?.[name] || ''} onChange={e => setConfidence(name, e.target.value)}>
                                <option value="">Default</option>
                                <option value="HIGH">HIGH · 99%</option>
                                <option value="MODERATE">MODERATE · 95%</option>
                                <option value="LOW">LOW · 90%</option>
                                <option value="AUTO">AUTO · 85%</option>
                              </select>
                            </td>
                            <td>{ent ? <span className="val-repstatus val-rep-clean">yes</span> : <span className="val-repstatus val-rep-other">no</span>}</td>
                            <td><button className="val-remove" onClick={e => { e.stopPropagation(); removeEntity(name); }} aria-label={`Remove ${name}`}>×</button></td>
                          </tr>
                          {open && (
                            <tr className="val-bu-detail-row">
                              <td></td>
                              <td colSpan={5}>
                                {tgt && (
                                  <div className="val-linkpick">
                                    <label className="val-bu-pick">Link parent&nbsp;→&nbsp;children on
                                      <select value={curLink} onChange={e => { const val = e.target.value; setLinkKeys(p => { const nx = { ...p }; if (val) nx[name] = val; else delete nx[name]; linkKeysRef.current = nx; return nx; }); }}>
                                        {!curLink && <option value="">— choose the Unique ID —</option>}
                                        {linkOpts.map(c => <option key={c} value={c}>{c}</option>)}
                                        {curLink && !linkOpts.some(c => c.toLowerCase() === curLink.toLowerCase()) && <option value={curLink}>{curLink}</option>}
                                      </select>
                                    </label>
                                    {colsLoading[tgt.table] && <span className="val-muted"><span className="val-spinner val-spinner-dark" /> loading columns…</span>}
                                    {linkKeys[name] && <button className="val-link-btn" onClick={() => setLinkKeys(p => { const nx = { ...p }; delete nx[name]; linkKeysRef.current = nx; return nx; })}>reset to config default</button>}
                                    <div className="val-muted val-linkpick-note">
                                      Columns shared between <code>{tgt.table}</code> and its {tgt.children.length} child table{tgt.children.length !== 1 ? 's' : ''}. The chosen column is the Unique ID that carries the sample across every file.
                                    </div>
                                  </div>
                                )}
                                {options.length === 0 && custom.length === 0 && <div className="val-muted">Not in the validation report and nothing generated yet — add files below, or add it to the report to get a spec.</div>}
                                <div className="val-filecheck-grid">
                                  {options.map(o => {
                                    const ft = fileTableName(name, o.label);
                                    return (
                                      <label key={o.label} className="val-filecheck" title={ft || undefined}>
                                        <input type="checkbox" checked={included.includes(o.label)} onChange={() => toggleFile(name, o.label)} />
                                        <span className="val-filecheck-body">
                                          <span>{o.label}{o.gen && <span className="val-muted"> (extra)</span>}</span>
                                          {ft && <span className="val-filecheck-table">{ft}</span>}
                                        </span>
                                      </label>
                                    );
                                  })}
                                  {custom.map(lbl => (
                                    <label key={lbl} className="val-filecheck">
                                      <input type="checkbox" checked onChange={() => toggleFile(name, lbl)} />
                                      <span className="val-filecheck-body"><span>{lbl} <span className="val-muted">(custom)</span></span></span>
                                    </label>
                                  ))}
                                </div>
                                <div className="val-bu-addfile">
                                  <input className="val-search" placeholder="add a file (e.g. Supplier Location)" value={addFileInput[name] || ''}
                                    onChange={e => setAddFileInput(p => ({ ...p, [name]: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter') addCustomFile(name, addFileInput[name] || ''); }} />
                                  <button className="val-btn-secondary" onClick={() => addCustomFile(name, addFileInput[name] || '')} disabled={!(addFileInput[name] || '').trim()}>+ add file</button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                <p className="val-muted val-bu-foot">
                  Expand an entity to choose which master/child files this BU expects (uncheck the ones it doesn&rsquo;t, like Contacts).
                  Checkboxes cover the report&rsquo;s files plus any extra tables the entity generated (e.g. Supplier Site); a custom file
                  you type only feeds sampling if its name matches a generated table. Changes take effect after <b>Save assignments</b>,
                  and drive the Sample by BU tab.
                </p>
              </>
            );
          })()}
        </div>
      )}

      {activeTab === 'reproduce' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <button className="val-link-btn" onClick={() => setActiveTab('sampling')}>&larr; Back to Sampling</button>
            <h2>Reproduce a Sample from its Seed</h2>
            <p>
              Drop a prior sample workbook (the full copy that includes the <strong>Sizing</strong> and{' '}
              <strong>Population</strong> sheets). The recorded seed, population size (N) and sample size (n)
              are read automatically, the exact same selection is re-drawn, and — when the workbook still
              carries its <strong>Sample</strong> sheet — the re-draw is checked against it to prove the rows
              are identical. Everything runs in your browser; nothing is uploaded.
            </p>
            <div className="val-note">
              Reproduction needs the <em>same population in the same order</em>. If the underlying extract
              changed since the original run (e.g. more records), the seed still draws deterministically but
              the selected rows may differ — the verification below will flag that.
            </div>
          </div>

          <div className="val-reproduce-panel">
            <div className="val-reproduce-file"><strong>Reproduce from a seed</strong> <span className="val-muted">— enter the population size, sample size and seed to get the exact sampled row positions (no file needed).</span></div>
            <div className="val-reproduce-grid">
              <label>Population (N)
                <input inputMode="numeric" value={manN} onChange={e => { setManN(e.target.value); setManIndices(null); }} />
              </label>
              <label>Sample (n)
                <input inputMode="numeric" value={mann} onChange={e => { setMann(e.target.value); setManIndices(null); }} />
              </label>
              <label>Seed
                <input inputMode="numeric" value={manSeed} onChange={e => { setManSeed(e.target.value); setManIndices(null); }} />
              </label>
            </div>
            {manError && <div className="val-error">{manError}</div>}
            <button className="val-btn-row" onClick={computeManualSelection}>🎲 Compute selection</button>
            {manIndices && (
              <div className="val-reproduce-idx">
                <span className="val-muted">Selected row positions (0-based, {manIndices.length} of {manN}): </span>
                <code>{manIndices.join(', ')}</code>
              </div>
            )}
          </div>

          <div className="val-reproduce-or">— or drop the workbook to verify against and re-export its rows —</div>

          <div
            className={`val-dropzone ${isRepDragOver ? 'drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsRepDragOver(true); }}
            onDragLeave={() => setIsRepDragOver(false)}
            onDrop={onRepDrop}
            onClick={() => repInputRef.current?.click()}
          >
            <input
              ref={repInputRef}
              type="file"
              accept=".xlsx,.xlsm,.xls"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) addRepFile(f); e.target.value = ''; }}
            />
            <span className="val-dropzone-icon">🎯</span>
            <p><strong>Drop a prior sample workbook here</strong> or click to browse</p>
            <p className="val-dropzone-hint">.xlsx — e.g. Supplier BU 015-Sample Converted Data.xlsx (use the Local/full copy so the seed is included)</p>
          </div>

          {repError && <div className="val-error">{repError}</div>}

          {repFile && (
            <div className="val-reproduce-panel">
              <div className="val-reproduce-file">
                📄 <strong>{repFile.name}</strong>
                <span className="val-muted"> — sheets: {repFile.parsed.sheetNames.join(', ')}</span>
              </div>
              {!repFile.parsed.sizing && (
                <div className="val-note">No <b>Sizing</b> sheet in this file (it looks like a client copy). Enter the seed and sample size (n) from the original run below.</div>
              )}
              <div className="val-reproduce-grid">
                <label>Entity
                  <input value={repEntity} onChange={e => { setRepEntity(e.target.value); setRepResult(null); }} />
                </label>
                <label>Agency
                  <input value={repAgency} onChange={e => { setRepAgency(e.target.value); setRepResult(null); }} />
                </label>
                <label>Population (N)
                  <input inputMode="numeric" value={repN} onChange={e => { setRepN(e.target.value); setRepResult(null); }} />
                </label>
                <label>Sample (n)
                  <input inputMode="numeric" value={repn} onChange={e => { setRepn(e.target.value); setRepResult(null); }} />
                </label>
                <label>Seed
                  <input inputMode="numeric" value={repSeed} onChange={e => { setRepSeed(e.target.value); setRepResult(null); }} />
                </label>
              </div>
              {repFile.parsed.population && repFile.parsed.sizing?.N != null &&
                repFile.parsed.sizing.N !== repFile.parsed.population.rows.length && (
                <div className="val-note val-reproduce-warn">
                  Heads up: the Sizing sheet records N = {repFile.parsed.sizing.N}, but the Population sheet
                  has {repFile.parsed.population.rows.length} rows. Reproduction uses the N above — they
                  should match for a faithful re-draw.
                </div>
              )}
              <button className="val-btn-row" onClick={reproduce}>🎲 Reproduce selection</button>
            </div>
          )}

          {repResult && (
            <div className="val-reproduce-result">
              {repResult.checked ? (
                <div className={repResult.identical ? 'val-comp-ok' : 'val-comp-missing'}>
                  {repResult.identical
                    ? `✓ Reproduced ${repResult.matched}/${repResult.total} rows — identical to the original Sample sheet.`
                    : `⚠ Only ${repResult.matched}/${repResult.total} rows match the original Sample sheet. The population or its order likely changed since the original run.`}
                </div>
              ) : (
                <div className="val-comp-warn">Re-drew {repResult.indices.length} rows. No Sample sheet in this file to verify against — download and compare manually.</div>
              )}
              <div className="val-reproduce-idx">
                <span className="val-muted">Selected row positions (0-based into the population): </span>
                <code>{repResult.indices.join(', ')}</code>
              </div>
              <button className="val-btn-secondary" onClick={downloadReproduced}>⬇ Download reproduced sample</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default withAuthenticator(ValidationsPage);
