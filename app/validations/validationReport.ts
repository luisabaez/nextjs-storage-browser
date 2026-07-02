// Parser for the Multi-Agency Entity Validation Report
// (Entity_Validation_Report_WATrev.xlsx). One sheet per entity + an Index. For
// each entity it defines, per agency: the linking key, the expected files
// (master + children) with expected row/unique counts, and the child/parent
// integrity (orphans / missing). This is the ground-truth used to confirm all
// expected files are present (and sound) before sampling. Metadata only — no
// record data. Read entirely in the browser.

import * as XLSX from 'xlsx';
import { SamplingTarget } from './merge';

const normName = (s: string) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Word tokens, singularized (trailing "s" dropped) for forgiving matching.
function tokensOf(s: string): string[] {
  return String(s || '').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(t => t.toUpperCase().replace(/S$/, '')).filter(t => t.length > 1);
}

export interface FileCount { rows: number; unique: number; }
export interface ExpectedFile {
  label: string;
  role: 'master' | 'child';
  counts: Record<string, FileCount | 'N/A' | null>; // per agency
}
export interface IntegrityRow {
  child: string;
  perAgency: Record<string, { orphans: number; missing: number } | null>;
  status: string;
}
export type ReportStatus = 'CLEAN' | 'PARTIAL COVERAGE' | 'ORPHANS' | 'STANDALONE' | string;

export interface EntityValidation {
  tab: string;
  entity: string;
  key: string;
  keyParts: string[];          // composite key split into fields (BU + Invoice Number -> [BU, Invoice Number])
  howItLinks: string;
  agencies: string[];          // present-in agencies (the count columns)
  notApplicable: string[];
  files: ExpectedFile[];
  integrity: IntegrityRow[];
  notes: string[];
  verdict: string;
  status: ReportStatus;
}

export interface ValidationReport {
  scope: string;
  agencies: string[];          // union across the report (from the Index)
  entities: EntityValidation[];
}

type Row = unknown[];
const s = (v: unknown) => (v == null ? '' : String(v)).trim();
const lc = (v: unknown) => s(v).toLowerCase();

function splitList(v: string): string[] {
  const t = v.trim();
  if (!t || /^none$/i.test(t)) return [];
  return t.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

// "Business Unit + Invoice Number", "Legacy Invoice Number + Line Number",
// "(Organization, Item)" -> the individual key fields. Strips prose qualifiers
// after a slash ("Requisition Number/DOE only") and parentheses.
export function splitKey(key: string): string[] {
  let t = key.replace(/\([^)]*\)/g, m => m.slice(1, -1)); // keep inside of parens
  t = t.split('/')[0];                                    // drop "/DOE only" qualifiers
  return t.split(/\s*(?:\+|,)\s*/).map(x => x.trim()).filter(Boolean);
}

// "1,333 rows / 1,333 unique" -> {rows, unique}; "N/A" -> 'N/A'; "—"/"" -> null.
function parseCount(v: string): FileCount | 'N/A' | null {
  const t = v.trim();
  if (!t || t === '—' || t === '-') return null;
  if (/^n\/?a$/i.test(t)) return 'N/A';
  const m = t.match(/([\d,]+)\s*rows?\s*\/\s*([\d,]+)\s*unique/i);
  if (m) return { rows: +m[1].replace(/,/g, ''), unique: +m[2].replace(/,/g, '') };
  const n = t.match(/([\d,]+)/);
  return n ? { rows: +n[1].replace(/,/g, ''), unique: +n[1].replace(/,/g, '') } : null;
}

// "0 / 9" -> {orphans:0, missing:9}; "—" -> null.
function parseIntegrity(v: string): { orphans: number; missing: number } | null {
  const t = v.trim();
  if (!t || t === '—' || t === '-') return null;
  const m = t.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
  if (!m) return null;
  return { orphans: +m[1].replace(/,/g, ''), missing: +m[2].replace(/,/g, '') };
}

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, blankrows: false, defval: null });
}

// Find the row index whose first cell (lowercased) starts with `label`.
function findRow(rows: Row[], label: string, from = 0): number {
  const l = label.toLowerCase();
  for (let i = from; i < rows.length; i++) if (lc(rows[i][0]).startsWith(l)) return i;
  return -1;
}

function parseEntitySheet(wb: XLSX.WorkBook, tab: string, indexStatus: string): EntityValidation {
  const rows = sheetRows(wb, tab);
  const title = s(rows[0]?.[0]);
  const entity = title.split('—')[0].trim() || tab;

  const valueAfter = (label: string): string => {
    const i = findRow(rows, label);
    return i >= 0 ? s(rows[i][1]) : '';
  };
  const key = valueAfter('key:');
  const howItLinks = valueAfter('how it links');
  const agenciesPresent = splitList(valueAfter('present in agencies'));
  const notApplicable = splitList(valueAfter('not applicable'));

  // Row Counts per Agency — the "File | ag | ag ..." header names the agency columns.
  const files: ExpectedFile[] = [];
  let agencyCols: { agency: string; col: number }[] = [];
  const rcStart = findRow(rows, 'row counts per agency');
  const fileHdr = findRow(rows, 'file', rcStart >= 0 ? rcStart : 0);
  if (fileHdr >= 0) {
    for (let c = 1; c < rows[fileHdr].length; c++) {
      const a = s(rows[fileHdr][c]);
      if (a) agencyCols.push({ agency: a, col: c });
    }
    for (let r = fileHdr + 1; r < rows.length; r++) {
      const label = s(rows[r][0]);
      if (!label) continue;
      if (/^child vs parent integrity$/i.test(label) || /^notes$/i.test(label)) break;
      const counts: Record<string, FileCount | 'N/A' | null> = {};
      agencyCols.forEach(({ agency, col }) => { counts[agency] = parseCount(s(rows[r][col])); });
      const role: 'master' | 'child' = /master|parent|header|standalone/i.test(label) || files.length === 0 ? 'master' : 'child';
      files.push({ label: cleanFileLabel(label), role, counts });
    }
  }

  // Child vs Parent Integrity — "Child File | ag (orphans / missing) ... | Status".
  const integrity: IntegrityRow[] = [];
  const intStart = findRow(rows, 'child vs parent integrity');
  const intHdr = findRow(rows, 'child file', intStart >= 0 ? intStart : 0);
  if (intHdr >= 0) {
    const cols: { agency: string; col: number }[] = [];
    let statusCol = -1;
    for (let c = 1; c < rows[intHdr].length; c++) {
      const h = s(rows[intHdr][c]);
      if (/status/i.test(h)) { statusCol = c; continue; }
      const m = h.match(/^(\S+)/);
      if (m) cols.push({ agency: m[1], col: c });
    }
    for (let r = intHdr + 1; r < rows.length; r++) {
      const child = s(rows[r][0]);
      if (!child) continue;
      if (/^notes$/i.test(child) || /^overall verdict$/i.test(child)) break;
      const perAgency: Record<string, { orphans: number; missing: number } | null> = {};
      cols.forEach(({ agency, col }) => { perAgency[agency] = parseIntegrity(s(rows[r][col])); });
      const status = statusCol >= 0 ? s(rows[r][statusCol]) : '';
      integrity.push({ child: cleanFileLabel(child), perAgency, status });
    }
  }

  // Notes + Verdict.
  const notes: string[] = [];
  const notesStart = findRow(rows, 'notes');
  const verdictStart = findRow(rows, 'overall verdict');
  if (notesStart >= 0) {
    const end = verdictStart >= 0 ? verdictStart : rows.length;
    for (let r = notesStart + 1; r < end; r++) {
      const n = s(rows[r][0]);
      if (n && !/^no special notes/i.test(n)) notes.push(n);
    }
  }
  const verdict = verdictStart >= 0 ? s(rows[verdictStart + 1]?.[0]) : '';

  const status = (indexStatus || inferStatus(integrity, files)) as ReportStatus;
  return {
    tab, entity, key, keyParts: splitKey(key), howItLinks,
    agencies: agenciesPresent.length ? agenciesPresent : agencyCols.map(a => a.agency),
    notApplicable, files, integrity, notes, verdict, status,
  };
}

// Strip the "(Master)"/"(Header)"/"(Parent)"/"(Standalone)" role suffix from a
// file label for a clean name; keep the base.
function cleanFileLabel(label: string): string {
  return label.replace(/\s*\((master|parent|header|standalone)\)\s*/i, '').trim();
}

function inferStatus(integrity: IntegrityRow[], files: ExpectedFile[]): ReportStatus {
  if (!integrity.length) return files.length ? 'STANDALONE' : '';
  if (integrity.some(i => /orphan/i.test(i.status))) return 'ORPHANS';
  if (integrity.some(i => /partial/i.test(i.status))) return 'PARTIAL COVERAGE';
  return 'CLEAN';
}

export function parseValidationReport(buf: ArrayBuffer): ValidationReport {
  const wb = XLSX.read(buf, { type: 'array' });
  const index = sheetRows(wb, wb.SheetNames.find(n => /index/i.test(n)) || wb.SheetNames[0]);

  let scope = '';
  const statusByTab: Record<string, string> = {};
  const tabOrder: string[] = [];
  // Index: a header row "Tab | Entity | Common Denominator | Agencies | Overall Status".
  const hdr = index.findIndex(r => /^tab$/i.test(s(r[0])));
  for (let r = 0; r < index.length; r++) {
    const first = s(index[r][0]);
    if (/^scope:/i.test(first)) scope = first;
    if (hdr >= 0 && r > hdr) {
      if (/^legend/i.test(first) || !first) { if (/^legend/i.test(first)) break; else continue; }
      tabOrder.push(first);
      statusByTab[first] = s(index[r][4]);
    }
  }

  const entityTabs = wb.SheetNames.filter(n => !/index/i.test(n));
  const ordered = tabOrder.filter(t => entityTabs.includes(t))
    .concat(entityTabs.filter(t => !tabOrder.includes(t)));
  const entities = ordered.map(tab => parseEntitySheet(wb, tab, statusByTab[tab] || ''));
  const agencies = Array.from(new Set(entities.flatMap(e => e.agencies))).sort();
  return { scope, agencies, entities };
}

// Does a report file label (e.g. "Bank Accounts") correspond to a generated
// table (e.g. "SCM_SUPPLIER_BANK_ACCOUNTS_MOCK14_VW_TBL")? True when every
// (singularized) word of the label appears in the table name.
export function fileMatchesTable(label: string, table: string): boolean {
  const t = normName(table);
  const toks = tokensOf(label);
  return toks.length > 0 && toks.every(tok => t.includes(tok));
}

// Map each report entity that has a COMPOSITE key to its root sampling target
// table, so the relationship merge can join that entity's children on the full
// key. Keyed by the normalized root table name (what mergeByRelationships uses).
export function buildCompositeKeyOverrides(
  report: ValidationReport,
  targets: SamplingTarget[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of report.entities) {
    if (e.keyParts.length < 2) continue;
    const master = e.files.find(f => f.role === 'master');
    const candidates = [master?.label, e.entity, e.tab].filter(Boolean) as string[];
    // Find the target whose display/table shares the most word tokens with a candidate.
    let best: { table: string; score: number } | null = null;
    for (const t of targets) {
      const tTokens = new Set([...tokensOf(t.display), ...tokensOf(t.table)]);
      for (const cand of candidates) {
        const ct = tokensOf(cand);
        const score = ct.filter(x => tTokens.has(x)).length;
        if (ct.length && score === ct.length && (!best || score > best.score)) {
          best = { table: t.table, score };
        }
      }
    }
    if (best) out.set(normName(best.table), e.keyParts);
  }
  return out;
}
