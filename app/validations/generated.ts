// Bridge from the server-generated entity files (written to S3 by the
// generate_entity_files Lambda action) into the client-side merge/sampling flow.
//
// The generator writes CV_ files to Sampling/Generated/{mock}/{entity}/ and a
// manifest to Sampling/Generated/_manifests/{mock}/{entity}/. Here we list those
// folders, read the manifest to learn each file's real (table, source, bu), and
// pull the files into the browser so they feed either the relationship-aware
// merge (using the sampling_targets graph) or, as a fallback, the same filename
// grouping the drag-and-drop uses. Record data is read in the browser only.

import { list, getUrl } from 'aws-amplify/storage';
import { parseWorkbookBuffer } from './sampling';
import { TaggedFile, SamplingTarget, RelEdge } from './merge';

export const GENERATED_PREFIX = 'Sampling/Generated/';

export interface GeneratedEntity {
  mock: string;
  entity: string;       // folder-safe entity name as written by the generator
  prefix: string;       // full S3 prefix of the entity folder
  files: string[];      // CV_ file names within the folder
  lastModified?: Date;  // newest file time — when it was generated
}

// (table, source, bu) recorded by the generation manifest for one output file.
export interface ManifestEntry { table: string; source: string; bu: string; rows: number; }

// Same folder-safe transform the Lambda's _safe_name applies to the entity name.
export function safeName(s: string): string {
  return (s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'NA';
}

// Group everything under Sampling/Generated/{mock}/ by its entity folder.
export async function listGeneratedEntities(mock: string): Promise<GeneratedEntity[]> {
  const base = `${GENERATED_PREFIX}${mock}/`;
  const res = await list({ path: base, options: { listAll: true } });
  const map = new Map<string, GeneratedEntity>();
  for (const it of res.items) {
    if (!it.path.startsWith(base) || it.path.endsWith('/')) continue;
    const parts = it.path.slice(base.length).split('/').filter(Boolean);
    if (parts.length < 2) continue;                 // expect {entity}/{file}
    const entity = parts[0];
    if (entity.startsWith('_')) continue;           // skip _manifests etc.
    const file = parts.slice(1).join('/');
    if (!/\.xlsx?$/i.test(file)) continue;
    let g = map.get(entity);
    if (!g) { g = { mock, entity, prefix: `${base}${entity}/`, files: [] }; map.set(entity, g); }
    g.files.push(file);
    const lm = it.lastModified ? new Date(it.lastModified) : undefined;
    if (lm && (!g.lastModified || lm > g.lastModified)) g.lastModified = lm;
  }
  return Array.from(map.values()).sort((a, b) => a.entity.localeCompare(b.entity));
}

// The authoritative parent→child + link-field graph (metadata only).
export async function fetchSamplingTargets(lambdaUrl: string): Promise<SamplingTarget[]> {
  const resp = await fetch(`${lambdaUrl}?action=sampling_targets`);
  const d = await resp.json();
  if (!d.ok) throw new Error(d.error || 'failed to load sampling targets');
  return (d.targets || []).map((t: { table: string; display: string; children?: { table: string; link_field: string }[] }) => ({
    table: t.table,
    display: t.display,
    children: (t.children || []).map((c) => ({ table: c.table, link_field: c.link_field })),
  }));
}

// The full parent/child edge list for multi-level traversal (Awards → bridge →
// Project Tasks). Metadata only.
export async function fetchSamplingRelationships(lambdaUrl: string): Promise<RelEdge[]> {
  const resp = await fetch(`${lambdaUrl}?action=sampling_relationships`);
  const d = await resp.json();
  if (!d.ok) throw new Error(d.error || 'failed to load sampling relationships');
  return (d.relationships || []).map((e: { child: string; parent: string; link_field: string }) => ({
    child: e.child, parent: e.parent, link_field: e.link_field,
  }));
}

// Read the entity's generation manifest(s) → map of output filename to its real
// (table, source, bu). Newer runs win on collision. Empty map if none exist
// (e.g. files generated before manifests were introduced).
export async function readEntityManifests(mock: string, entity: string): Promise<Map<string, ManifestEntry>> {
  const base = `${GENERATED_PREFIX}_manifests/${mock}/${safeName(entity)}/`;
  const out = new Map<string, ManifestEntry>();
  let res;
  try { res = await list({ path: base, options: { listAll: true } }); }
  catch { return out; }
  const jsons = res.items
    .filter(it => it.path.endsWith('.json'))
    .sort((a, b) => (+new Date(a.lastModified || 0)) - (+new Date(b.lastModified || 0)));
  for (const it of jsons) {
    try {
      const { url } = await getUrl({ path: it.path, options: { expiresIn: 3600 } });
      const resp = await fetch(url.toString());
      if (!resp.ok) continue;
      const m = await resp.json();
      for (const gf of (m.generated || [])) {
        if (gf.file) out.set(gf.file, {
          table: gf.table || '', source: String(gf.source ?? ''),
          bu: String(gf.bu ?? ''), rows: gf.rows || 0,
        });
      }
    } catch { /* skip a bad manifest */ }
  }
  return out;
}

export interface ManifestFileRow extends ManifestEntry { entity: string; file: string; }

// Read every generation manifest under a mock → flat rows (entity, file, table,
// source, bu, rows). Used by the completeness check to see what's actually been
// generated vs what the validation report expects. Newest run wins per file.
export async function readAllManifests(mock: string): Promise<ManifestFileRow[]> {
  const base = `${GENERATED_PREFIX}_manifests/${mock}/`;
  let res;
  try { res = await list({ path: base, options: { listAll: true } }); }
  catch { return []; }
  const jsons = res.items
    .filter(it => it.path.endsWith('.json'))
    .sort((a, b) => (+new Date(a.lastModified || 0)) - (+new Date(b.lastModified || 0)));
  const byKey = new Map<string, ManifestFileRow>(); // entity|file -> newest row
  for (const it of jsons) {
    try {
      const { url } = await getUrl({ path: it.path, options: { expiresIn: 3600 } });
      const resp = await fetch(url.toString());
      if (!resp.ok) continue;
      const m = await resp.json();
      const entity = String(m.entity ?? '');
      for (const gf of (m.generated || [])) {
        if (!gf.file) continue;
        byKey.set(`${entity}|${gf.file}`, {
          entity, file: gf.file, table: gf.table || '',
          source: String(gf.source ?? ''), bu: String(gf.bu ?? ''), rows: gf.rows || 0,
        });
      }
    } catch { /* skip */ }
  }
  return Array.from(byKey.values());
}

// Download an entity's generated files, parse them, and tag each with its real
// (table, source, bu) from the manifest so the relationship-aware merge can use it.
export async function loadGeneratedTagged(
  g: GeneratedEntity,
  manifest: Map<string, ManifestEntry>,
  onProgress?: (done: number, total: number) => void,
): Promise<TaggedFile[]> {
  const out: TaggedFile[] = [];
  let done = 0;
  for (const f of g.files) {
    try {
      const { url } = await getUrl({ path: g.prefix + f, options: { expiresIn: 3600 } });
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      const data = parseWorkbookBuffer(await resp.arrayBuffer());
      const meta = manifest.get(f);
      out.push({ name: f, data, table: meta?.table, source: meta?.source, bu: meta?.bu });
    } catch (e) {
      console.error('generated load failed', f, e);
    }
    onProgress?.(++done, g.files.length);
  }
  return out;
}
