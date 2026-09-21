'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../amplify_outputs.json';
import { ApiResult, apiGet, apiPost, fmtDateTime } from '../../lib/symphony';
import HcmShell, { formatSize, partyKey, partyLabel, useHcm } from '../HcmShell';
import './files.css';

Amplify.configure(config);

interface PubFile { id: number; name: string; size?: number | null; published_by?: string | null; published_at?: string | null }
interface PubEntity { entity: string; certification_required?: boolean; certified?: boolean; files?: PubFile[] }
interface PubFileType { file_type: string; entities?: PubEntity[] }
interface PubModule { module: string; file_types?: PubFileType[] }
interface PubTree extends ApiResult { party?: string; modules?: PubModule[]; total_files?: number }
interface PubParty { source: string; agency: string; bu?: string; party?: string; files?: number; required?: number; certified?: number }
interface PubParties extends ApiResult { parties?: PubParty[] }
interface DownloadUrl extends ApiResult { url?: string; file_name?: string }

/** The folder a link from another portal page points to (?module=&file_type=&entity=, staff links add source and agency). */
interface FolderLink { source: string; agency: string; module: string; fileType: string; entity: string }

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const same = (a?: string, b?: string) => (a || '').trim().toUpperCase() === (b || '').trim().toUpperCase();
const fileCount = (t: PubFileType) => (t.entities ?? []).reduce((n, e) => n + (e.files?.length ?? 0), 0);
const pendingCount = (t: PubFileType) => (t.entities ?? []).filter(e => e.certification_required && !e.certified).length;

function pointsTo(link: FolderLink | null, m: PubModule, t: PubFileType, e: PubEntity): boolean {
  return !!link && same(link.entity, e.entity)
    && (!link.fileType || same(link.fileType, t.file_type))
    && (!link.module || same(link.module, m.module));
}

/** The folders that hold a file whose name contains `needle`; every folder when there is nothing to search for. */
function matching(modules: PubModule[], needle: string): PubModule[] {
  if (!needle) return modules;
  return modules
    .map(m => ({
      ...m,
      file_types: (m.file_types ?? [])
        .map(t => ({
          ...t,
          entities: (t.entities ?? [])
            .map(e => ({ ...e, files: (e.files ?? []).filter(f => f.name.toLowerCase().includes(needle)) }))
            .filter(e => e.files.length > 0),
        }))
        .filter(t => t.entities.length > 0),
    }))
    .filter(m => m.file_types.length > 0);
}

const svg = (...paths: string[]) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const FOLDER = svg('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z');
const DOCUMENT = svg('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z', 'M14 3v5h5');
const CHEVRON = svg('M9 6l6 6-6 6');

interface FileTypeGroupProps { type: PubFileType; open: boolean; onToggle: () => void; children: React.ReactNode }

function FileTypeGroup({ type, open, onToggle, children }: FileTypeGroupProps) {
  const bodyId = useId();
  const files = fileCount(type);
  const pending = pendingCount(type);
  return (
    <div className="hf-type">
      <h3 className="hf-type-heading">
        <button type="button" className="hf-type-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="hf-chevron">{CHEVRON}</span>
          <span className="hf-type-icon">{FOLDER}</span>
          <span className="hf-type-name">{type.file_type || 'Other'}</span>
          <span className="hf-type-meta">
            {pending > 0 && <span className="sy-badge sy-badge-warn">{pending} to certify</span>}
            <span>{files > 0 ? plural(files, 'file', 'files') : 'No files yet'}</span>
          </span>
        </button>
      </h3>
      <div id={bodyId} className="hf-type-body" hidden={!open}>{open && children}</div>
    </div>
  );
}

interface PartyFilesProps {
  party: Pick<PubParty, 'source' | 'agency' | 'bu' | 'party'>;
  link: FolderLink | null;
  canRemove?: boolean;
  onRemoved?: () => void;
}

/** One source and agency: its folders the way the agency knows them, with the files published to each. */
function PartyFiles({ party, link, canRemove, onRemoved }: PartyFilesProps) {
  const { mock, email, view, canWrite } = useHcm();
  const { source, agency } = party;
  const canCertify = view === 'agency' && canWrite;
  // The server's own wording is for the validation team; an agency gets the plain sentence.
  const reason = (d: ApiResult, plain: string) => (view === 'staff' && d.error) || plain;
  const [tree, setTree] = useState<PubTree | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<number[]>([]);  // ids of the files being downloaded or removed
  const [search, setSearch] = useState('');
  const [toggled, setToggled] = useState<Record<string, boolean>>({});   // folders the user opened or closed
  const latest = useRef(0);
  const scrolled = useRef(false);

  const load = useCallback(async () => {
    const id = ++latest.current;
    setLoadError('');
    const d = await apiGet<PubTree>('pub_tree', { mock, source, agency, email });
    if (id !== latest.current) return;
    setLoadError(d.ok ? '' : d.error || 'The files could not be loaded');
    if (d.ok) setTree(d);
  }, [mock, source, agency, email]);

  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load]);

  // A link to one folder: bring it into view once its files are on screen.
  useEffect(() => {
    if (!tree || !link || scrolled.current) return;
    const folder = document.getElementById('hf-linked');
    if (!folder) return;
    scrolled.current = true;
    folder.scrollIntoView({ block: 'center' });
    folder.focus({ preventScroll: true });
  }, [tree, link]);

  const modules = useMemo(() => tree?.modules ?? [], [tree]);
  const needle = search.trim().toLowerCase();
  const shown = useMemo(() => matching(modules, needle), [modules, needle]);

  if (!tree) {
    if (!loadError) return <p className="hcm-loading">Loading…</p>;
    return (
      <div className="hcm-message">
        <h2>The files could not be loaded</h2>
        <p>{view === 'staff' ? loadError : 'Please try again in a moment.'}</p>
        <div className="hcm-message-actions">
          <button type="button" className="btn btn-primary" onClick={load}>Try again</button>
        </div>
      </div>
    );
  }

  const types = modules.flatMap(m => m.file_types ?? []);
  const total = tree.total_files ?? types.reduce((n, t) => n + fileCount(t), 0);
  const required = types.reduce((n, t) => n + (t.entities ?? []).filter(e => e.certification_required).length, 0);
  const pending = types.reduce((n, t) => n + pendingCount(t), 0);
  const found = shown.reduce((n, m) => n + (m.file_types ?? []).reduce((k, t) => k + fileCount(t), 0), 0);

  const download = async (f: PubFile) => {
    setBusy(ids => [...ids, f.id]);
    setError('');
    setNotice('');
    const d = await apiGet<DownloadUrl>('pub_download_url', { id: f.id, email });
    setBusy(ids => ids.filter(id => id !== f.id));
    if (!d.ok || !d.url) {
      setError(reason(d, `${f.name} could not be downloaded. Please try again in a moment.`));
      return;
    }
    window.location.assign(d.url);
  };

  const remove = async (f: PubFile) => {
    if (!window.confirm(`Remove ${f.name} from ${partyLabel(party)}?\n\nThe agency will no longer see it.`)) return;
    setBusy(ids => [...ids, f.id]);
    setError('');
    setNotice('');
    const d = await apiPost<ApiResult>('pub_delete', { actor: email, id: f.id });
    setBusy(ids => ids.filter(id => id !== f.id));
    if (!d.ok) {
      setError(d.error || `${f.name} could not be removed`);
      return;
    }
    setNotice(`${f.name} was removed.`);
    load();
    onRemoved?.();
  };

  const certifyHref = (m: PubModule, t: PubFileType, e: PubEntity) =>
    `/hcm/certifications?${new URLSearchParams({ module: m.module || '', file_type: t.file_type || '', entity: e.entity || '' })}`;

  return (
    <>
      <div className="hcm-summary">
        <span className="hcm-summary-party">{partyLabel(party)}</span>
        <p className="hcm-summary-text">
          {[
            `${plural(total, 'file', 'files')} published`,
            pending > 0 ? `${plural(pending, 'certification', 'certifications')} pending`
              : required > 0 ? 'Every certification is completed' : 'No certification is required',
          ].join(' · ')}
        </p>
      </div>

      {loadError && <div className="sy-error">{view === 'staff' ? loadError : 'The files could not be refreshed. Please try again in a moment.'}</div>}
      {error && <div className="sy-error" role="alert">{error}</div>}
      {notice && <div className="sy-success" role="status">{notice}</div>}

      {total === 0 && (
        <div className="hcm-banner">No files have been published here for {mock} yet. They appear in the folders below as soon as the validation team publishes them.</div>
      )}
      {(total > 0 || search) && (
        <div className="hf-toolbar">
          <label className="sy-field hf-search">
            <span>Search by file name</span>
            {/* A new search starts from the folders as they open by themselves: every one with a match is open. */}
            <input type="search" value={search} onChange={e => { setSearch(e.target.value); setToggled({}); }}
              placeholder="Type part of a file name" />
          </label>
          {needle && <p className="hf-count" role="status">{plural(found, 'file matches', 'files match')}</p>}
        </div>
      )}

      {needle && found === 0 && (
        <div className="hcm-empty">
          <p>No file name contains “{search.trim()}”.</p>
        </div>
      )}

      {shown.map(m => {
        const moduleFiles = (m.file_types ?? []).reduce((n, t) => n + fileCount(t), 0);
        return (
          <section key={m.module} className="hf-module">
            <div className="hf-module-head">
              <h2 className="hf-module-title">{m.module || 'Other files'}</h2>
              <span className="hf-module-meta">{moduleFiles > 0 ? plural(moduleFiles, 'file', 'files') : 'No files yet'}</span>
            </div>
            {(m.file_types ?? []).map(t => {
              const key = `${m.module}|${t.file_type}`.toUpperCase();
              const linked = (t.entities ?? []).some(e => pointsTo(link, m, t, e));
              const open = toggled[key] ?? (linked || fileCount(t) > 0);
              return (
                <FileTypeGroup key={key} type={t} open={open} onToggle={() => setToggled(prev => ({ ...prev, [key]: !open }))}>
                  {(t.entities ?? []).map(e => {
                    const isLinked = pointsTo(link, m, t, e);
                    const files = e.files ?? [];
                    return (
                      <div key={e.entity} id={isLinked ? 'hf-linked' : undefined} tabIndex={isLinked ? -1 : undefined}
                        className={`hf-entity${isLinked ? ' hf-entity-linked' : ''}`}>
                        <div className="hf-entity-head">
                          <h4 className="hf-entity-name">{e.entity || 'Other'}</h4>
                          {e.certification_required && (e.certified
                            ? <span className="sy-badge sy-badge-ok">Certified</span>
                            : <span className="sy-badge sy-badge-warn">Certification required</span>)}
                          {e.certification_required && !e.certified && canCertify && (
                            <Link href={certifyHref(m, t, e)} className="btn btn-secondary hf-small"
                              aria-label={`Certify ${e.entity}, ${t.file_type}, ${m.module}`}>
                              Certify
                            </Link>
                          )}
                        </div>
                        {files.length === 0 ? <p className="hf-none">No files yet</p> : (
                          <ul className="hf-files">
                            {files.map(f => (
                              <li key={f.id} className="hf-file">
                                <span className="hf-file-icon">{DOCUMENT}</span>
                                <div className="hf-file-main">
                                  <div className="hf-file-name">{f.name}</div>
                                  <div className="hf-file-meta">
                                    {[
                                      formatSize(f.size),
                                      f.published_at ? `Published ${fmtDateTime(f.published_at).slice(0, 16)}` : '',
                                      canRemove && f.published_by ? `by ${f.published_by}` : '',
                                    ].filter(Boolean).join(' · ')}
                                  </div>
                                </div>
                                <div className="hf-file-actions">
                                  <button type="button" className="btn btn-primary hf-small" disabled={busy.includes(f.id)}
                                    onClick={() => download(f)} aria-label={`Download ${f.name}`}>
                                    {busy.includes(f.id) ? 'Please wait…' : 'Download'}
                                  </button>
                                  {canRemove && (
                                    <button type="button" className="btn btn-secondary hf-small" disabled={busy.includes(f.id)}
                                      onClick={() => remove(f)} aria-label={`Remove ${f.name}`}>
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </FileTypeGroup>
              );
            })}
          </section>
        );
      })}
    </>
  );
}

/** Validation team: every source and agency of the cycle on one side, the chosen one's folders on the other. */
function StaffFiles({ link }: { link: FolderLink | null }) {
  const { mock, email, isSuperUser } = useHcm();
  const [parties, setParties] = useState<PubParty[] | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const latest = useRef(0);
  const folders = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const id = ++latest.current;
    setError('');
    const d = await apiGet<PubParties>('pub_parties', { mock, email });
    if (id !== latest.current) return;
    setError(d.ok ? '' : d.error || 'The sources and agencies could not be loaded');
    if (d.ok) setParties(Array.isArray(d.parties) ? d.parties : []);
  }, [mock, email]);

  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load]);

  // On a narrow screen the folders sit below the list: bring them into view after a choice.
  useEffect(() => {
    if (chosen && window.matchMedia('(max-width: 900px)').matches) folders.current?.scrollIntoView({ block: 'start' });
  }, [chosen]);

  if (!parties) {
    if (!error) return <p className="hcm-loading">Loading…</p>;
    return (
      <div className="hcm-message">
        <h2>The files could not be loaded</h2>
        <p>{error}</p>
        <div className="hcm-message-actions">
          <button type="button" className="btn btn-primary" onClick={load}>Try again</button>
        </div>
      </div>
    );
  }

  const activeKey = chosen ?? (link?.source ? partyKey(link) : '');
  const selected = parties.find(p => partyKey(p) === activeKey) || null;
  const needle = search.trim().toLowerCase();
  const listed = parties.filter(p => !needle || `${partyLabel(p)} ${p.bu || ''}`.toLowerCase().includes(needle));
  const totalFiles = parties.reduce((n, p) => n + (p.files ?? 0), 0);

  return (
    <>
      <div className="hf-staff-head">
        <p className="hf-count">
          {plural(parties.length, 'source and agency', 'sources and agencies')} · {plural(totalFiles, 'file', 'files')} published in {mock}
        </p>
        {isSuperUser && <Link href="/hcm/publish" className="btn btn-primary">Publish files</Link>}
      </div>
      {error && <div className="sy-error">{error}</div>}

      {parties.length === 0 ? (
        <div className="hcm-empty"><p>No source or agency has folders in {mock} yet.</p></div>
      ) : (
        <div className="hf-staff">
          <section className="hf-parties">
            <h2>All files by source and agency</h2>
            <label className="sy-field">
              <span>Find a source or agency</span>
              <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, number or source" />
            </label>
            {listed.length === 0 ? <p className="hf-none">Nothing matches “{search.trim()}”.</p> : (
              <ul className="hf-party-list">
                {listed.map(p => {
                  const active = partyKey(p) === activeKey;
                  return (
                    <li key={partyKey(p)}>
                      <button type="button" className={`hf-party${active ? ' hf-party-active' : ''}`}
                        aria-current={active ? 'true' : undefined} onClick={() => setChosen(partyKey(p))}>
                        <span className="hf-party-name">{partyLabel(p)}</span>
                        <span className="hf-party-meta">
                          {[
                            plural(p.files ?? 0, 'file', 'files'),
                            p.required ? `${p.certified ?? 0} of ${p.required} certified` : 'No certification required',
                          ].join(' · ')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <div ref={folders} className="hf-folders">
            {selected ? (
              <PartyFiles key={partyKey(selected)} party={selected} canRemove={isSuperUser} onRemoved={load}
                link={link?.source && partyKey(link) === partyKey(selected) ? link : null} />
            ) : (
              <div className="hcm-empty">
                <h2>Choose a source and agency</h2>
                <p>Its folders and files show here.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Files() {
  const { view, party } = useHcm();
  const [link, setLink] = useState<FolderLink | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const entity = (q.get('entity') || '').trim();
    if (!entity) return;
    setLink({
      source: q.get('source') || '', agency: q.get('agency') || '',
      module: q.get('module') || '', fileType: q.get('file_type') || '', entity,
    });
  }, []);

  if (view === 'agency' && party) return <PartyFiles key={partyKey(party)} party={party} link={link} />;
  return <StaffFiles link={link} />;
}

function HcmFilesPage() {
  return (
    <HcmShell title="Files" subtitle="The files published for the selected Mock Cycle, by module, file type and entity.">
      <Files />
    </HcmShell>
  );
}

export default withAuthenticator(HcmFilesPage);
