// Bridge from the server-generated entity files (written to S3 by the
// generate_entity_files Lambda action) into the client-side merge/sampling flow.
//
// The generator writes CV_ files to Sampling/Generated/{mock}/{entity}/. Here we
// list those folders and pull an entity's files straight into the browser, so
// they feed the same groupRawFiles + mergeGroup pipeline the drag-and-drop uses —
// no download-and-re-drop round trip. Record data is read in the browser only.

import { list, getUrl } from 'aws-amplify/storage';
import { parseWorkbookBuffer } from './sampling';
import { RawFile } from './merge';

export const GENERATED_PREFIX = 'Sampling/Generated/';

export interface GeneratedEntity {
  mock: string;
  entity: string;       // folder-safe entity name as written by the generator
  prefix: string;       // full S3 prefix of the entity folder
  files: string[];      // CV_ file names within the folder
  lastModified?: Date;  // newest file time — when it was generated
}

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

// Download an entity's generated files and parse them into RawFiles for merging.
export async function loadGeneratedFiles(
  g: GeneratedEntity,
  onProgress?: (done: number, total: number) => void,
): Promise<RawFile[]> {
  const raws: RawFile[] = [];
  let done = 0;
  for (const f of g.files) {
    try {
      const { url } = await getUrl({ path: g.prefix + f, options: { expiresIn: 3600 } });
      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      raws.push({ name: f, data: parseWorkbookBuffer(await resp.arrayBuffer()) });
    } catch (e) {
      console.error('generated load failed', f, e);
    }
    onProgress?.(++done, g.files.length);
  }
  return raws;
}
