// Parse the "Agencies by Pillar / Entity / Status" report (FIN-SCM sheet) into
// a structure the BU completion dashboard renders. Each BU has a status per
// expected entity (Completed / Partial / Pending); blank = entity not attached.

import * as XLSX from 'xlsx';

export type EntityStatus = 'Completed' | 'Partial' | 'Pending' | string;

export interface BURow {
  unit: string;
  name: string;
  statuses: Record<string, EntityStatus>; // entity -> status (only attached ones)
  total: number;
  completed: number;
  partial: number;
  pending: number;
  pct: number; // completed / total
}

export interface AgencyReport {
  entities: string[]; // ordered entity column names (C..Q)
  bus: BURow[];
  totals: { attached: number; completed: number; partial: number; pending: number; pct: number };
}

// Codes that are the same Business Unit under a different source system or
// division, mapped to their parent BU. Extend as future reports add more.
export const BU_ALIASES: Record<string, string> = {
  '5001': '050',   // Recursos Naturales (FIMAS) -> DRNA (050)
  '450121': '045', // DSP - Negociado 911 (division) -> DSP (045)
};

export interface BUGroup {
  code: string; // parent BU code
  name: string;
  members: BURow[]; // parent row first, then aliased rows
  completed: number;
  partial: number;
  pending: number;
  total: number;
  pct: number;
  multi: boolean;
}

// Group BU rows so aliased codes roll up under their parent. Totals are the sum
// across members (rows are kept, nothing is merged/deduped).
export function buildGroups(bus: BURow[], aliases: Record<string, string> = BU_ALIASES): BUGroup[] {
  const byCode = new Map<string, BURow>();
  bus.forEach(b => byCode.set(b.unit, b));
  const parentOf = (code: string) => aliases[code] || code;

  const groups = new Map<string, BURow[]>();
  for (const b of bus) {
    const p = parentOf(b.unit);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(b);
  }

  const result: BUGroup[] = [];
  groups.forEach((membersRaw, code) => {
    const members = membersRaw.slice().sort((a, b) =>
      a.unit === code ? -1 : b.unit === code ? 1 : a.unit.localeCompare(b.unit));
    const parent = byCode.get(code);
    const completed = members.reduce((s, m) => s + m.completed, 0);
    const partial = members.reduce((s, m) => s + m.partial, 0);
    const pending = members.reduce((s, m) => s + m.pending, 0);
    const total = members.reduce((s, m) => s + m.total, 0);
    result.push({
      code,
      name: parent?.name || members[0].name,
      members, completed, partial, pending, total,
      pct: total ? completed / total : 0,
      multi: members.length > 1,
    });
  });
  return result;
}

const ENTITY_START = 2; // column C (0-based)

export function parseAgencyReport(buf: ArrayBuffer): AgencyReport {
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets['FIN-SCM'] || wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: null });

  // Header row = the one whose column A reads "Agency Unit".
  let hIdx = aoa.findIndex(r => String((r as unknown[])[0] ?? '').trim().toLowerCase() === 'agency unit');
  if (hIdx < 0) hIdx = 1;
  const header = aoa[hIdx] as unknown[];

  // Entity columns run from C until the STATUS section ("Completed").
  const entities: string[] = [];
  const entityCols: number[] = [];
  for (let c = ENTITY_START; c < header.length; c++) {
    const h = String(header[c] ?? '').trim();
    if (!h) continue;
    if (/^completed$/i.test(h)) break;
    entities.push(h);
    entityCols.push(c);
  }

  const bus: BURow[] = [];
  let tc = 0, tp = 0, tpe = 0, ta = 0;
  for (let r = hIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] as unknown[];
    const unitRaw = row[0];
    if (unitRaw === null || unitRaw === undefined || String(unitRaw).trim() === '') continue;

    const statuses: Record<string, EntityStatus> = {};
    let completed = 0, partial = 0, pending = 0, total = 0;
    entityCols.forEach((c, i) => {
      const v = row[c];
      const s = v == null ? '' : String(v).trim();
      if (!s) return;
      statuses[entities[i]] = s;
      total++;
      const sl = s.toLowerCase();
      if (sl === 'completed') completed++;
      else if (sl === 'partial') partial++;
      else if (sl === 'pending') pending++;
    });
    if (total === 0 && String(row[1] ?? '').trim() === '') continue;

    bus.push({
      unit: String(unitRaw).trim(),
      name: String(row[1] ?? '').trim(),
      statuses, total, completed, partial, pending,
      pct: total ? completed / total : 0,
    });
    tc += completed; tp += partial; tpe += pending; ta += total;
  }

  return {
    entities,
    bus,
    totals: { attached: ta, completed: tc, partial: tp, pending: tpe, pct: ta ? tc / ta : 0 },
  };
}
