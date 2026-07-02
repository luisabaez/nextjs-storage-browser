// Merge the raw parent + child files for an entity/agency into a single master
// file (the format uploaded for sampling), entirely in the browser. Verified to
// reproduce the hand-built Consolidated_Suppliers_015.xlsx exactly (79 columns,
// 0 value mismatches).
//
// Rules (derived from the supplier example):
//   * Parent = the file whose entity token is the shortest / a prefix of the others.
//   * Key    = the column common to every file (e.g. "Supplier Name").
//   * From each child, drop the key plus the context columns BU / SourceBU.
//   * 1:1 child (<=1 row per key)  -> left-join, columns prefixed "<Label>: ".
//   * many:1 child                 -> aggregate to "<col> Count" + "All <col>s".
//   * Column order: parent, then join children, then aggregate columns at the end.

import * as XLSX from 'xlsx';
import { FileData } from './sampling';

export interface RawFile { name: string; data: FileData; }

export interface ChildInfo {
  label: string;
  strategy: 'join' | 'aggregate';
  keptCols: number;
  rowCount: number;
}

// Full retained child data (for detail sheets + coverage), keyed on the parent key.
export interface ChildDetail {
  label: string;
  headers: string[];
  rows: unknown[][];
  keyIdx: number;              // index of the link column in headers
  strategy: 'join' | 'aggregate';
}

// Parent/child integrity + coverage for one child (automates the manual
// validation summary: orphans should be 0; gaps = parents with no child row).
export interface ChildIntegrity {
  child: string;
  rows: number;
  orphans: number;            // child rows whose key isn't in the parent
  parentsCovered: number;     // parents that have >= 1 row in this child
  parentsTotal: number;
  gaps: number;               // parents with no row in this child
  status: 'CLEAN' | 'ORPHANS';
}

export interface MergeResult {
  bu: string;
  entityToken: string;
  parentName: string;
  key: string;
  headers: string[];
  rows: unknown[][];
  children: ChildInfo[];
  childrenData: ChildDetail[];
  integrity: ChildIntegrity[];
  warnings: string[];
  recordCount: number;
}

// Curated short labels for known children; everything else is title-cased.
const LABEL_MAP: Record<string, string> = {
  ADDRESSES: 'Address', ADDRESS: 'Address',
  BANK_ACCOUNTS: 'Bank', BANK: 'Bank',
  CONTACTS: 'Contact', CONTACT: 'Contact',
};
const CONTEXT_COLS = ['bu', 'sourcebu'];

const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();

function tokenOf(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/^CV_/i, '').replace(/_MOCK\d+.*$/i, '');
}
function buOf(name: string): string {
  const m = name.replace(/\.[^.]+$/, '').match(/(\d+)(?!.*\d)/); // last run of digits
  return m ? m[1] : '';
}
function titleize(t: string): string {
  return t.split(/[_\s]+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Group dropped files by agency (BU), then by entity family (a parent whose
// token prefixes its children). Each returned array is one merge group.
export function groupRawFiles(files: RawFile[]): RawFile[][] {
  const byBu = new Map<string, RawFile[]>();
  files.forEach(f => {
    const b = buOf(f.name);
    if (!byBu.has(b)) byBu.set(b, []);
    byBu.get(b)!.push(f);
  });

  const groups: RawFile[][] = [];
  byBu.forEach(list => {
    const sorted = list.slice().sort((a, b) => tokenOf(a.name).length - tokenOf(b.name).length);
    const parents: { tok: string; members: RawFile[] }[] = [];
    for (const f of sorted) {
      const t = tokenOf(f.name).toLowerCase();
      let best: { tok: string; members: RawFile[] } | null = null;
      for (const p of parents) {
        if (t === p.tok || t.startsWith(p.tok + '_')) {
          if (!best || p.tok.length > best.tok.length) best = p;
        }
      }
      if (best) best.members.push(f);
      else parents.push({ tok: t, members: [f] });
    }
    parents.forEach(p => groups.push(p.members));
  });
  return groups;
}

export function mergeGroup(group: RawFile[]): MergeResult {
  const sorted = group.slice().sort((a, b) => tokenOf(a.name).length - tokenOf(b.name).length);
  const parent = sorted[0];
  const children = sorted.slice(1).sort((a, b) => a.name.localeCompare(b.name));
  const pTok = tokenOf(parent.name);

  // Key = first column present in every file.
  const common = parent.data.headers.filter(h =>
    group.every(g => g.data.headers.some(x => lc(x) === lc(h))));
  const key = String(common[0] ?? parent.data.headers[0] ?? 'Key');
  const keyLc = lc(key);
  const dropSet = new Set([keyLc, ...CONTEXT_COLS]);
  const pKeyIdx = parent.data.headers.findIndex(h => lc(h) === keyLc);

  interface CM {
    label: string;
    strategy: 'join' | 'aggregate';
    keep: { h: string; i: number }[];
    map: Map<string, unknown[][]>;
    total: number;
    kIdx: number;
    child: RawFile;
  }
  const cms: CM[] = children.map(c => {
    const kIdx = c.data.headers.findIndex(h => lc(h) === keyLc);
    const map = new Map<string, unknown[][]>();
    let maxPer = 0, total = 0;
    for (const r of c.data.rows) {
      const kv = String(r[kIdx] ?? '').trim();
      if (!kv) continue;
      const arr = map.get(kv) || [];
      arr.push(r); map.set(kv, arr); total++;
      if (arr.length > maxPer) maxPer = arr.length;
    }
    const suffix = tokenOf(c.name).slice(pTok.length).replace(/^_/, '');
    const label = LABEL_MAP[suffix.toUpperCase()] || titleize(suffix);
    const keep = c.data.headers.map((h, i) => ({ h: String(h), i })).filter(x => !dropSet.has(lc(x.h)));
    return { label, strategy: (maxPer <= 1 ? 'join' : 'aggregate') as 'join' | 'aggregate', keep, map, total, kIdx, child: c };
  });

  const joins = cms.filter(m => m.strategy === 'join');
  const aggs = cms.filter(m => m.strategy === 'aggregate');

  const headers: string[] = parent.data.headers.map(String);
  joins.forEach(m => m.keep.forEach(x => headers.push(`${m.label}: ${x.h}`)));
  aggs.forEach(m => { const rem = m.keep[0]; if (rem) { headers.push(`${rem.h} Count`); headers.push(`All ${rem.h}s`); } });

  const rows: unknown[][] = [];
  for (const pr of parent.data.rows) {
    const kv = String(pr[pKeyIdx] ?? '').trim();
    if (!kv) continue;
    const row: unknown[] = [...pr];
    joins.forEach(m => {
      const g = m.map.get(kv);
      const first = g ? g[0] : null;
      m.keep.forEach(x => row.push(first ? first[x.i] : null));
    });
    aggs.forEach(m => {
      const g = m.map.get(kv) || [];
      const rem = m.keep[0];
      if (!rem) return;
      const vals = Array.from(new Set(g.map(r => r[rem.i]).filter(v => v != null && String(v).trim() !== '')));
      row.push(g.length);
      row.push(vals.join(', '));
    });
    rows.push(row);
  }

  // Parent key set for orphan/coverage checks.
  const parentKeys = new Set<string>();
  for (const pr of parent.data.rows) {
    const kv = String(pr[pKeyIdx] ?? '').trim();
    if (kv) parentKeys.add(kv);
  }

  const integrity: ChildIntegrity[] = cms.map(m => {
    let orphans = 0;
    const childKeys = Array.from(m.map.keys());
    childKeys.forEach(kv => { if (!parentKeys.has(kv)) orphans += m.map.get(kv)!.length; });
    const covered = childKeys.filter(kv => parentKeys.has(kv)).length;
    return {
      child: m.label,
      rows: m.total,
      orphans,
      parentsCovered: covered,
      parentsTotal: parentKeys.size,
      gaps: parentKeys.size - covered,
      status: orphans === 0 ? 'CLEAN' : 'ORPHANS',
    };
  });

  const childrenData: ChildDetail[] = cms.map(m => ({
    label: m.label,
    headers: m.child.data.headers.map(String),
    rows: m.child.data.rows,
    keyIdx: m.kIdx,
    strategy: m.strategy,
  }));

  const warnings: string[] = [];
  const totalChildRows = cms.reduce((s, m) => s + m.total, 0);
  if (totalChildRows > 250000) {
    warnings.push(`Large dataset: ~${totalChildRows.toLocaleString()} child rows — the workbook may be slow to build.`);
  }
  const badLabels = cms.filter(m => /ocation|nubmer|adress|contect/i.test(m.label));
  badLabels.forEach(m => warnings.push(`Possible filename typo in child "${m.label}".`));

  return {
    bu: buOf(parent.name),
    entityToken: pTok,
    parentName: parent.name,
    key,
    headers, rows,
    children: cms.map(m => ({ label: m.label, strategy: m.strategy, keptCols: m.keep.length, rowCount: m.total })),
    childrenData,
    integrity,
    warnings,
    recordCount: rows.length,
  };
}

export function resultToFileData(r: MergeResult): FileData {
  return { headers: r.headers, rows: r.rows, sheetName: 'Consolidated' };
}

const SHEET_BAD = /[\\/?*[\]:]/g;
function safeSheetName(base: string, used: Set<string>): string {
  const name = (base.replace(SHEET_BAD, '_').slice(0, 31) || 'Sheet');
  let candidate = name, i = 1;
  while (used.has(candidate.toLowerCase())) {
    const suf = `_${i++}`;
    candidate = name.slice(0, 31 - suf.length) + suf;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export interface ValidationWorkbookOpts {
  // If set (sampling), master + detail sheets are filtered to these parent keys.
  selectedKeys?: Set<string>;
  masterSheetName?: string; // 'Master' for a merge download, 'Sample' for sampling
}

// Append a Data Integrity & Coverage sheet plus a detail sheet per many-row
// (aggregate) child to an existing workbook. When `selectedKeys` is given (a
// sampling run), the detail sheets are filtered to the sampled parents.
export function appendValidationSheets(
  wb: XLSX.WorkBook,
  r: MergeResult,
  selectedKeys?: Set<string>,
  used: Set<string> = new Set(wb.SheetNames.map(n => n.toLowerCase()))
): void {
  const allClean = r.integrity.every(i => i.status === 'CLEAN');
  const info: unknown[][] = [
    ['Data Integrity & Coverage'],
    ['Parent', r.entityToken, 'Agency', r.bu, 'Records', r.recordCount],
    [],
    ['Child', 'Rows', 'Orphans', 'Parents covered', 'Parents total', 'Gaps (no child row)', 'Status'],
    ...r.integrity.map(i => [i.child, i.rows, i.orphans, i.parentsCovered, i.parentsTotal, i.gaps, i.status]),
    [],
    ['Verdict', allClean ? 'CLEAN — no orphan child records' : 'ISSUES — child records reference a missing parent (see Orphans)'],
    ['Note', 'Gaps = parent records with no row in that child (e.g. projects with no budget line) — informational, not always an error.'],
    ...r.warnings.map(w => ['Warning', w]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), safeSheetName('Data Integrity', used));

  for (const c of r.childrenData) {
    if (c.strategy !== 'aggregate') continue; // 1:1 children are already in the master
    const rows = selectedKeys
      ? c.rows.filter(row => selectedKeys.has(String(row[c.keyIdx] ?? '').trim()))
      : c.rows;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([c.headers, ...rows]), safeSheetName(c.label, used));
  }
}

// Build a validation-ready workbook: the flattened master, a Data Integrity &
// Coverage sheet, and a detail sheet for each many-row child.
export function buildValidationWorkbook(r: MergeResult, opts: ValidationWorkbookOpts = {}): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const sel = opts.selectedKeys;
  const masterKeyIdx = r.headers.findIndex(h => lc(h) === lc(r.key));

  const masterRows = sel && masterKeyIdx >= 0
    ? r.rows.filter(row => sel.has(String(row[masterKeyIdx] ?? '').trim()))
    : r.rows;
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([r.headers, ...masterRows]),
    safeSheetName(opts.masterSheetName || 'Master', used)
  );

  appendValidationSheets(wb, r, sel, used);
  return wb;
}

export function downloadMaster(r: MergeResult, filename: string): void {
  XLSX.writeFile(buildValidationWorkbook(r, { masterSheetName: 'Master' }), filename);
}
