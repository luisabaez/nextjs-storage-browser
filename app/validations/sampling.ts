// Client-side record sampling for the ERP conversion validation effort.
//
// The consolidated master file (one per agency, provided by the team / later
// pulled from SharePoint) is read, sized, and sampled entirely in the browser —
// the supplier/record data never leaves the user's machine. Sizing follows the
// Data Validation Framework V2 (Cochran attribute sampling with finite-population
// correction); selection is simple random with a recorded seed for reproducibility.

import * as XLSX from 'xlsx';

export interface Tier {
  name: string;
  confidence: number;
  Z: number;
  e: number; // margin of error tolerable (TER)
  p: number; // expected error rate
}

// Framework V2 classification parameters.
export const TIERS: Record<string, Tier> = {
  HIGH:     { name: 'HIGH',     confidence: 0.99, Z: 2.3263, e: 0.01, p: 0.0025 },
  MODERATE: { name: 'MODERATE', confidence: 0.95, Z: 1.6449, e: 0.05, p: 0.05 },
  LOW:      { name: 'LOW',      confidence: 0.90, Z: 1.2816, e: 0.07, p: 0.05 },
  AUTO:     { name: 'AUTO',     confidence: 0.85, Z: 1.0364, e: 0.10, p: 0.005 },
};

// Data-entity classification from the V2 framework.
export const ENTITY_CLASSIFICATION: Record<string, keyof typeof TIERS> = {
  'AP INVOICES': 'MODERATE',
  'AWARDS': 'HIGH',
  'GL BUDGET BALANCES': 'HIGH',
  'REVENUE BUDGET': 'HIGH',
  'BLANKET PURCHASE AGREEMENTS': 'MODERATE',
  'PURCHASE ORDERS': 'MODERATE',
  'REQUISITION': 'MODERATE',
  'ASSETS': 'AUTO',
  'SUPPLIERS': 'LOW',
  'INVENTORY': 'AUTO',
  'LOCATION': 'LOW',
  'CUSTOMER': 'LOW',
  'AR': 'LOW',
  'PEOPLE SOFT ITEMS': 'LOW',
};

export const ENTITY_NAMES = Object.keys(ENTITY_CLASSIFICATION);

export function tierForEntity(entity: string): Tier | null {
  const key = ENTITY_CLASSIFICATION[entity];
  return key ? TIERS[key] : null;
}

// Cochran sample size with finite-population correction (Framework V2):
//   n = N·Z²·p·(1−p) / [ e²·(N−1) + Z²·p·(1−p) ]
// Rounded up to whole records and capped at the population.
export function computeSampleSize(N: number, tier: Tier): number {
  if (!N || N <= 0) return 0;
  const zpq = tier.Z * tier.Z * tier.p * (1 - tier.p);
  const n = (N * zpq) / (tier.e * tier.e * (N - 1) + zpq);
  return Math.min(N, Math.max(1, Math.ceil(n)));
}

// ── Entity / agency inference from the filename ──────────────────────────────

function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const NORM_TO_ENTITY: Record<string, string> = Object.fromEntries(
  ENTITY_NAMES.map(e => [norm(e), e])
);

const SYNONYMS: Record<string, string> = {
  SUPPLIER: 'SUPPLIERS',
  PO: 'PURCHASE ORDERS',
  POS: 'PURCHASE ORDERS',
  BPA: 'BLANKET PURCHASE AGREEMENTS',
  REQ: 'REQUISITION',
  REQUISITIONS: 'REQUISITION',
  APINVOICE: 'AP INVOICES',
  APINVOICES: 'AP INVOICES',
  GLBUDGETBALANCE: 'GL BUDGET BALANCES',
  GLBUDGETBALANCES: 'GL BUDGET BALANCES',
  PEOPLESOFTITEMS: 'PEOPLE SOFT ITEMS',
};

export function matchEntity(text: string): string | null {
  const n = norm(text);
  if (!n) return null;
  if (NORM_TO_ENTITY[n]) return NORM_TO_ENTITY[n];
  if (SYNONYMS[n]) return SYNONYMS[n];
  for (const [nk, e] of Object.entries(NORM_TO_ENTITY)) {
    if (n.includes(nk) || nk.includes(n)) return e;
  }
  for (const [nk, e] of Object.entries(SYNONYMS)) {
    if (n.includes(nk)) return e;
  }
  return null;
}

export interface ParsedName {
  entity: string | null;
  agency: string;
}

// "Consolidated_Suppliers_015.xlsx" -> { entity: 'SUPPLIERS', agency: '015' }
export function parseFilename(filename: string): ParsedName {
  const base = filename.replace(/\.[^.]+$/, '');
  const tokens = base.split(/[_\-\s]+/).filter(Boolean);
  const numeric = tokens.filter(t => /^\d+$/.test(t));
  // Prefer the code right after a "BU" token — sample files end with a numeric
  // timestamp ("… BU 015 - Sample Converted Data 20260704-153000"), so plain
  // last-numeric would grab the timestamp instead of the BU.
  const buTok = tokens.findIndex(t => t.toUpperCase() === 'BU');
  const agency = (buTok >= 0 && /^\d+$/.test(tokens[buTok + 1] || '')) ? tokens[buTok + 1]
    : (numeric.length ? numeric[numeric.length - 1] : '');
  const words = tokens.filter(t => !/^\d+$/.test(t) && norm(t) !== 'CONSOLIDATED');
  const entity =
    matchEntity(words.join(' ')) ||
    (words.length ? matchEntity(words[words.length - 1]) : null);
  return { entity, agency };
}

// ── Seeded selection ─────────────────────────────────────────────────────────

// mulberry32 — small deterministic PRNG so a run is reproducible from its seed.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n distinct row indices in [0, N), reproducible for a given seed, sorted ascending.
export function selectSample(N: number, n: number, seed: number): number[] {
  const idx = Array.from({ length: N }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, Math.min(n, N)).sort((a, b) => a - b);
}

// ── Workbook read / write ────────────────────────────────────────────────────

export interface FileData {
  headers: unknown[];
  rows: unknown[][];
  sheetName: string;
}

// Read one worksheet into a headers/rows FileData.
function sheetToFileData(ws: XLSX.WorkSheet, sheetName: string): FileData {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: false,
    defval: null,
  });
  const headers = aoa.length ? (aoa[0] as unknown[]) : [];
  const rows = aoa.slice(1) as unknown[][];
  return { headers, rows, sheetName };
}

// Parse spreadsheet bytes (from a File or an S3 download) into a FileData.
export function parseWorkbookBuffer(buf: ArrayBuffer): FileData {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames[0];
  return sheetToFileData(wb.Sheets[sheetName], sheetName);
}

export async function readWorkbook(file: File): Promise<FileData> {
  return parseWorkbookBuffer(await file.arrayBuffer());
}

// ── Reproduce a prior sample from its recorded seed ──────────────────────────
// A prior sample workbook carries the Population it was drawn from and (in the
// full/internal copy) a Sizing sheet recording N, n and the seed. Re-reading
// those lets us re-draw the exact same selection and verify it against the
// original Sample sheet.

export interface PriorSizing {
  entity: string;
  agency: string;
  tierName: string;
  N: number | null;
  n: number | null;
  seed: number | null;
}

export interface PriorSample {
  sheetNames: string[];
  population: FileData | null; // the Population sheet — required to reproduce
  sample: FileData | null;     // the original Sample sheet — used to verify
  sizing: PriorSizing | null;  // N / n / seed, if the Sizing sheet is present
}

function findSheet(wb: XLSX.WorkBook, name: string): string | null {
  const lc = name.toLowerCase();
  return (
    wb.SheetNames.find(s => s.toLowerCase() === lc) ||
    wb.SheetNames.find(s => s.toLowerCase().includes(lc)) ||
    null
  );
}

// Parse the key/value Sizing sheet written by buildWorkbook back into its fields.
function parseSizingSheet(ws: XLSX.WorkSheet): PriorSizing {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: null });
  const pairs: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  for (const row of aoa) {
    const k = String(row?.[0] ?? '').trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); pairs.push([k, row?.[1]]); }
  }
  const get = (pred: (k: string) => boolean): unknown => {
    const hit = pairs.find(([k]) => pred(k));
    return hit ? hit[1] : null;
  };
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    entity: String(get(k => k === 'entity') ?? '').trim(),
    agency: String(get(k => k === 'agency') ?? '').trim(),
    tierName: String(get(k => k.startsWith('classification')) ?? '').trim(),
    N: num(get(k => k.startsWith('population'))),
    n: num(get(k => k.startsWith('required sample'))),
    seed: num(get(k => k.startsWith('random seed'))),
  };
}

export function parsePriorSample(buf: ArrayBuffer): PriorSample {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const popName = findSheet(wb, 'Population');
  const sizeName = findSheet(wb, 'Sizing');
  // The parent Sample sheet is written first. Older reports named it "<label>
  // Sample"; newer ones name it just "<label>" — so fall back to the first sheet
  // that isn't a Population / Sizing / Relationships / Integrity sheet.
  const internalSheet = (s: string) => { const l = s.toLowerCase(); return l.includes('population') || l.includes('sizing') || l.includes('relationship') || l.includes('integrity'); };
  const sampName = findSheet(wb, 'Sample') || wb.SheetNames.find(s => !internalSheet(s)) || null;
  return {
    sheetNames: wb.SheetNames.slice(),
    population: popName ? sheetToFileData(wb.Sheets[popName], popName) : null,
    sample: sampName ? sheetToFileData(wb.Sheets[sampName], sampName) : null,
    sizing: sizeName ? parseSizingSheet(wb.Sheets[sizeName]) : null,
  };
}

// Compare a reproduced selection against the original Sample sheet. The Sample
// sheet is written sorted by the linking key while a re-draw yields rows in
// population order, so compare as a multiset (order-independent) — how many of
// the original sampled rows the re-draw reproduces exactly.
export function verifyReproduction(
  population: FileData,
  sample: FileData,
  indices: number[],
): { matched: number; total: number; identical: boolean } {
  const serial = (row: unknown[] | undefined) => JSON.stringify((row ?? []).map(c => c ?? null));
  const total = sample.rows.length;
  const drawn = new Map<string, number>();
  for (const i of indices) { const s = serial(population.rows[i]); drawn.set(s, (drawn.get(s) || 0) + 1); }
  let matched = 0;
  for (const row of sample.rows) {
    const s = serial(row);
    const c = drawn.get(s) || 0;
    if (c > 0) { matched++; drawn.set(s, c - 1); }
  }
  return { matched, total, identical: total > 0 && indices.length === total && matched === total };
}

export interface SampleMeta {
  entity: string;
  agency: string;
  tier: Tier;
  N: number;
  n: number;
  seed: number;
  generatedAt: string;
  generatedBy?: string;
  selectedIndices: number[];
}

// Build the output workbook. Always includes Sample + Population; the
// Sizing/Evidence sheet (how we sized the sample) is included only for the
// internal copy — the client copy omits it.
export function buildWorkbook(data: FileData, meta: SampleMeta, includeSizing: boolean): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const sampleAoa = [data.headers, ...meta.selectedIndices.map(i => data.rows[i])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sampleAoa), 'Sample');

  const popAoa = [data.headers, ...data.rows];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(popAoa), 'Population');

  if (includeSizing) {
    const sizing: unknown[][] = [
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
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sizing), 'Sizing');
  }

  return wb;
}

// Serialize a workbook to bytes for upload to S3.
export function workbookToArray(wb: XLSX.WorkBook): Uint8Array {
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

// Trigger a browser download of a workbook.
export function downloadWorkbook(wb: XLSX.WorkBook, filename: string): void {
  XLSX.writeFile(wb, filename);
}
