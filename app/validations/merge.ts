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

export interface MergeResult {
  bu: string;
  entityToken: string;
  parentName: string;
  key: string;
  headers: string[];
  rows: unknown[][];
  children: ChildInfo[];
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
    return { label, strategy: maxPer <= 1 ? 'join' : 'aggregate', keep, map, total };
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

  return {
    bu: buOf(parent.name),
    entityToken: pTok,
    parentName: parent.name,
    key,
    headers, rows,
    children: cms.map(m => ({ label: m.label, strategy: m.strategy, keptCols: m.keep.length, rowCount: m.total })),
    recordCount: rows.length,
  };
}

export function resultToFileData(r: MergeResult): FileData {
  return { headers: r.headers, rows: r.rows, sheetName: 'Consolidated' };
}

export function downloadMaster(r: MergeResult, filename: string): void {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([r.headers, ...r.rows]), 'Consolidated');
  XLSX.writeFile(wb, filename);
}
