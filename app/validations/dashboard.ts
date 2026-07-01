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
