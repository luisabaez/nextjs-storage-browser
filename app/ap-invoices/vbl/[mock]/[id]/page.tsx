'use client';
/**
 * Phase 6.8 — VBL Group Detail page.
 *
 * Route: /ap-invoices/vbl/[mock]/[id]
 *
 * Full-screen view of a single VBL group with:
 *   - Header: VBL_Group_ID + name + breadcrumb back
 *   - Three editable metadata fields (Name + Notes), saved inline via
 *     ?action=update_vbl_group
 *   - Status panel: Latest_VBL_Status / Approval / Sterling pills,
 *     timestamps, generated-file eTag list
 *   - Members panel with the same per-row Required/Optional toggle the
 *     Edit Members modal had — saves via ?action=update_vbl_members
 *   - Distribution row count (from AWS_FILES?vbl=)
 *   - Run history (latest 10 from ?action=validation_runs filtered to
 *     member VG IDs — best-effort lookup)
 *   - Delete button at the bottom with typed-confirmation, calls
 *     ?action=delete_vbl_group
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import { fetchUserAttributes } from 'aws-amplify/auth';
import '@aws-amplify/ui-react/styles.css';
import config from '../../../../../amplify_outputs.json';

Amplify.configure(config as any);

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface VBLMember {
  VBL_Group_ID: string;
  Validation_Group_ID: string;
  Required: string;
  Val_To_Source_Latest_Status: string | null;
  Val_To_Source_Approval_Status: string | null;
  Val_To_Source_Approval_DateTime: string | null;
  Blocks_VBL_Trigger: string | null;
}

interface VBL {
  VBL_Group_ID: string;
  VBL_Group_Name: string | null;
  Mock_Number: string | null;
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
  Latest_Approval_Comments: string | null;
  members: VBLMember[];
  Notes?: string | null;
}

interface VGOption {
  Validation_Group_ID: string;
  Validation_Group_Name: string | null;
  Pillar: string | null;
  Module: string | null;
}

function VBLDetailPage() {
  const router = useRouter();
  const params = useParams();
  const mock = decodeURIComponent(params.mock as string);
  const vblId = decodeURIComponent(params.id as string);

  const [userEmail, setUserEmail] = useState('');
  const [group, setGroup] = useState<VBL | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [distributionCount, setDistributionCount] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const a = await fetchUserAttributes();
        setUserEmail(a.email || '');
      } catch { /* ignore */ }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=vbl_groups&mock=${encodeURIComponent(mock)}`);
      const d = await resp.json();
      if (!d.ok) { setError(d.error || 'Load failed'); setGroup(null); }
      else {
        const found = (d.groups || []).find((g: VBL) => g.VBL_Group_ID === vblId);
        if (!found) setError(`VBL group '${vblId}' not found in ${mock}`);
        else setGroup(found);
      }
    } catch (e) { setError(`Network error: ${(e as Error).message}`); }
    finally { setLoading(false); }
  }, [mock, vblId]);

  useEffect(() => { load(); }, [load]);

  // Distribution rollup
  useEffect(() => {
    if (!group) return;
    (async () => {
      try {
        const r = await fetch(`${LAMBDA_URL}?action=aws_files&mock=${encodeURIComponent(mock)}&vbl=${encodeURIComponent(vblId)}&limit=1&offset=0`);
        const d = await r.json();
        if (d.ok && typeof d.total === 'number') setDistributionCount(d.total);
      } catch { /* silent */ }
    })();
  }, [group, mock, vblId]);

  if (loading && !group) {
    return <PageShell title="Loading…" onBack={() => router.push('/ap-invoices')} />;
  }
  if (error && !group) {
    return (
      <PageShell title="Error" onBack={() => router.push('/ap-invoices')}>
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 12, borderRadius: 6 }}>
          {error}
        </div>
      </PageShell>
    );
  }
  if (!group) return null;

  return (
    <PageShell
      title={group.VBL_Group_ID}
      subtitle={`${group.VBL_Group_Name || '—'} · ${group.Pillar} · ${group.Module} · ${group.Mock_Number}`}
      onBack={() => router.push('/ap-invoices')}
    >
      <Metadata group={group} mock={mock} userEmail={userEmail} onSaved={load} />
      <StatusPanel group={group} distributionCount={distributionCount} />
      <MembersPanel group={group} mock={mock} userEmail={userEmail} onSaved={load} />
      <DangerZone group={group} mock={mock} userEmail={userEmail} onDeleted={() => router.push('/ap-invoices')} />
    </PageShell>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function PageShell({ title, subtitle, onBack, children }: {
  title: string; subtitle?: string; onBack: () => void; children?: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <header style={{
        background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '16px 24px',
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'none', border: '1px solid #d1d5db', borderRadius: 6,
            padding: '6px 12px', fontSize: 13, cursor: 'pointer',
          }}
        >
          ← Back to dashboard
        </button>
        <div>
          <h1 style={{ margin: 0, fontFamily: 'monospace', fontSize: 22 }}>{title}</h1>
          {subtitle && <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{subtitle}</div>}
        </div>
      </header>
      <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {children}
      </main>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function Metadata({ group, mock, userEmail, onSaved }: {
  group: VBL; mock: string; userEmail: string; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.VBL_Group_Name || '');
  const [notes, setNotes] = useState(group.Notes || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=update_vbl_group`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, vbl_group_id: group.VBL_Group_ID,
          updates: { VBL_Group_Name: name, Notes: notes },
          actor: userEmail,
        }),
      });
      const d = await resp.json();
      if (!d.ok) setErr(d.error || 'Save failed');
      else { setEditing(false); onSaved(); }
    } catch (e) { setErr(`Network error: ${(e as Error).message}`); }
    finally { setSaving(false); }
  };

  return (
    <Card title="Metadata" right={!editing && (
      <button onClick={() => setEditing(true)} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}>Edit</button>
    )}>
      {err && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 6 }}>{err}</div>}
      <Row label="VBL Group ID" value={group.VBL_Group_ID} mono />
      <Row label="Pillar" value={group.Pillar} />
      <Row label="Module" value={group.Module} />
      <Row label="Mock" value={group.Mock_Number} />
      {editing ? (
        <>
          <FieldLabel>VBL Group Name</FieldLabel>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle()} />
          <FieldLabel>Notes</FieldLabel>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ ...inputStyle(), minHeight: 80, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button onClick={() => { setEditing(false); setName(group.VBL_Group_Name || ''); setNotes(group.Notes || ''); }} className="btn btn-secondary" disabled={saving}>Cancel</button>
            <button onClick={save} className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <>
          <Row label="VBL Group Name" value={group.VBL_Group_Name} />
          <Row label="Notes" value={group.Notes || '—'} />
        </>
      )}
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function StatusPanel({ group, distributionCount }: { group: VBL; distributionCount: number | null }) {
  const fmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—';
  return (
    <Card title="Run state">
      <Row label="Latest_VBL_Status" value={group.Latest_VBL_Status} pill />
      <Row label="Latest_Approval_Status" value={group.Latest_Approval_Status} pill />
      <Row label="Latest_Approver" value={group.Latest_Approver} />
      <Row label="Latest_VBL_DateTime" value={fmt(group.Latest_VBL_DateTime)} />
      <Row label="Latest_Approval_DateTime" value={fmt(group.Latest_Approval_DateTime)} />
      <Row label="Latest_Approval_Comments" value={group.Latest_Approval_Comments || '—'} />
      <Divider />
      <Row label="VBL_File_eTag" value={group.VBL_File_eTag ? group.VBL_File_eTag.slice(0, 16) + '…' : '—'} mono />
      <Row label="Recon_File_eTag" value={group.Recon_File_eTag ? group.Recon_File_eTag.slice(0, 16) + '…' : '—'} mono />
      <Row label="Conversion_Load_File_eTag" value={group.Conversion_Load_File_eTag ? group.Conversion_Load_File_eTag.slice(0, 16) + '…' : '—'} mono />
      <Divider />
      <Row label="Sterling_Transmission_Status" value={group.Sterling_Transmission_Status || '—'} pill />
      <Row label="Sterling_Transmission_DateTime" value={fmt(group.Sterling_Transmission_DateTime)} />
      <Divider />
      <Row label="Distribution rows" value={distributionCount === null ? '—' : String(distributionCount)} mono />
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function MembersPanel({ group, mock, userEmail, onSaved }: {
  group: VBL; mock: string; userEmail: string; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [allVgs, setAllVgs] = useState<VGOption[]>([]);
  const [members, setMembers] = useState(
    group.members.map(m => ({
      validation_group_id: m.Validation_Group_ID,
      required: (m.Required || '').toUpperCase() === 'Y',
      source: 'existing' as 'existing' | 'new',
    }))
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${LAMBDA_URL}?action=validation_groups&mock=${encodeURIComponent(mock)}`);
        const d = await resp.json();
        if (d.ok) setAllVgs(d.groups || []);
      } catch { /* silent */ }
    })();
  }, [mock]);

  const filtered = useMemo(() => {
    if (!search) return allVgs;
    const s = search.toUpperCase();
    return allVgs.filter(v =>
      v.Validation_Group_ID.toUpperCase().includes(s) ||
      (v.Validation_Group_Name || '').toUpperCase().includes(s) ||
      (v.Module || '').toUpperCase().includes(s)
    );
  }, [allVgs, search]);

  const toggle = (vgId: string) => {
    const idx = members.findIndex(m => m.validation_group_id === vgId);
    if (idx >= 0) setMembers(members.filter((_, i) => i !== idx));
    else setMembers([...members, { validation_group_id: vgId, required: true, source: 'new' }]);
  };
  const updateReq = (vgId: string, required: boolean) => {
    setMembers(members.map(m => m.validation_group_id === vgId ? { ...m, required } : m));
  };

  const save = async () => {
    setErr('');
    if (members.length === 0) { setErr('At least one member is required.'); return; }
    if (!window.confirm(
      `Replace the members of ${group.VBL_Group_ID} with ${members.length} entry/entries ` +
      `(${members.filter(m => m.required).length} required)? Existing approval state on dropped ` +
      `members will be lost.`
    )) return;
    setSaving(true);
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=update_vbl_members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, vbl_group_id: group.VBL_Group_ID,
          members: members.map(m => ({
            validation_group_id: m.validation_group_id,
            required: m.required,
          })),
          actor: userEmail,
        }),
      });
      const d = await resp.json();
      if (!d.ok) setErr(d.error || 'Save failed');
      else { setEditing(false); onSaved(); }
    } catch (e) { setErr(`Network error: ${(e as Error).message}`); }
    finally { setSaving(false); }
  };

  return (
    <Card
      title={`Members (${group.members.length})`}
      right={!editing && (
        <button onClick={() => setEditing(true)} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}>Edit members</button>
      )}
    >
      {err && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 6 }}>{err}</div>}
      {!editing ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
              <th style={{ padding: 8 }}>Validation Group</th>
              <th style={{ padding: 8, textAlign: 'center' }}>Required</th>
              <th style={{ padding: 8 }}>Approval Status</th>
              <th style={{ padding: 8 }}>Blocks?</th>
            </tr>
          </thead>
          <tbody>
            {group.members.map(m => (
              <tr key={m.Validation_Group_ID}>
                <td style={{ padding: 8, fontFamily: 'monospace' }}>{m.Validation_Group_ID}</td>
                <td style={{ padding: 8, textAlign: 'center' }}>{m.Required}</td>
                <td style={{ padding: 8, color: m.Val_To_Source_Approval_Status === 'Approved' ? '#15803d' : '#6b7280' }}>
                  {m.Val_To_Source_Approval_Status || '—'}
                </td>
                <td style={{ padding: 8, color: m.Blocks_VBL_Trigger === 'Y' ? '#dc2626' : '#15803d' }}>
                  {m.Blocks_VBL_Trigger || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {members.length} selected · {members.filter(m => m.required).length} required
            </div>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search VGs…"
              style={{ width: 200, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
            />
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 380, overflowY: 'auto' }}>
            {filtered.map(vg => {
              const me = members.find(m => m.validation_group_id === vg.Validation_Group_ID);
              const checked = !!me;
              return (
                <label
                  key={vg.Validation_Group_ID}
                  style={{
                    display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 8, alignItems: 'center',
                    padding: '8px 12px', borderBottom: '1px solid #f3f4f6',
                    background: checked ? '#eff6ff' : '#fff', cursor: 'pointer',
                  }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(vg.Validation_Group_ID)} />
                  <div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{vg.Validation_Group_ID}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>
                      {vg.Validation_Group_Name || ''} · {vg.Pillar} / {vg.Module}
                      {me?.source === 'existing' && <span style={{ marginLeft: 6, color: '#15803d' }}>existing</span>}
                      {me?.source === 'new' && <span style={{ marginLeft: 6, color: '#1d4ed8' }}>new</span>}
                    </div>
                  </div>
                  {checked && (
                    <select
                      value={me!.required ? 'Y' : 'N'}
                      onChange={e => updateReq(vg.Validation_Group_ID, e.target.value === 'Y')}
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button
              onClick={() => {
                setEditing(false);
                setMembers(group.members.map(m => ({
                  validation_group_id: m.Validation_Group_ID,
                  required: (m.Required || '').toUpperCase() === 'Y',
                  source: 'existing' as const,
                })));
              }}
              className="btn btn-secondary" disabled={saving}
            >Cancel</button>
            <button onClick={save} className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save members'}</button>
          </div>
        </>
      )}
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function DangerZone({ group, mock, userEmail, onDeleted }: {
  group: VBL; mock: string; userEmail: string; onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState('');

  const expected = group.VBL_Group_ID;
  const ready = confirmText === expected;

  const doDelete = async () => {
    if (!ready) return;
    setDeleting(true); setErr('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=delete_vbl_group`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, vbl_group_id: group.VBL_Group_ID, actor: userEmail,
        }),
      });
      const d = await resp.json();
      if (!d.ok) setErr(d.error || 'Delete failed');
      else onDeleted();
    } catch (e) { setErr(`Network error: ${(e as Error).message}`); }
    finally { setDeleting(false); }
  };

  return (
    <div style={{
      background: '#fff', border: '1px solid #fecaca', borderRadius: 8, padding: 16,
    }}>
      <h3 style={{ margin: '0 0 8px 0', color: '#991b1b', fontSize: 14 }}>Danger zone</h3>
      <p style={{ fontSize: 13, color: '#4b5563', marginTop: 0 }}>
        Deleting this VBL group removes both <code>VBL_GROUPS_{mock}</code> and all{' '}
        <code>VBL_GROUP_MEMBERS_{mock}</code> rows for it. <strong>AWS_FILES rows are not touched</strong> —
        the event log retains the historical record. Any in-flight VBL run state is lost.
      </p>
      <p style={{ fontSize: 13, color: '#4b5563' }}>
        Type the VBL ID <code style={{ background: '#fef2f2', color: '#991b1b', padding: '2px 6px', borderRadius: 4 }}>{expected}</code> to confirm:
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          placeholder={expected}
          style={{ ...inputStyle(), maxWidth: 320 }}
        />
        <button
          onClick={doDelete}
          disabled={!ready || deleting}
          style={{
            padding: '8px 16px', borderRadius: 6, border: 'none',
            background: ready ? '#dc2626' : '#fca5a5', color: '#fff',
            cursor: ready ? 'pointer' : 'not-allowed', fontWeight: 600,
          }}
        >
          {deleting ? 'Deleting…' : 'Delete VBL group'}
        </button>
      </div>
      {err && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111' }}>{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function Row({ label, value, pill, mono }: { label: string; value: string | null; pill?: boolean; mono?: boolean }) {
  const tone = (v: string | null): { bg: string; fg: string } => {
    if (!v) return { bg: '#f3f4f6', fg: '#374151' };
    const t = v.toLowerCase();
    if (t.includes('approved') || t.includes('passed')) return { bg: '#dcfce7', fg: '#166534' };
    if (t.includes('reject') || t.includes('fail') || t.includes('error')) return { bg: '#fee2e2', fg: '#991b1b' };
    if (t.includes('pending') || t.includes('running')) return { bg: '#fef3c7', fg: '#92400e' };
    if (t.includes('sent') || t.includes('submitted')) return { bg: '#ddd6fe', fg: '#5b21b6' };
    return { bg: '#f3f4f6', fg: '#374151' };
  };
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 12, color: '#6b7280' }}>{label}</span>
      {pill && value ? (
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
          background: tone(value).bg, color: tone(value).fg,
          fontSize: 11, fontWeight: 600,
        }}>{value}</span>
      ) : (
        <span style={{
          fontSize: 13, fontFamily: mono ? 'monospace' : 'inherit',
          textAlign: 'right', wordBreak: 'break-all',
        }}>{value || '—'}</span>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px dashed #e5e7eb', margin: '8px 0' }} />;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4, marginTop: 10 }}>{children}</div>;
}

function inputStyle(): React.CSSProperties {
  return {
    width: '100%', padding: '8px 10px',
    border: '1px solid #d1d5db', borderRadius: 6,
    fontSize: 13, background: '#fff',
  };
}

export default withAuthenticator(VBLDetailPage);
