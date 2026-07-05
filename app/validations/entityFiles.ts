// Entity-file readiness — from SETUP_CONVERSION_PLAN_{mock} (via the entity_plan
// Lambda action). Each plan row is one expected entity file (entity x source x
// BU x conversion table). We group by entity and overlay the readiness the PM
// communicated by email (ready to sample / delivered-by-Monday / not yet workable).

export interface PlanRow {
  Pillar: string;
  Module: string;
  Entity: string;
  SubEntity: string;
  SOURCE: string;
  BU: string;
  CONVERSION_TABLE_BU: string;
  CONVERSION_TABLE_SourceField: string;
  CONVERSION_TABLE_BU_Field: string;
  Conversion_Table_Sourcefield_ForSampling: string;
  FileImportStatus: string; // 'Y' imported / 'N' not
  SourceFileName: string;
  'On Conversion Plan'?: string; // 'Y' on the active conversion plan / 'N' not
  tableRows?: number | null; // conversion-table row count (null = table missing)
}

export type Readiness = 'ready' | 'delivered' | 'blocked' | 'unknown';

export interface EntityGroup {
  pillar: string;
  module: string;
  entity: string;
  files: PlanRow[];
  expected: number;
  imported: number;       // FileImportStatus === 'Y'
  populated: number;      // tableRows > 0
  empty: number;          // tableRows === 0
  missingTable: number;   // tableRows === null
  countsLoaded: boolean;
  readiness: Readiness;
}

function norm(s: string): string {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// From the 7/2 PM email. Order matters: check blocked, then delivered, then ready.
const BLOCKED = ['GLBALANCE', 'ASSET', 'INVENTORY', 'PROCUREMENTCONTRACT'];
const DELIVERED = ['BANK', 'BPA', 'CONTRACT', 'BUDGETBALANCE', 'PSITEM', 'PEOPLESOFTITEM', 'PURCHASEORDER', 'REQUISITION'];
const READY = ['ARCUSTOMER', 'ARINVOICE', 'CUSTOMERANDSPONSOR', 'AWARD', 'PROJECT', 'APINVOICE', 'SUPPLIER', 'LOCATION'];

export function readinessFor(entity: string): Readiness {
  const n = norm(entity);
  if (BLOCKED.some(k => n.includes(k))) return 'blocked';
  if (DELIVERED.some(k => n.includes(k))) return 'delivered';
  if (READY.some(k => n.includes(k))) return 'ready';
  return 'unknown';
}

export const READINESS_LABEL: Record<Readiness, string> = {
  ready: 'Ready to sample',
  delivered: 'Delivered (by Mon)',
  blocked: 'Not yet workable',
  unknown: '—',
};

export function groupEntityPlan(rows: PlanRow[]): EntityGroup[] {
  const map = new Map<string, EntityGroup>();
  for (const r of rows) {
    const key = `${r.Pillar}|${r.Module}|${r.Entity}`;
    let g = map.get(key);
    if (!g) {
      g = {
        pillar: r.Pillar, module: r.Module, entity: r.Entity,
        files: [], expected: 0, imported: 0, populated: 0, empty: 0, missingTable: 0,
        countsLoaded: false, readiness: readinessFor(r.Entity),
      };
      map.set(key, g);
    }
    g.files.push(r);
    g.expected++;
    if (String(r.FileImportStatus).toUpperCase() === 'Y') g.imported++;
    if (typeof r.tableRows === 'number') {
      g.countsLoaded = true;
      if (r.tableRows > 0) g.populated++; else g.empty++;
    } else if (r.tableRows === null) {
      g.countsLoaded = true;
      g.missingTable++;
    }
  }
  const order: Record<Readiness, number> = { ready: 0, delivered: 1, unknown: 2, blocked: 3 };
  return Array.from(map.values()).sort((a, b) =>
    order[a.readiness] - order[b.readiness] ||
    a.pillar.localeCompare(b.pillar) || a.module.localeCompare(b.module) || a.entity.localeCompare(b.entity));
}
