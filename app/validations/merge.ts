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

// ── Relationship-aware merge ─────────────────────────────────────────────────
// Instead of guessing parent/key/children from filenames, use the authoritative
// parent→child + link-field graph (the sampling_targets config) plus the real
// (table, source) of each generated file (from the generation manifest). Files
// are grouped by their real source; within a source the configured target is the
// root, each of its DIRECT children is joined/aggregated on the *configured* link
// field (resolved to a real column), and anything not a direct child of the root
// (grandchildren / unrelated) is flagged in warnings rather than mis-merged.

export interface TargetChild { table: string; link_field: string; }
export interface SamplingTarget { table: string; display: string; children: TargetChild[]; }
export interface TaggedFile { name: string; data: FileData; table?: string; source?: string; bu?: string; }

const normTable = (s: string) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function shortTable(t: string): string {
  return t.replace(/_MOCK\d+.*$/i, '').replace(/_VW.*$/i, '');
}

// Readable child label: the child table's tokens after the prefix it shares with
// the root (SCM_SUPPLIER_ADDRESSES vs SCM_SUPPLIER → "Address"; AR LINES vs
// DISTRIBUTION → "Distribution"), reusing the curated label map.
function childLabel(rootTable: string, childTable: string): string {
  const rtok = shortTable(rootTable).toUpperCase().split('_').filter(Boolean);
  const ctok = shortTable(childTable).toUpperCase().split('_').filter(Boolean);
  let i = 0;
  while (i < rtok.length && i < ctok.length && rtok[i] === ctok[i]) i++;
  const suffix = (ctok.slice(i).join('_') || ctok[ctok.length - 1] || '').toUpperCase();
  return LABEL_MAP[suffix] || titleize(suffix);
}

// Resolve a business-key name ("Award Number") to a real column index — mirror of
// the Lambda's resolve_link_column: normalized exact match, else best substring.
function resolveLinkCol(headers: string[], linkField: string): number {
  const nl = normTable(linkField);
  if (!nl) return -1;
  const norm = headers.map(h => normTable(h));
  const exact = norm.findIndex(h => h === nl);
  if (exact >= 0) return exact;
  let best = -1, bestLen = Infinity;
  for (let k = 0; k < norm.length; k++) {
    if (norm[k] && (nl.includes(norm[k]) || norm[k].includes(nl)) && headers[k].length < bestLen) {
      best = k; bestLen = headers[k].length;
    }
  }
  return best;
}

interface RelChild {
  label: string;
  headers: string[];
  rows: unknown[][];
  parentLinkIdxs: number[]; // parent columns the child links on (1 = single, >1 = composite)
  childLinkIdxs: number[];  // matching child columns carrying the link value
}

// Composite link value: the link columns joined so a multi-part key (e.g.
// Business Unit + Invoice Number) matches as a tuple. Empty when all parts blank.
function linkKeyOf(row: unknown[], idxs: number[]): string {
  const parts = idxs.map(i => String(row[i] ?? '').trim());
  return parts.some(p => p !== '') ? parts.join('') : '';
}

// Build one MergeResult from an explicit parent + explicitly-linked children.
// Same join/aggregate/integrity output as mergeGroup, but each child links on its
// own set of (parent col, child col) pairs — one pair for a simple key, several
// for a composite key.
function assembleMaster(
  parentName: string, bu: string, entityToken: string,
  parentHeaders: string[], parentRows: unknown[][],
  keyName: string, keyIdx: number,
  relChildren: RelChild[], extraWarnings: string[],
): MergeResult {
  interface CM {
    label: string; strategy: 'join' | 'aggregate';
    keep: { h: string; i: number }[];
    map: Map<string, unknown[][]>;
    total: number; parentLinkIdxs: number[]; childLinkIdxs: number[];
    headers: string[]; rows: unknown[][];
  }
  const cms: CM[] = relChildren.map(c => {
    const dropSet = new Set([...c.childLinkIdxs.map(i => lc(c.headers[i])), ...CONTEXT_COLS]);
    const map = new Map<string, unknown[][]>();
    let maxPer = 0, total = 0;
    for (const r of c.rows) {
      const kv = linkKeyOf(r, c.childLinkIdxs);
      if (!kv) continue;
      const arr = map.get(kv) || [];
      arr.push(r); map.set(kv, arr); total++;
      if (arr.length > maxPer) maxPer = arr.length;
    }
    const keep = c.headers.map((h, i) => ({ h: String(h), i })).filter(x => !dropSet.has(lc(x.h)));
    return {
      label: c.label, strategy: (maxPer <= 1 ? 'join' : 'aggregate') as 'join' | 'aggregate',
      keep, map, total, parentLinkIdxs: c.parentLinkIdxs, childLinkIdxs: c.childLinkIdxs,
      headers: c.headers, rows: c.rows,
    };
  });

  const joins = cms.filter(m => m.strategy === 'join');
  const aggs = cms.filter(m => m.strategy === 'aggregate');

  const headers: string[] = parentHeaders.map(String);
  joins.forEach(m => m.keep.forEach(x => headers.push(`${m.label}: ${x.h}`)));
  aggs.forEach(m => { const rem = m.keep[0]; if (rem) { headers.push(`${rem.h} Count`); headers.push(`All ${rem.h}s`); } });

  const rows: unknown[][] = [];
  for (const pr of parentRows) {
    const kv = String(pr[keyIdx] ?? '').trim();
    if (!kv) continue;
    const row: unknown[] = [...pr];
    joins.forEach(m => {
      const lv = linkKeyOf(pr, m.parentLinkIdxs);
      const g = lv ? m.map.get(lv) : null;
      const first = g ? g[0] : null;
      m.keep.forEach(x => row.push(first ? first[x.i] : null));
    });
    aggs.forEach(m => {
      const lv = linkKeyOf(pr, m.parentLinkIdxs);
      const g = (lv ? m.map.get(lv) : null) || [];
      const rem = m.keep[0];
      if (!rem) return;
      const vals = Array.from(new Set(g.map(r => r[rem.i]).filter(v => v != null && String(v).trim() !== '')));
      row.push(g.length);
      row.push(vals.join(', '));
    });
    rows.push(row);
  }

  const integrity: ChildIntegrity[] = cms.map(m => {
    const parentVals = new Set<string>();
    for (const pr of parentRows) {
      const v = linkKeyOf(pr, m.parentLinkIdxs);
      if (v) parentVals.add(v);
    }
    let orphans = 0;
    const childKeys = Array.from(m.map.keys());
    childKeys.forEach(kv => { if (!parentVals.has(kv)) orphans += m.map.get(kv)!.length; });
    const covered = childKeys.filter(kv => parentVals.has(kv)).length;
    return {
      child: m.label, rows: m.total, orphans,
      parentsCovered: covered, parentsTotal: parentVals.size,
      gaps: parentVals.size - covered, status: orphans === 0 ? 'CLEAN' : 'ORPHANS',
    };
  });

  const childrenData: ChildDetail[] = cms.map(m => ({
    label: m.label, headers: m.headers.map(String), rows: m.rows,
    keyIdx: m.childLinkIdxs[0], strategy: m.strategy,
  }));

  const warnings = [...extraWarnings];
  const totalChildRows = cms.reduce((s, m) => s + m.total, 0);
  if (totalChildRows > 250000) {
    warnings.push(`Large dataset: ~${totalChildRows.toLocaleString()} child rows — the workbook may be slow to build.`);
  }

  return {
    bu, entityToken, parentName, key: keyName,
    headers, rows,
    children: cms.map(m => ({ label: m.label, strategy: m.strategy, keptCols: m.keep.length, rowCount: m.total })),
    childrenData, integrity, warnings, recordCount: rows.length,
  };
}

// Resolve the fields of a (possibly composite) key to column pairs, keeping only
// the parts that resolve on BOTH parent and child.
function resolveParts(parentHeaders: string[], childHeaders: string[], fields: string[]): { pIdxs: number[]; cIdxs: number[] } {
  const pIdxs: number[] = [], cIdxs: number[] = [];
  for (const f of fields) {
    const p = resolveLinkCol(parentHeaders, f);
    const c = resolveLinkCol(childHeaders, f);
    if (p >= 0 && c >= 0) { pIdxs.push(p); cIdxs.push(c); }
  }
  return { pIdxs, cIdxs };
}

// keyOverrides: normalized root table → the entity's composite key fields (from
// the validation report). A child that links via the entity key (its configured
// link_field matches one of the key parts) is then joined on the full composite
// key rather than the single field, so e.g. AP lines match on Business Unit +
// Invoice Number instead of Invoice Number alone (which would cross BUs).
export function mergeByRelationships(
  files: TaggedFile[],
  targets: SamplingTarget[],
  keyOverrides?: Map<string, string[]>,
): MergeResult[] {
  const targetSet = new Set(targets.map(t => normTable(t.table)));
  const displayOf = new Map(targets.map(t => [normTable(t.table), t.display] as const));
  const childLink = new Map<string, Map<string, string>>(); // normParent -> normChild -> link_field
  targets.forEach(t => {
    const m = new Map<string, string>();
    t.children.forEach(c => m.set(normTable(c.table), c.link_field));
    childLink.set(normTable(t.table), m);
  });

  const bySource = new Map<string, TaggedFile[]>();
  for (const f of files) {
    const s = (f.source || '').trim() || '(none)';
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s)!.push(f);
  }

  const results: MergeResult[] = [];
  for (const src of Array.from(bySource.keys()).sort()) {
    const group = bySource.get(src)!;
    const rootFile = group.find(f => f.table && targetSet.has(normTable(f.table)));

    // No configured target in this source group → fall back to the filename heuristic.
    if (!rootFile) {
      for (const g of groupRawFiles(group.map(f => ({ name: f.name, data: f.data })))) {
        try { results.push(mergeGroup(g)); } catch { /* skip */ }
      }
      continue;
    }

    const normRoot = normTable(rootFile.table!);
    const kids = childLink.get(normRoot) || new Map<string, string>();
    const composite = keyOverrides?.get(normRoot) || null; // entity composite key parts (>1)
    const compositeNorms = (composite && composite.length > 1) ? composite.map(normTable) : null;
    const warnings: string[] = [];
    const relChildren: RelChild[] = [];
    const parentLinkCount = new Map<number, number>();
    const rootHeaders = rootFile.data.headers.map(String);
    const rootLabel = displayOf.get(normRoot) || shortTable(rootFile.table!);

    for (const f of group) {
      if (f === rootFile) continue;
      const nt = f.table ? normTable(f.table) : '';
      const linkField = nt ? kids.get(nt) : undefined;
      if (!linkField) {
        warnings.push(`${f.name} — not a configured direct child of ${rootLabel}; not merged (multi-level or unrelated).`);
        continue;
      }
      const childHeaders = f.data.headers.map(String);

      // Use the composite key when this child links via the entity key (its
      // configured field matches one of the composite parts); else the single field.
      let pIdxs: number[] = [], cIdxs: number[] = [];
      const nlf = normTable(linkField);
      if (compositeNorms && compositeNorms.some(p => p.includes(nlf) || nlf.includes(p))) {
        const r = resolveParts(rootHeaders, childHeaders, composite!);
        pIdxs = r.pIdxs; cIdxs = r.cIdxs;
      }
      if (!pIdxs.length) {
        const pIdx = resolveLinkCol(rootHeaders, linkField);
        const cIdx = resolveLinkCol(childHeaders, linkField);
        if (pIdx >= 0 && cIdx >= 0) { pIdxs = [pIdx]; cIdxs = [cIdx]; }
      }
      if (!pIdxs.length) {
        warnings.push(`${f.name} — could not resolve link column "${linkField}"; not merged.`);
        continue;
      }
      relChildren.push({
        label: childLabel(rootFile.table!, f.table!),
        headers: childHeaders, rows: f.data.rows,
        parentLinkIdxs: pIdxs, childLinkIdxs: cIdxs,
      });
      parentLinkCount.set(pIdxs[0], (parentLinkCount.get(pIdxs[0]) || 0) + 1);
    }

    // Primary key = the parent column most children link on (else first column).
    const keyIdx = parentLinkCount.size
      ? Array.from(parentLinkCount.entries()).sort((a, b) => b[1] - a[1])[0][0]
      : 0;
    results.push(assembleMaster(
      rootFile.name, src === '(none)' ? '' : src, rootLabel,
      rootHeaders, rootFile.data.rows,
      String(rootHeaders[keyIdx] ?? 'Key'), keyIdx, relChildren, warnings,
    ));
  }
  return results;
}
