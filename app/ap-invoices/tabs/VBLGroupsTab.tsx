'use client';
/**
 * Phase 6.3 — VBL Groups dashboard tab.
 *
 * Read-only summary that mirrors /admin/vbl-approvals but lives inside the
 * main dashboard for at-a-glance review. Each card shows:
 *   - member matrix (which VGs Approved / Pending / Blocking)
 *   - generated-file rollup (Conversion Load + Recon + VBL eTags)
 *   - Sterling status
 *   - Distribution rollup (per-BU split file count from AWS_FILES)
 * Action buttons surface but link out to /admin/vbl-approvals.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Chip, LabelledInput, pillToneForStatus, BUScopeNotice } from './ValidationGroupsTab';

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface VBLMember {
  Validation_Group_ID: string;
  Required: string;
  Val_To_Source_Approval_Status: string | null;
  Blocks_VBL_Trigger: string | null;
  Val_To_Source_Approval_DateTime: string | null;
}

interface VBL {
  VBL_Group_ID: string;
  VBL_Group_Name: string | null;
  Pillar: string | null;
  Module: string | null;
  Val_To_Source_Members_Total: number | null;
  Val_To_Source_Members_Approved: number | null;
  All_Val_To_Source_Approved: string | null;
  Latest_VBL_Status: string | null;
  Latest_VBL_DateTime: string | null;
  VBL_File_eTag: string | null;
  Recon_File_eTag: string | null;
  Conversion_Load_File_eTag: string | null;
  Sterling_Transmission_Status: string | null;
  Sterling_Transmission_DateTime: string | null;
  Latest_Approval_Status: string | null;
  Latest_Approver: string | null;
  Latest_Approval_DateTime: string | null;
  members: VBLMember[];
}

export function VBLGroupsTab({ userBUFilter }: {
  userBUFilter: string[] | null;
}) {
  const [mock, setMock] = useState('MOCK12');
  const [groups, setGroups] = useState<VBL[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [distCounts, setDistCounts] = useState<Record<string, number>>({});
  // Phase 6.7 — create + edit modals
  const [showCreate, setShowCreate] = useState(false);
  const [editingGroup, setEditingGroup] = useState<VBL | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=vbl_groups&mock=${encodeURIComponent(mock)}`);
      const d = await resp.json();
      if (!d.ok) { setError(d.error || 'Load failed'); setGroups([]); }
      else setGroups(d.groups || []);
    } catch (e) { setError(`Network error: ${(e as Error).message}`); }
    finally { setLoading(false); }
  }, [mock]);

  useEffect(() => { load(); }, [load]);

  // Light-weight distribution rollup — count AWS_FILES rows per VBL group
  // where category starts with 'Distribution -'. Best-effort; failures are
  // silent because the cards still render the rest of the data.
  useEffect(() => {
    (async () => {
      const counts: Record<string, number> = {};
      for (const g of groups) {
        try {
          const r = await fetch(
            `${LAMBDA_URL}?action=aws_files&mock=${encodeURIComponent(mock)}&vbl=${encodeURIComponent(g.VBL_Group_ID)}&limit=1&offset=0`
          );
          const d = await r.json();
          if (d.ok && typeof d.total === 'number') counts[g.VBL_Group_ID] = d.total;
        } catch { /* silent */ }
      }
      setDistCounts(counts);
    })();
  }, [groups, mock]);

  const rollup = useMemo(() => ({
    total: groups.length,
    approved: groups.filter(g => g.Latest_Approval_Status === 'Approved').length,
    sent: groups.filter(g => g.Sterling_Transmission_Status === 'Submitted').length,
    pending: groups.filter(g => g.Latest_VBL_Status === 'Pending Approval').length,
  }), [groups]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'end', marginBottom: 12,
        padding: 12, background: '#f9fafb', borderRadius: 8, flexWrap: 'wrap',
      }}>
        <LabelledInput label="Mock" value={mock} onChange={v => setMock(v.toUpperCase())} width={110} />
        <button className="btn btn-primary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          onClick={() => setShowCreate(true)}
          style={{ padding: '8px 14px', borderRadius: 6, background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer' }}
        >
          + Add VBL Group
        </button>
        <a
          href="/admin/vbl-approvals"
          style={{ marginLeft: 'auto', textDecoration: 'none', padding: '8px 14px', borderRadius: 6, background: '#1d4ed8', color: '#fff', fontSize: 13, fontWeight: 600 }}
        >
          ⇗ Open VBL + Sterling console
        </a>
      </div>

      {userBUFilter && userBUFilter.length > 0 && (
        <BUScopeNotice userBUFilter={userBUFilter} />
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Chip label={`${rollup.total} VBL groups`} tone="gray" />
        <Chip label={`${rollup.pending} pending approval`} tone="amber" />
        <Chip label={`${rollup.approved} approved`} tone="green" />
        <Chip label={`${rollup.sent} sent to Sterling`} tone="purple" />
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
        {groups.length === 0 && !loading && (
          <div style={{ gridColumn: '1 / -1', padding: 32, textAlign: 'center', color: '#9ca3af' }}>
            No VBL groups for {mock}.
          </div>
        )}
        {groups.map(g => (
          <VBLCard
            key={g.VBL_Group_ID}
            g={g}
            distributionCount={distCounts[g.VBL_Group_ID]}
            onEditMembers={() => setEditingGroup(g)}
          />
        ))}
      </div>

      {showCreate && (
        <CreateVBLModal
          mock={mock}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); load(); }}
        />
      )}

      {editingGroup && (
        <EditVBLMembersModal
          mock={mock}
          group={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSaved={() => { setEditingGroup(null); load(); }}
        />
      )}
    </div>
  );
}

function VBLCard({ g, distributionCount, onEditMembers }: {
  g: VBL;
  distributionCount?: number;
  onEditMembers: () => void;
}) {
  const fmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—';
  const allApproved = g.All_Val_To_Source_Approved === 'Y';
  const approvedReq = g.Val_To_Source_Members_Approved ?? 0;
  const totalReq = g.Val_To_Source_Members_Total ?? 0;
  const pct = totalReq > 0 ? Math.min(100, Math.round((approvedReq / totalReq) * 100)) : 0;

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 14 }}>{g.VBL_Group_ID}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{g.VBL_Group_Name}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{g.Pillar} · {g.Module}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          {g.Latest_VBL_Status && <Chip label={g.Latest_VBL_Status} tone={pillToneForStatus(g.Latest_VBL_Status)} small />}
          {g.Latest_Approval_Status && <Chip label={`Approval: ${g.Latest_Approval_Status}`} tone={pillToneForStatus(g.Latest_Approval_Status)} small />}
          {g.Sterling_Transmission_Status && <Chip label={`Sterling: ${g.Sterling_Transmission_Status}`} tone={pillToneForStatus(g.Sterling_Transmission_Status)} small />}
        </div>
      </div>

      {/* Progress */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
          <span>Required members approved</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: allApproved ? '#15803d' : '#111' }}>
            {approvedReq} / {totalReq}
          </span>
        </div>
        <div style={{ height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{
            width: totalReq > 0 ? `${pct}%` : '0%',
            height: '100%',
            background: allApproved ? '#16a34a' : '#3b82f6',
            transition: 'width 0.3s',
          }} />
        </div>
      </div>

      {/* Members table */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600 }}>Members</div>
          <button
            onClick={onEditMembers}
            style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#374151', cursor: 'pointer' }}
          >
            Edit members
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {g.members.map(m => (
              <tr key={m.Validation_Group_ID}>
                <td style={{ padding: '3px 0', fontFamily: 'monospace' }}>{m.Validation_Group_ID}</td>
                <td style={{ padding: '3px 0', textAlign: 'center', color: '#6b7280' }}>{m.Required}</td>
                <td style={{ padding: '3px 0', textAlign: 'right' }}>
                  <Chip
                    label={m.Val_To_Source_Approval_Status || '—'}
                    tone={pillToneForStatus(m.Val_To_Source_Approval_Status || '')}
                    small
                  />
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right', color: m.Blocks_VBL_Trigger === 'Y' ? '#dc2626' : '#15803d', fontFamily: 'monospace', fontSize: 11 }}>
                  {m.Blocks_VBL_Trigger === 'Y' ? 'blocking' : 'ok'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Generated files */}
      <div>
        <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>Generated files</div>
        <dl style={{ fontSize: 12, margin: 0 }}>
          <ETagRow label="VBL file" v={g.VBL_File_eTag} />
          <ETagRow label="Recon" v={g.Recon_File_eTag} />
          <ETagRow label="Conversion Load" v={g.Conversion_Load_File_eTag} />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
            <dt style={{ color: '#6b7280' }}>Distribution rows</dt>
            <dd style={{ margin: 0, fontFamily: 'monospace' }}>{distributionCount ?? '—'}</dd>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
            <dt style={{ color: '#6b7280' }}>VBL run finished</dt>
            <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: 11 }}>{fmt(g.Latest_VBL_DateTime)}</dd>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
            <dt style={{ color: '#6b7280' }}>Sterling sent at</dt>
            <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: 11 }}>{fmt(g.Sterling_Transmission_DateTime)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 6.7 — Create + Edit VBL Group modals
// ────────────────────────────────────────────────────────────────────────────
interface VGOption {
  Validation_Group_ID: string;
  Validation_Group_Name: string | null;
  Pillar: string | null;
  Module: string | null;
  Data_Entity: string | null;
}

function useValidationGroups(mock: string): { vgs: VGOption[]; loading: boolean; error: string } {
  const [vgs, setVgs] = useState<VGOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setLoading(true); setError('');
    (async () => {
      try {
        const resp = await fetch(`${LAMBDA_URL}?action=validation_groups&mock=${encodeURIComponent(mock)}`);
        const d = await resp.json();
        if (!d.ok) setError(d.error || 'Load failed');
        else setVgs(d.groups || []);
      } catch (e) { setError(`Network error: ${(e as Error).message}`); }
      finally { setLoading(false); }
    })();
  }, [mock]);
  return { vgs, loading, error };
}

interface MemberDraft {
  validation_group_id: string;
  required: boolean;
  source?: 'existing' | 'new';
}

function CreateVBLModal({ mock, onClose, onSaved }: {
  mock: string; onClose: () => void; onSaved: () => void;
}) {
  const { vgs, loading: vgsLoading } = useValidationGroups(mock);
  const [pillar, setPillar] = useState('FIN');
  const [module, setModule] = useState('AP');
  const [vblId, setVblId] = useState('');
  const [vblIdManuallyEdited, setVblIdManuallyEdited] = useState(false);
  const [name, setName] = useState('');
  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Auto-suggest VBL_Group_ID until user edits it manually
  useEffect(() => {
    if (!vblIdManuallyEdited) {
      setVblId(`VBL-${pillar}-${module}`);
    }
  }, [pillar, module, vblIdManuallyEdited]);

  const filteredVgs = useMemo(() => {
    let r = vgs;
    if (search) {
      const s = search.toUpperCase();
      r = r.filter(v =>
        v.Validation_Group_ID.toUpperCase().includes(s) ||
        (v.Validation_Group_Name || '').toUpperCase().includes(s) ||
        (v.Module || '').toUpperCase().includes(s)
      );
    }
    // Pre-bias the list toward matching pillar/module
    return r.sort((a, b) => {
      const aMatch = (a.Module || '') === module ? -1 : 0;
      const bMatch = (b.Module || '') === module ? -1 : 0;
      return aMatch - bMatch;
    });
  }, [vgs, search, module]);

  const toggleMember = (vgId: string) => {
    const existing = members.findIndex(m => m.validation_group_id === vgId);
    if (existing >= 0) {
      setMembers(members.filter((_, i) => i !== existing));
    } else {
      setMembers([...members, { validation_group_id: vgId, required: true }]);
    }
  };

  const updateRequired = (vgId: string, required: boolean) => {
    setMembers(members.map(m =>
      m.validation_group_id === vgId ? { ...m, required } : m
    ));
  };

  const submit = async () => {
    setError('');
    if (!vblId.trim() || !name.trim() || !pillar || !module || members.length === 0) {
      setError('Fill in all fields and add at least one member.');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=create_vbl_group`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock,
          payload: {
            vbl_group_id: vblId.trim().toUpperCase(),
            vbl_group_name: name.trim(),
            pillar: pillar.trim().toUpperCase(),
            module: module.trim().toUpperCase(),
            members: members.map(m => ({
              validation_group_id: m.validation_group_id,
              required: m.required,
            })),
          },
          actor: '',
        }),
      });
      const d = await resp.json();
      if (!d.ok) setError(d.error || 'Save failed');
      else onSaved();
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally { setSubmitting(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 12, padding: 24,
        width: 'min(760px, 96vw)', maxHeight: '92vh', overflowY: 'auto',
        boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
      }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Create VBL Group in {mock}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </header>

        <p style={{ fontSize: 13, color: '#4b5563', marginTop: 0 }}>
          Defines a Validation-Before-Load group and picks which Validation
          Groups must be approved before the Conversion Load + Recon + VBL
          files are generated.
        </p>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '120px 120px 1fr', gap: 12, marginBottom: 12 }}>
          <Field label="Pillar *">
            <select value={pillar} onChange={e => setPillar(e.target.value)} style={vblFieldStyle()}>
              <option>FIN</option>
              <option>HCM</option>
              <option>SCM</option>
            </select>
          </Field>
          <Field label="Module *">
            <input value={module} onChange={e => setModule(e.target.value.toUpperCase())} placeholder="AP / GL / PO" style={vblFieldStyle()} />
          </Field>
          <Field label="VBL Group ID *">
            <input
              value={vblId}
              onChange={e => { setVblIdManuallyEdited(true); setVblId(e.target.value.toUpperCase()); }}
              placeholder="VBL-FIN-AP"
              style={vblFieldStyle('monospace')}
            />
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {!vblIdManuallyEdited
                ? 'Auto-suggested from Pillar + Module. Edit to override.'
                : <button onClick={() => { setVblIdManuallyEdited(false); }} style={{ background: 'none', border: 'none', color: '#1d4ed8', cursor: 'pointer', padding: 0, fontSize: 11, textDecoration: 'underline' }}>Reset to auto</button>}
            </div>
          </Field>
        </div>

        <Field label="VBL Group Name *">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="FIN Accounts Payable — Before Load Validation" style={vblFieldStyle()} />
        </Field>

        <section style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>
              Member Validation Groups <span style={{ color: '#6b7280', fontWeight: 400 }}>({members.length} selected, {members.filter(m => m.required).length} required)</span>
            </h3>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search VGs…"
              style={{ width: 200, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
            />
          </div>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 320, overflowY: 'auto' }}>
            {vgsLoading && <div style={{ padding: 12, color: '#6b7280', fontSize: 13 }}>Loading…</div>}
            {!vgsLoading && filteredVgs.length === 0 && (
              <div style={{ padding: 12, color: '#9ca3af', fontSize: 13 }}>
                No Validation Groups for {mock}.
              </div>
            )}
            {filteredVgs.map(vg => {
              const checked = members.some(m => m.validation_group_id === vg.Validation_Group_ID);
              const required = members.find(m => m.validation_group_id === vg.Validation_Group_ID)?.required ?? true;
              return (
                <label
                  key={vg.Validation_Group_ID}
                  style={{
                    display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 8, alignItems: 'center',
                    padding: '8px 12px', borderBottom: '1px solid #f3f4f6',
                    background: checked ? '#eff6ff' : '#fff', cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox" checked={checked}
                    onChange={() => toggleMember(vg.Validation_Group_ID)}
                  />
                  <div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{vg.Validation_Group_ID}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>
                      {vg.Validation_Group_Name || ''} · {vg.Pillar} / {vg.Module}
                    </div>
                  </div>
                  {checked && (
                    <select
                      value={required ? 'Y' : 'N'}
                      onChange={e => updateRequired(vg.Validation_Group_ID, e.target.value === 'Y')}
                      onClick={e => e.stopPropagation()}
                      style={{ padding: 4, border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, background: '#fff' }}
                    >
                      <option value="Y">Required</option>
                      <option value="N">Optional</option>
                    </select>
                  )}
                </label>
              );
            })}
          </div>
        </section>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create VBL Group'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditVBLMembersModal({ mock, group, onClose, onSaved }: {
  mock: string; group: VBL; onClose: () => void; onSaved: () => void;
}) {
  const { vgs, loading: vgsLoading } = useValidationGroups(mock);
  const [members, setMembers] = useState<MemberDraft[]>(
    group.members.map(m => ({
      validation_group_id: m.Validation_Group_ID,
      required: (m.Required || '').toUpperCase() === 'Y',
      source: 'existing',
    }))
  );
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const filteredVgs = useMemo(() => {
    if (!search) return vgs;
    const s = search.toUpperCase();
    return vgs.filter(v =>
      v.Validation_Group_ID.toUpperCase().includes(s) ||
      (v.Validation_Group_Name || '').toUpperCase().includes(s) ||
      (v.Module || '').toUpperCase().includes(s)
    );
  }, [vgs, search]);

  const toggleMember = (vgId: string) => {
    const existing = members.findIndex(m => m.validation_group_id === vgId);
    if (existing >= 0) {
      setMembers(members.filter((_, i) => i !== existing));
    } else {
      setMembers([...members, { validation_group_id: vgId, required: true, source: 'new' }]);
    }
  };

  const updateRequired = (vgId: string, required: boolean) => {
    setMembers(members.map(m =>
      m.validation_group_id === vgId ? { ...m, required } : m
    ));
  };

  const submit = async () => {
    setError('');
    if (members.length === 0) { setError('At least one member is required.'); return; }
    if (!window.confirm(
      `Replace the members of ${group.VBL_Group_ID} with ${members.length} entry/entries ` +
      `(${members.filter(m => m.required).length} required)? Existing approval state on dropped ` +
      `members will be lost; remaining members keep their approval state on the next VG decide.`
    )) return;

    setSubmitting(true);
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=update_vbl_members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock,
          vbl_group_id: group.VBL_Group_ID,
          members: members.map(m => ({
            validation_group_id: m.validation_group_id,
            required: m.required,
          })),
          actor: '',
        }),
      });
      const d = await resp.json();
      if (!d.ok) setError(d.error || 'Save failed');
      else onSaved();
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally { setSubmitting(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 12, padding: 24,
        width: 'min(720px, 96vw)', maxHeight: '92vh', overflowY: 'auto',
        boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
      }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: 'monospace' }}>{group.VBL_Group_ID}</h2>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{group.VBL_Group_Name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </header>

        <p style={{ fontSize: 13, color: '#4b5563', marginTop: 0 }}>
          Edit which Validation Groups belong to this VBL group. Membership
          changes are non-destructive to in-flight runs — but Members_Approved
          and All_Val_To_Source_Approved are recomputed from scratch.
        </p>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>
            Members <span style={{ color: '#6b7280', fontWeight: 400 }}>({members.length} selected, {members.filter(m => m.required).length} required)</span>
          </h3>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search VGs…"
            style={{ width: 200, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
          />
        </div>

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 380, overflowY: 'auto' }}>
          {vgsLoading && <div style={{ padding: 12, color: '#6b7280', fontSize: 13 }}>Loading…</div>}
          {filteredVgs.map(vg => {
            const memberEntry = members.find(m => m.validation_group_id === vg.Validation_Group_ID);
            const checked = !!memberEntry;
            const required = memberEntry?.required ?? true;
            return (
              <label
                key={vg.Validation_Group_ID}
                style={{
                  display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 8, alignItems: 'center',
                  padding: '8px 12px', borderBottom: '1px solid #f3f4f6',
                  background: checked ? '#eff6ff' : '#fff', cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox" checked={checked}
                  onChange={() => toggleMember(vg.Validation_Group_ID)}
                />
                <div>
                  <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{vg.Validation_Group_ID}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    {vg.Validation_Group_Name || ''} · {vg.Pillar} / {vg.Module}
                    {memberEntry?.source === 'existing' && (
                      <span style={{ marginLeft: 6, color: '#15803d' }}>existing</span>
                    )}
                    {memberEntry?.source === 'new' && (
                      <span style={{ marginLeft: 6, color: '#1d4ed8' }}>new</span>
                    )}
                  </div>
                </div>
                {checked && (
                  <select
                    value={required ? 'Y' : 'N'}
                    onChange={e => updateRequired(vg.Validation_Group_ID, e.target.value === 'Y')}
                    onClick={e => e.stopPropagation()}
                    style={{ padding: 4, border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, background: '#fff' }}
                  >
                    <option value="Y">Required</option>
                    <option value="N">Optional</option>
                  </select>
                )}
              </label>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save members'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

function vblFieldStyle(family?: string): React.CSSProperties {
  return {
    width: '100%', padding: '8px 10px',
    border: '1px solid #d1d5db', borderRadius: 6,
    fontSize: 13, fontFamily: family || 'inherit',
    background: '#fff',
  };
}

function ETagRow({ label, v }: { label: string; v: string | null }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
      <dt style={{ color: '#6b7280' }}>{label}</dt>
      <dd style={{ margin: 0, fontFamily: 'monospace', color: v ? '#111' : '#9ca3af' }}>
        {v ? v.slice(0, 12) + '…' : '—'}
      </dd>
    </div>
  );
}
