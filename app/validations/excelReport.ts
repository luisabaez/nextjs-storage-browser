// Styled per-file sampling report (ExcelJS).
//
// The client asked for each source file to appear on its own sheet instead of
// one combined master: a Sample and a Population sheet per file (parent + each
// child), all carrying the same sampled records via the shared Unique ID, with
// that linking column highlighted so the relationships are obvious. Reading is
// still done with `xlsx`; only this final report is written with ExcelJS, which
// (unlike the community `xlsx` build) can write cell colours and bold.

import ExcelJS from 'exceljs';
import type { SampleMeta } from './sampling';
import type { MergeResult, ChildIntegrity } from './merge';

const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Palette (ARGB).
const LINK_FILL = 'FFFEF3C7';   // amber-100 — link column data cells
const LINK_HDR = 'FFFDE68A';    // amber-200 — link column header
const HDR_FILL = 'FFEFF6FF';    // blue-50   — normal header
const HDR_TXT = 'FF1E3A8A';     // blue-900
const LINK_TXT = 'FF92400E';    // amber-800
const NOTE_TXT = 'FF6B7280';    // gray-500
const RULE = 'FFCBD5E1';        // slate-300

export interface ReportFile {
  label: string;               // friendly name (drives the sheet name)
  table: string;               // source table / file name (provenance)
  headers: string[];
  population: unknown[][];
  sample: unknown[][];
  linkIdx: number;             // index of the linking Unique ID column (-1 = none)
  linkName: string;
  role: 'parent' | 'child';
  strategy?: 'join' | 'aggregate';
}

// ── sheet-name helpers ───────────────────────────────────────────────────────
const sanitize = (s: string) => String(s || '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim();

function dataSheetName(label: string, kind: 'Sample' | 'Population', used: Set<string>): string {
  // Sample sheets are just the file label (e.g. "Awards"); Population sheets keep
  // the " Population" suffix so the two are still distinguishable.
  const suffix = kind === 'Population' ? ' Population' : '';
  let lab = sanitize(label) || 'File';
  if (lab.length + suffix.length > 31) lab = lab.slice(0, 31 - suffix.length).trim();
  let name = lab + suffix;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const s = ` ${i++}`;
    name = lab.slice(0, 31 - suffix.length - s.length) + suffix + s;
  }
  used.add(name.toLowerCase());
  return name;
}

function fixedName(name: string, used: Set<string>): string {
  let n = sanitize(name).slice(0, 31);
  let i = 2;
  while (used.has(n.toLowerCase())) n = `${sanitize(name).slice(0, 31 - String(i).length - 1)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
}

// ── cell helpers ─────────────────────────────────────────────────────────────
function cellVal(v: unknown): ExcelJS.CellValue {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return v as ExcelJS.CellValue;
  return String(v);
}

function styleHeaderCell(cell: ExcelJS.Cell, isLink: boolean): void {
  cell.font = { bold: true, color: { argb: isLink ? LINK_TXT : HDR_TXT } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isLink ? LINK_HDR : HDR_FILL } };
  cell.alignment = { vertical: 'middle' };
  cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
}

function highlightLinkCell(cell: ExcelJS.Cell): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LINK_FILL } };
  cell.font = { bold: true };
}

function setWidths(ws: ExcelJS.Worksheet, headers: string[], rows: unknown[][]): void {
  const sample = rows.slice(0, 60);
  for (let c = 0; c < headers.length; c++) {
    let w = String(headers[c] ?? '').length;
    for (const r of sample) {
      const l = r[c] == null ? 0 : String(r[c] instanceof Date ? (r[c] as Date).toISOString().slice(0, 10) : r[c]).length;
      if (l > w) w = l;
    }
    ws.getColumn(c + 1).width = Math.min(46, Math.max(9, w + 2));
  }
}

// One file's Sample or Population sheet, with the link column highlighted.
function writeDataSheet(wb: ExcelJS.Workbook, f: ReportFile, kind: 'Sample' | 'Population', used: Set<string>): void {
  const ws = wb.addWorksheet(dataSheetName(f.label, kind, used));
  const data = kind === 'Sample' ? f.sample : f.population;

  const hdr = ws.addRow(f.headers.map(h => String(h ?? '')));
  for (let c = 1; c <= f.headers.length; c++) styleHeaderCell(hdr.getCell(c), c - 1 === f.linkIdx);
  hdr.height = 17;

  for (const r of data) {
    const row = ws.addRow(f.headers.map((_, i) => cellVal(r[i])));
    if (f.linkIdx >= 0) highlightLinkCell(row.getCell(f.linkIdx + 1));
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  setWidths(ws, f.headers, data);
}

// Overview sheet documenting how the files link (Goal 2).
function relationshipsSheet(wb: ExcelJS.Workbook, files: ReportFile[], meta: SampleMeta, used: Set<string>, hasPopulation: boolean): void {
  const ws = wb.addWorksheet(fixedName('Relationships', used));
  const title = ws.addRow(['File Relationships & Linking Key']);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: HDR_TXT } };
  title.height = 22;
  const sub = ws.addRow([`Entity: ${meta.entity}    Agency: ${meta.agency}    Sample: ${meta.n} of ${meta.N}`]);
  sub.getCell(1).font = { color: { argb: NOTE_TXT } };
  const note = ws.addRow([hasPopulation
    ? 'Every file is on its own Sample and Population sheet. All files link to the parent on the highlighted Unique ID column — the same sampled records are carried across every file by that key.'
    : 'Every file is on its own Sample sheet. All files link to the parent on the highlighted Unique ID column — the same sampled records are carried across every file by that key. The full population for each file is in its linked Conversion File.']);
  note.getCell(1).font = { italic: true, color: { argb: NOTE_TXT } };
  note.alignment = { wrapText: true };
  ws.addRow([]);

  const head = ws.addRow(['File', 'Role', 'Population rows', 'Sampled rows', 'Linking Unique ID', 'Conversion File']);
  for (let c = 1; c <= 6; c++) styleHeaderCell(head.getCell(c), c === 5);
  const headRowNum = head.number;

  for (const f of files) {
    const role = f.role === 'parent' ? 'Parent (sampled)' : `Child (${f.strategy === 'aggregate' ? 'many per parent' : 'one per parent'})`;
    const link = f.role === 'parent' ? `${f.linkName}  (key)` : f.linkName;
    // #8: the conversion file to check against — the CV_ file, blank if unknown.
    const cv = /^CV/i.test(String(f.table || '')) ? f.table : '';
    const row = ws.addRow([f.label, role, f.population.length, f.sample.length, link, cv]);
    highlightLinkCell(row.getCell(5));
  }

  [22, 22, 15, 13, 26, 46].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: headRowNum }];
}

// Sizing / evidence sheet. The label strings match the original writer so the
// Reproduce-by-seed feature can still read N / n / seed back out.
function sizingSheet(wb: ExcelJS.Workbook, meta: SampleMeta, files: ReportFile[], used: Set<string>): void {
  const ws = wb.addWorksheet(fixedName('Sizing', used));
  const rows: unknown[][] = [
    ['Data Validation — Sample Sizing Evidence'],
    [],
    ['Entity', meta.entity],
    ['Agency', meta.agency],
    ['Classification', meta.tier.name],
    ['Confidence interval', meta.tier.confidence],
    ['Z score', meta.tier.Z],
    ['Margin of error tolerable (e)', meta.tier.e],
    ['Expected error rate (p)', meta.tier.p],
    ['Population (N, record count)', meta.N],
    ['Required sample size (n)', meta.n],
    ['Selection method', 'Simple random (seeded, reproducible)'],
    ['Random seed', meta.seed],
    ['Formula', 'n = N*Z^2*p*(1-p) / [ e^2*(N-1) + Z^2*p*(1-p) ]'],
    ['Generated at', meta.generatedAt],
    ['Generated by', meta.generatedBy || ''],
    [],
    ['Files in this workbook', 'Population', 'Sample'],
    ...files.map(f => [f.label, f.population.length, f.sample.length]),
  ];
  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    if (i === 0) row.getCell(1).font = { bold: true, size: 13, color: { argb: HDR_TXT } };
    else if (r[0] === 'Files in this workbook') for (let c = 1; c <= 3; c++) styleHeaderCell(row.getCell(c), false);
    else if (r.length === 2) row.getCell(1).font = { bold: true, color: { argb: 'FF374151' } };
  });
  ws.getColumn(1).width = 32; ws.getColumn(2).width = 16; ws.getColumn(3).width = 12;
}

// Parent/child integrity & coverage (internal copy only).
function integritySheet(wb: ExcelJS.Workbook, integrity: ChildIntegrity[], meta: SampleMeta, used: Set<string>): void {
  const ws = wb.addWorksheet(fixedName('Data Integrity', used));
  const title = ws.addRow(['Data Integrity & Coverage']);
  title.getCell(1).font = { bold: true, size: 13, color: { argb: HDR_TXT } };
  ws.addRow([`Entity: ${meta.entity}    Agency: ${meta.agency}`]).getCell(1).font = { color: { argb: NOTE_TXT } };
  ws.addRow([]);
  const head = ws.addRow(['Child', 'Rows', 'Orphans', 'Parents covered', 'Parents total', 'Gaps (no child row)', 'Status']);
  for (let c = 1; c <= 7; c++) styleHeaderCell(head.getCell(c), false);
  for (const it of integrity) {
    const row = ws.addRow([it.child, it.rows, it.orphans, it.parentsCovered, it.parentsTotal, it.gaps, it.status]);
    if (it.status !== 'CLEAN') row.getCell(7).font = { bold: true, color: { argb: 'FFB91C1C' } };
    else row.getCell(7).font = { color: { argb: 'FF059669' } };
  }
  ws.addRow([]);
  const allClean = integrity.every(i => i.status === 'CLEAN');
  ws.addRow(['Verdict', allClean ? 'CLEAN — no orphan child records' : 'ISSUES — child records reference a missing parent']).getCell(1).font = { bold: true };
  ws.addRow(['Note', 'Gaps = parent records with no row in that child (e.g. projects with no budget line) — informational, not always an error.']).getCell(1).font = { italic: true, color: { argb: NOTE_TXT } };
  [26, 10, 10, 16, 14, 20, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

// Build the full per-file workbook. `includeSizing` gates the internal-only
// Sizing + Data Integrity sheets (the client copy omits them). `includePopulation`
// (default true) gates the per-file Population sheets — the client/server copy
// omits them (the full population lives in the linked Conversion File).
export function buildPerFileReport(
  files: ReportFile[],
  meta: SampleMeta,
  opts: { includeSizing: boolean; includePopulation?: boolean; integrity?: ChildIntegrity[] },
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Validations';
  const used = new Set<string>();
  // Population sheets are removed from every report by request (the team reads full
  // data from the DB); keep only the Sample (+ Sizing/Integrity/Relationships) sheets.
  const withPop = false;

  for (const f of files) writeDataSheet(wb, f, 'Sample', used);
  if (withPop) for (const f of files) writeDataSheet(wb, f, 'Population', used);
  if (opts.includeSizing) sizingSheet(wb, meta, files, used);
  if (opts.includeSizing && opts.integrity?.length) integritySheet(wb, opts.integrity, meta, used);
  if (files.some(f => f.role === 'child')) relationshipsSheet(wb, files, meta, used, withPop); // #2: Relationships last

  return wb;
}

// Split a MergeResult into per-file ReportFiles. The population is taken from the
// master's parent columns (aligned with the sampling indices so a re-draw still
// reproduces); each child's Sample is the rows whose link value is in the sampled
// parent set.
// #3: sampled rows are written in ascending order of the linking Unique ID, the
// same order in every sheet, so row N is the same record across files (natural
// order — "2" before "10", and alphabetical for names). Population keeps its
// original order so a seeded re-draw still reproduces by index.
const cmpByKey = (idx: number) => (a: unknown[], b: unknown[]) =>
  (idx < 0 ? 0 : String(a?.[idx] ?? '').trim().localeCompare(String(b?.[idx] ?? '').trim(), undefined, { numeric: true, sensitivity: 'base' }));

export function mergeResultToReportFiles(r: MergeResult, selectedIndices: number[], parentLabel?: string): ReportFile[] {
  const parentHeaders = r.parentHeaders.map(h => String(h ?? ''));
  const P = parentHeaders.length;
  const popParent = r.rows.map(row => row.slice(0, P));
  const keyIdx = parentHeaders.findIndex(h => h.trim().toLowerCase() === String(r.key).trim().toLowerCase());

  const sampleParent = selectedIndices.map(i => popParent[i]).filter((x): x is unknown[] => Array.isArray(x));
  if (keyIdx >= 0) sampleParent.sort(cmpByKey(keyIdx));
  const selKeys = new Set<string>();
  if (keyIdx >= 0) {
    for (const i of selectedIndices) {
      const v = String(popParent[i]?.[keyIdx] ?? '').trim();
      if (v) selKeys.add(v);
    }
  }
  const matches = (cell: unknown): boolean => {
    const s = String(cell ?? '').trim();
    if (!s) return false;
    if (selKeys.has(s)) return true;
    return s.includes(',') && s.split(',').some(p => selKeys.has(p.trim()));
  };

  const files: ReportFile[] = [{
    label: parentLabel || r.entityToken || 'Master',
    table: r.parentName || '',           // #8: the parent CV_ conversion file
    headers: parentHeaders,
    population: popParent,
    sample: sampleParent,
    linkIdx: keyIdx,
    linkName: String(r.key),
    role: 'parent',
  }];

  for (const c of r.childrenData) {
    const headers = c.headers.map(h => String(h ?? ''));
    const sample = selKeys.size ? c.rows.filter(row => matches(row[c.keyIdx])) : [];
    if (c.keyIdx >= 0) sample.sort(cmpByKey(c.keyIdx));
    files.push({
      label: c.label,
      table: c.sourceFile || '',         // #8: the child CV_ conversion file (blank if unknown)
      headers,
      population: c.rows,
      sample,
      linkIdx: c.keyIdx,
      linkName: String(headers[c.keyIdx] ?? r.key),
      role: 'child',
      strategy: c.strategy,
    });
  }
  return files;
}

// A single (unmerged) file → one parent ReportFile, no child links.
export function singleFileReport(label: string, table: string, headers: unknown[], rows: unknown[][], selectedIndices: number[]): ReportFile {
  return {
    label,
    table,
    headers: headers.map(h => String(h ?? '')),
    population: rows,
    sample: selectedIndices.map(i => rows[i]).filter((x): x is unknown[] => Array.isArray(x)),
    linkIdx: -1,
    linkName: '',
    role: 'parent',
  };
}

// ── Per-run tracking report ──────────────────────────────────────────────────
// One workbook per sampling run, written to Sampling/Reports/, so a suspect
// record can be traced to exactly where it came from: the run parameters (who,
// when, seed, where the files landed), the sampling configuration for the entity,
// and the merge provenance + integrity of the source files.
export interface TrackingRunInfo {
  entity: string;
  agency: string;
  mock: string;
  tierName: string;
  confidence: number;
  Z: number;
  e: number;
  p: number;
  N: number;
  n: number;
  seed: number;
  generatedAt: string; // ISO
  generatedBy: string;
  sampleFile: string;
  localPath: string;
  clientPath: string;
  reportPath: string;
  serverPath?: string;   // where the client copy landed on the SQL Server box
  serverStatus?: string; // SSM publish status (Success / Failed / Pending / …)
}

export function buildTrackingReport(
  run: TrackingRunInfo,
  config: { headers: string[]; rows: unknown[][] } | null,
  merged?: MergeResult,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Validations';
  const used = new Set<string>();

  // 1. Run Info — who / when / seed / sizing / where the files landed.
  const info = wb.addWorksheet(fixedName('Run Info', used));
  const title = info.addRow(['Sampling Run — Tracking Report']);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: HDR_TXT } };
  title.height = 22;
  info.addRow([]);
  const iso = run.generatedAt || '';
  const kv: unknown[][] = [
    ['Entity', run.entity],
    ['Agency / BU', run.agency],
    ['Mock', run.mock],
    ['Run date', iso.slice(0, 10)],
    ['Run time (UTC)', iso.slice(11, 19)],
    ['Run by', run.generatedBy],
    ['Classification', run.tierName],
    ['Confidence interval', run.confidence],
    ['Z score', run.Z],
    ['Margin of error tolerable (e)', run.e],
    ['Expected error rate (p)', run.p],
    ['Population (N)', run.N],
    ['Sample size (n)', run.n],
    ['Random seed', run.seed],
    ['Selection method', 'Simple random (seeded, reproducible)'],
    ['Formula', 'n = N*Z^2*p*(1-p) / [ e^2*(N-1) + Z^2*p*(1-p) ]'],
    [],
    ['Sample file', run.sampleFile],
    ['Local copy (full)', run.localPath],
    ['Client copy', run.clientPath],
    ['Server copy (ToPublish)', run.serverPath || ''],
    ['Server publish status', run.serverStatus || ''],
    ['This report', run.reportPath],
  ];
  for (const r of kv) {
    const row = info.addRow(r.map(cellVal));
    if (r.length >= 2 && r[0]) row.getCell(1).font = { bold: true, color: { argb: 'FF374151' } };
  }
  info.getColumn(1).width = 30;
  info.getColumn(2).width = 74;

  // 2. Configuration — the sampling config rows for this entity, verbatim.
  const cfg = wb.addWorksheet(fixedName('Configuration', used));
  if (config && config.headers.length) {
    const hdr = cfg.addRow(config.headers.map(h => String(h ?? '')));
    for (let c = 1; c <= config.headers.length; c++) styleHeaderCell(hdr.getCell(c), false);
    for (const r of config.rows) cfg.addRow(config.headers.map((_, i) => cellVal(r[i])));
    cfg.views = [{ state: 'frozen', ySplit: 1 }];
    setWidths(cfg, config.headers.map(String), config.rows);
    if (!config.rows.length) cfg.addRow(['(no configuration rows matched this entity)']).getCell(1).font = { italic: true, color: { argb: NOTE_TXT } };
  } else {
    cfg.addRow(['Sampling configuration not loaded — seed Sampling/_status/sampling_config_<mock>.xlsx.']).getCell(1).font = { italic: true, color: { argb: NOTE_TXT } };
  }

  // 3. Source & Integrity — the merge provenance (traceability + coverage).
  if (merged) {
    const prov = wb.addWorksheet(fixedName('Source & Integrity', used));
    prov.addRow(['Where this sample came from']).getCell(1).font = { bold: true, size: 13, color: { argb: HDR_TXT } };
    prov.addRow([]);
    const src: unknown[][] = [
      ['Parent file', merged.parentName],
      ['Parent entity token', merged.entityToken],
      ['Linking Unique ID', merged.key],
      ['Parent records (N)', merged.recordCount],
      ['BU', merged.bu],
    ];
    for (const r of src) { const row = prov.addRow(r.map(cellVal)); row.getCell(1).font = { bold: true, color: { argb: 'FF374151' } }; }
    prov.addRow([]);
    const h = prov.addRow(['Child file', 'Join', 'Rows', 'Orphans', 'Parents covered', 'Parents total', 'Gaps', 'Integrity']);
    for (let c = 1; c <= 8; c++) styleHeaderCell(h.getCell(c), false);
    const integ = new Map(merged.integrity.map(i => [i.child, i]));
    for (const ci of merged.children) {
      const it = integ.get(ci.label);
      const row = prov.addRow([ci.label, ci.strategy, it ? it.rows : ci.rowCount, it ? it.orphans : '', it ? it.parentsCovered : '', it ? it.parentsTotal : '', it ? it.gaps : '', it ? it.status : ''].map(cellVal));
      if (it && it.status !== 'CLEAN') row.getCell(8).font = { bold: true, color: { argb: 'FFB91C1C' } };
      else if (it) row.getCell(8).font = { color: { argb: 'FF059669' } };
    }
    if (merged.warnings.length) {
      prov.addRow([]);
      prov.addRow(['Flags']).getCell(1).font = { bold: true, color: { argb: 'FFB45309' } };
      for (const w of merged.warnings) prov.addRow(['', w].map(cellVal));
    }
    [30, 12, 10, 10, 16, 14, 10, 12].forEach((w, i) => { prov.getColumn(i + 1).width = w; });
  }

  return wb;
}

// Serialize for upload to S3.
export async function reportToBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}

// Trigger a browser download.
export async function downloadReport(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: XLSX_CT }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
