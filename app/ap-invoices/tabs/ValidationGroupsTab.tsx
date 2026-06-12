'use client';
/**
 * Phase 6.3 — Validation Groups tab.
 *
 * Card per group showing:
 *   - Members_Currently_Loaded / Members_Total progress bar
 *   - Inline Members_Total + Error_Threshold editor (so groups seeded with 0
 *     can finally fire — that's blocking validation auto-trigger today)
 *   - Dependencies state (loaded / blocking)
 *   - Latest run + approval status
 *   - "Refresh dependencies" button
 *
 * Reads from ?action=validation_groups (Phase 4) + posts to
 * ?action=update_validation_group (Phase 6.2) and
 * ?action=vg_dependencies_refresh (Phase 4).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface VG {
  Validation_Group_ID: string;
  Validation_Group_Name: string | null;
  Pillar: string | null;
  Module: string | null;
  Data_Entity: string | null;
  Members_Total: number | null;
  Members_Currently_Loaded: number | null;
  All_Members_Loaded: string | null;
  Error_Threshold: number | null;
  Threshold_Exceeded: string | null;
  Reextract_Required: string | null;
  Current_Validation_Run_ID: string | null;
  Validation_Run_Count: number | null;
  Latest_Validation_Status: string | null;
  Latest_Validation_DateTime: string | null;
  Latest_Approval_Status: string | null;
  Latest_Approver: string | null;
  Latest_Approval_DateTime: string | null;
  dependencies?: { total: number; loaded: number; blocking: number };
}

export function ValidationGroupsTab({ userEmail, userBUFilter }: {
  userEmail: string;
  userBUFilter: string[] | null;
}) {
  const [mock, setMock] = useState('MOCK12');
  const [groups, setGroups] = useState<VG[]>([]);
  const [moduleFilter, setModuleFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshingDeps, setRefreshingDeps] = useState(false);
  const [selectedVG, setSelectedVG] = useState<VG | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=validation_groups&mock=${encodeURIComponent(mock)}`);
      const d = await resp.json();
      if (!d.ok) { setError(d.error || 'Load failed'); setGroups([]); }
      else setGroups(d.groups || []);
    } catch (e) { setError(`Network error: ${(e as Error).message}`); }
    finally { setLoading(false); }
  }, [mock]);

  useEffect(() => { load(); }, [load]);

  const refreshDeps = async () => {
    setRefreshingDeps(true);
    try {
      await fetch(`${LAMBDA_URL}?action=vg_dependencies_refresh&mock=${encodeURIComponent(mock)}`);
      await load();
    } catch { /* swallow — will surface on next load */ }
    finally { setRefreshingDeps(false); }
  };

  const filtered = useMemo(() => {
    let r = groups;
    if (moduleFilter) r = r.filter(g => (g.Module || '').toUpperCase() === moduleFilter.toUpperCase());
    if (search) {
      const s = search.toUpperCase();
      r = r.filter(g =>
        g.Validation_Group_ID.toUpperCase().includes(s) ||
        (g.Validation_Group_Name || '').toUpperCase().includes(s) ||
        (g.Data_Entity || '').toUpperCase().includes(s)
      );
    }
    return r;
  }, [groups, moduleFilter, search]);

  // Quick rollup for the toolbar
  const rollup = useMemo(() => {
    return {
      total: groups.length,
      ready: groups.filter(g => g.All_Members_Loaded === 'Y').length,
      blocked: groups.filter(g => (g.dependencies?.blocking || 0) > 0).length,
      pending_approval: groups.filter(g => g.Latest_Validation_Status === 'Pending Approval').length,
      no_total: groups.filter(g => !g.Members_Total).length,
    };
  }, [groups]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'end', marginBottom: 12,
        padding: 12, background: '#f9fafb', borderRadius: 8, flexWrap: 'wrap',
      }}>
        <LabelledInput label="Mock" value={mock} onChange={v => setMock(v.toUpperCase())} width={110} />
        <LabelledInput label="Module" value={moduleFilter} onChange={setModuleFilter} placeholder="FIN / HCM / SCM" width={140} />
        <LabelledInput label="Search" value={search} onChange={setSearch} placeholder="VG ID, name, entity..." width={240} />
        <button className="btn btn-primary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          onClick={refreshDeps} disabled={refreshingDeps}
          style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}
        >
          {refreshingDeps ? 'Re-evaluating…' : 'Re-evaluate dependencies'}
        </button>
      </div>

      {userBUFilter && userBUFilter.length > 0 && (
        <BUScopeNotice userBUFilter={userBUFilter} />
      )}

      {/* Rollup chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Chip label={`${rollup.total} groups`} tone="gray" />
        <Chip label={`${rollup.ready} all members loaded`} tone="green" />
        <Chip label={`${rollup.pending_approval} pending approval`} tone="amber" />
        <Chip label={`${rollup.blocked} blocked by deps`} tone="red" />
        {rollup.no_total > 0 && (
          <Chip label={`${rollup.no_total} need Members_Total set`} tone="blue" />
        )}
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
        {filtered.length === 0 && !loading && (
          <div style={{ gridColumn: '1 / -1', padding: 32, textAlign: 'center', color: '#9ca3af' }}>
            No validation groups found for {mock}.
          </div>
        )}
        {filtered.map(g => (
          <VGCard
            key={g.Validation_Group_ID}
            mock={mock}
            vg={g}
            userEmail={userEmail}
            onSaved={load}
            onOpenDetail={() => setSelectedVG(g)}
          />
        ))}
      </div>

      {selectedVG && (
        <VGMembersPanel
          mock={mock}
          vg={selectedVG}
          userBUFilter={userBUFilter}
          onClose={() => setSelectedVG(null)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function VGCard({ mock, vg, userEmail, onSaved, onOpenDetail }: {
  mock: string; vg: VG; userEmail: string; onSaved: () => void;
  onOpenDetail: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [membersTotal, setMembersTotal] = useState(String(vg.Members_Total ?? 0));
  const [errorThreshold, setErrorThreshold] = useState(String(vg.Error_Threshold ?? 0));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=update_validation_group`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, vg_id: vg.Validation_Group_ID,
          members_total: parseInt(membersTotal, 10),
          error_threshold: parseInt(errorThreshold, 10),
          actor: userEmail,
        }),
      });
      const r = await resp.json();
      if (!r.ok) setErr(r.error || 'Save failed');
      else { setEditing(false); onSaved(); }
    } catch (e) { setErr(`Network error: ${(e as Error).message}`); }
    finally { setSaving(false); }
  };

  const loaded = vg.Members_Currently_Loaded ?? 0;
  const total = vg.Members_Total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const allLoaded = vg.All_Members_Loaded === 'Y';
  const deps = vg.dependencies || { total: 0, loaded: 0, blocking: 0 };
  const depsBlocking = deps.blocking > 0;
  const status = vg.Latest_Validation_Status || '—';
  const approval = vg.Latest_Approval_Status || '';

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 14 }}>{vg.Validation_Group_ID}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {vg.Pillar} · {vg.Module} · {vg.Data_Entity || '—'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          {status !== '—' && <Chip label={status} tone={pillToneForStatus(status)} small />}
          {approval && <Chip label={`Approval: ${approval}`} tone={pillToneForStatus(approval)} small />}
        </div>
      </div>

      {/* Progress */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
          <span>Members loaded</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: allLoaded ? '#15803d' : '#111' }}>
            {loaded} / {total || '?'}
          </span>
        </div>
        <div style={{ height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{
            width: total > 0 ? `${pct}%` : '0%',
            height: '100%',
            background: allLoaded ? '#16a34a' : (total === 0 ? '#9ca3af' : '#3b82f6'),
            transition: 'width 0.3s',
          }} />
        </div>
        {total === 0 && (
          <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
            Members_Total is 0 — set a value so auto-trigger can fire.
          </div>
        )}
      </div>

      {/* Dependencies */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span style={{ color: '#6b7280' }}>Dependencies</span>
        <span style={{
          fontFamily: 'monospace',
          color: depsBlocking ? '#dc2626' : (deps.total === 0 ? '#9ca3af' : '#15803d'),
          fontWeight: 600,
        }}>
          {deps.loaded} / {deps.total} loaded {depsBlocking ? `· ${deps.blocking} blocking` : ''}
        </span>
      </div>

      {/* Editor */}
      {!editing ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#6b7280', borderTop: '1px dashed #e5e7eb', paddingTop: 8 }}>
          <span>Error threshold: <strong style={{ color: '#111' }}>{vg.Error_Threshold ?? 0}</strong></span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={onOpenDetail}
              className="btn btn-primary"
              style={{ padding: '4px 10px', fontSize: 12 }}
            >
              View members
            </button>
            <button onClick={() => setEditing(true)} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}>
              Edit totals
            </button>
          </div>
        </div>
      ) : (
        <div style={{ borderTop: '1px dashed #e5e7eb', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {err && <div style={{ color: '#dc2626', fontSize: 11 }}>{err}</div>}
          <label style={{ fontSize: 11, color: '#6b7280' }}>
            Members_Total
            <input
              type="number" min="0" value={membersTotal}
              onChange={e => setMembersTotal(e.target.value)}
              style={{ width: '100%', padding: 6, border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13, marginTop: 2 }}
            />
          </label>
          <label style={{ fontSize: 11, color: '#6b7280' }}>
            Error_Threshold
            <input
              type="number" min="0" value={errorThreshold}
              onChange={e => setErrorThreshold(e.target.value)}
              style={{ width: '100%', padding: 6, border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13, marginTop: 2 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} disabled={saving} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}>Cancel</button>
            <button onClick={save} disabled={saving} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 12 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {vg.Current_Validation_Run_ID && (
        <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
          Current run: {vg.Current_Validation_Run_ID} · {vg.Validation_Run_Count || 0} total
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 6.6 — VG Members detail panel
// ────────────────────────────────────────────────────────────────────────────
interface VGMember {
  entity: string;
  subentity: string;
  source: string;
  table_name: string;
  file_expected: string | null;
  explicit_vg_match: boolean;
  business_unit: string | null;
  parent_entity: string | null;
  expected_filename_pattern: string | null;
  current_process_stage: string | null;
  load_status: 'loaded' | 'pending' | 'failed' | 'in_flight' | 'superseded';
  file: {
    AWS_eTag: string;
    File_Name: string;
    File_Status: string;
    Error_Type: string | null;
    Record_Count: number | null;
    Received_DateTime: string | null;
    Processed_DateTime: string | null;
    Supersedes_eTag: string | null;
    Superseded_By_eTag: string | null;
    Moved_To_Folder: string | null;
  } | null;
}

interface VGMembersResp {
  ok: boolean;
  vg_id: string;
  mock_number: string;
  members: VGMember[];
  stats: { total: number; loaded: number; pending: number; failed: number; in_flight: number; superseded: number };
  error?: string;
}

function VGMembersPanel({ mock, vg, userBUFilter, onClose }: {
  mock: string;
  vg: VG;
  userBUFilter: string[] | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<VGMembersResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    (async () => {
      try {
        const url = `${LAMBDA_URL}?action=validation_group_members&mock=${encodeURIComponent(mock)}&vgid=${encodeURIComponent(vg.Validation_Group_ID)}`;
        const resp = await fetch(url);
        const d: VGMembersResp = await resp.json();
        if (!d.ok) setError(d.error || 'Load failed');
        else setData(d);
      } catch (e) { setError(`Network error: ${(e as Error).message}`); }
      finally { setLoading(false); }
    })();
  }, [mock, vg.Validation_Group_ID]);

  // Apply BU permission filter client-side
  const visibleMembers = useMemo(() => {
    const all = data?.members || [];
    if (!userBUFilter) return all;
    if (userBUFilter.length === 0) return [];
    const allowed = new Set(userBUFilter);
    return all.filter(m => {
      if (!m.business_unit) return true;
      const bus = m.business_unit.split(',').map(s => s.trim().replace(/^0+/, '') || '0');
      return bus.some(b => allowed.has(b));
    });
  }, [data, userBUFilter]);
  const hiddenByBU = (data?.members.length || 0) - visibleMembers.length;

  const loaded = visibleMembers.filter(m => m.load_status === 'loaded');
  const pending = visibleMembers.filter(m => m.load_status === 'pending');
  const failed = visibleMembers.filter(m => m.load_status === 'failed');
  const inFlight = visibleMembers.filter(m => m.load_status === 'in_flight');
  const superseded = visibleMembers.filter(m => m.load_status === 'superseded');

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed', right: 0, top: 0, bottom: 0,
          width: 'min(680px, 96vw)', background: '#fff',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
          padding: 20, overflowY: 'auto', zIndex: 1000,
        }}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: 'monospace' }}>{vg.Validation_Group_ID}</h2>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{vg.Validation_Group_Name}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{vg.Pillar} · {vg.Module} · {mock}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </header>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {loading && !data ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>Loading members…</div>
        ) : data && (
          <>
            {/* Stats summary */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <Chip label={`${data.stats.total} members`} tone="gray" small />
              <Chip label={`${data.stats.loaded} loaded`} tone="green" small />
              {data.stats.pending > 0 && <Chip label={`${data.stats.pending} pending`} tone="amber" small />}
              {data.stats.failed > 0 && <Chip label={`${data.stats.failed} failed`} tone="red" small />}
              {data.stats.in_flight > 0 && <Chip label={`${data.stats.in_flight} in flight`} tone="blue" small />}
              {data.stats.superseded > 0 && <Chip label={`${data.stats.superseded} superseded`} tone="purple" small />}
              {hiddenByBU > 0 && (
                <Chip label={`${hiddenByBU} hidden by BU`} tone="amber" small />
              )}
            </div>

            {visibleMembers.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                {data.members.length === 0
                  ? <>No members found. Add entities for this group via <strong>File Config → + Add new file</strong> (set Validation_Group_ID = {vg.Validation_Group_ID}).</>
                  : 'All members hidden by your BU permissions.'}
              </div>
            )}

            {/* Loaded */}
            {loaded.length > 0 && (
              <MemberSection title={`Loaded (${loaded.length})`} tone="green">
                {loaded.map(m => <MemberRow key={`${m.subentity}-${m.source}`} m={m} />)}
              </MemberSection>
            )}

            {/* Pending */}
            {pending.length > 0 && (
              <MemberSection title={`Pending (${pending.length})`} tone="amber">
                <div style={{ fontSize: 11, color: '#92400e', marginBottom: 6 }}>
                  No file has been uploaded yet for these entities. The Validation Group can&apos;t fire
                  until every required member reaches Table Load Success.
                </div>
                {pending.map(m => <MemberRow key={`${m.subentity}-${m.source}`} m={m} />)}
              </MemberSection>
            )}

            {/* Failed */}
            {failed.length > 0 && (
              <MemberSection title={`Failed (${failed.length})`} tone="red">
                <div style={{ fontSize: 11, color: '#991b1b', marginBottom: 6 }}>
                  These members have a gate-check or TSQL-load failure as their latest upload. A new
                  successful upload will move them to Loaded.
                </div>
                {failed.map(m => <MemberRow key={`${m.subentity}-${m.source}`} m={m} />)}
              </MemberSection>
            )}

            {/* In flight */}
            {inFlight.length > 0 && (
              <MemberSection title={`In flight (${inFlight.length})`} tone="blue">
                {inFlight.map(m => <MemberRow key={`${m.subentity}-${m.source}`} m={m} />)}
              </MemberSection>
            )}

            {/* Superseded */}
            {superseded.length > 0 && (
              <MemberSection title={`Superseded only (${superseded.length})`} tone="purple">
                <div style={{ fontSize: 11, color: '#5b21b6', marginBottom: 6 }}>
                  Latest active version is superseded — typically transient between a re-upload.
                </div>
                {superseded.map(m => <MemberRow key={`${m.subentity}-${m.source}`} m={m} />)}
              </MemberSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MemberSection({ title, tone, children }: {
  title: string;
  tone: 'green' | 'amber' | 'red' | 'blue' | 'purple';
  children: React.ReactNode;
}) {
  const tones = {
    green: '#16a34a', amber: '#d97706', red: '#dc2626', blue: '#2563eb', purple: '#7c3aed',
  };
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{
        margin: '0 0 8px 0', fontSize: 12, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: 0.5,
        color: tones[tone],
        borderLeft: `3px solid ${tones[tone]}`, paddingLeft: 8,
      }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </section>
  );
}

function MemberRow({ m }: { m: VGMember }) {
  const fmt = (s: string | null | undefined) => s ? new Date(s).toLocaleString() : '';
  return (
    <div style={{
      background: '#f9fafb', borderRadius: 6, padding: 10,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{m.entity || m.subentity}</div>
          <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
            {m.subentity} · {m.source}
            {!m.explicit_vg_match && (
              <span style={{ marginLeft: 6, color: '#92400e', fontStyle: 'italic' }}>(derived)</span>
            )}
          </div>
        </div>
        {m.business_unit && (
          <Chip label={`BU ${m.business_unit}`} tone="blue" small />
        )}
      </div>

      <div style={{ fontSize: 11, color: '#374151', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        → {m.table_name || '— no table —'}
      </div>

      {m.file ? (
        <div style={{
          borderTop: '1px dashed #e5e7eb', marginTop: 2, paddingTop: 6,
          fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#6b7280' }}>File</span>
            <span style={{ fontFamily: 'monospace', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.file.File_Name}>
              {m.file.File_Name}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#6b7280' }}>Status</span>
            <Chip label={m.file.File_Status} tone={pillToneForStatus(m.file.File_Status)} small />
          </div>
          {m.file.Error_Type && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Error type</span>
              <span style={{ color: '#dc2626' }}>{m.file.Error_Type}</span>
            </div>
          )}
          {m.file.Record_Count != null && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Records</span>
              <span style={{ fontFamily: 'monospace' }}>{m.file.Record_Count.toLocaleString()}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#6b7280' }}>eTag</span>
            <span style={{ fontFamily: 'monospace' }}>{m.file.AWS_eTag.slice(0, 16)}…</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#6b7280' }}>Received</span>
            <span style={{ fontSize: 10 }}>{fmt(m.file.Received_DateTime)}</span>
          </div>
          {m.file.Processed_DateTime && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Processed</span>
              <span style={{ fontSize: 10 }}>{fmt(m.file.Processed_DateTime)}</span>
            </div>
          )}
        </div>
      ) : (
        <div style={{
          borderTop: '1px dashed #e5e7eb', marginTop: 2, paddingTop: 6,
          fontSize: 11, color: '#9ca3af', fontStyle: 'italic',
        }}>
          No upload received yet.
          {m.expected_filename_pattern && (
            <> Expected filename: <code style={{ fontFamily: 'monospace' }}>{m.expected_filename_pattern}</code></>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Shared UI bits (used by multiple Phase 6.3 tabs)
// ────────────────────────────────────────────────────────────────────────────
export function Chip({ label, tone = 'gray', small }: {
  label: string; tone?: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'purple'; small?: boolean;
}) {
  const tones: Record<string, { bg: string; fg: string }> = {
    gray:   { bg: '#f3f4f6', fg: '#374151' },
    green:  { bg: '#dcfce7', fg: '#166534' },
    red:    { bg: '#fee2e2', fg: '#991b1b' },
    amber:  { bg: '#fef3c7', fg: '#92400e' },
    blue:   { bg: '#dbeafe', fg: '#1e40af' },
    purple: { bg: '#ddd6fe', fg: '#5b21b6' },
  };
  const c = tones[tone];
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '2px 8px' : '4px 10px',
      borderRadius: 999,
      background: c.bg, color: c.fg,
      fontSize: small ? 11 : 12, fontWeight: 600,
    }}>
      {label}
    </span>
  );
}

// Reusable notice shown on tabs where rows aren't directly BU-scoped.
// Validation Groups / Runs / VBL Groups aggregate across multiple entities
// and many sources, so we can't reliably hide whole rows by BU permission.
// We surface a notice instead so BU-restricted users know which entities
// (in the AWS Files + File Config tabs) they actually own decisions on.
export function BUScopeNotice({ userBUFilter }: { userBUFilter: string[] }) {
  return (
    <div style={{
      background: '#dbeafe', border: '1px solid #93c5fd', color: '#1e40af',
      padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
    }}>
      <strong>BU scope:</strong> You can view group/run state across all
      groups, but downstream decisions are restricted to BUs you own:
      <span style={{ marginLeft: 6, fontFamily: 'monospace', fontWeight: 600 }}>
        {userBUFilter.join(', ')}
      </span>
      . The <strong>AWS Files</strong> and <strong>File Config</strong> tabs
      filter rows by BU automatically.
    </div>
  );
}

export function pillToneForStatus(s: string): 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'purple' {
  if (!s) return 'gray';
  const t = s.toLowerCase();
  if (t.includes('approved') || t.includes('passed') || t.includes('complete')) return 'green';
  if (t.includes('reject') || t.includes('fail') || t.includes('error')) return 'red';
  if (t.includes('pending') || t.includes('running')) return 'amber';
  if (t.includes('sent') || t.includes('distributed')) return 'purple';
  return 'gray';
}

export function LabelledInput({ label, value, onChange, placeholder, width }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; width?: number;
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: width || 200, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
      />
    </label>
  );
}
