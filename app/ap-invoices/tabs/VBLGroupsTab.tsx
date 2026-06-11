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
import { Chip, LabelledInput, pillToneForStatus } from './ValidationGroupsTab';

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

export function VBLGroupsTab() {
  const [mock, setMock] = useState('MOCK12');
  const [groups, setGroups] = useState<VBL[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [distCounts, setDistCounts] = useState<Record<string, number>>({});

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
        <a
          href="/admin/vbl-approvals"
          style={{ marginLeft: 'auto', textDecoration: 'none', padding: '8px 14px', borderRadius: 6, background: '#1d4ed8', color: '#fff', fontSize: 13, fontWeight: 600 }}
        >
          ⇗ Open VBL + Sterling console
        </a>
      </div>

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
          <VBLCard key={g.VBL_Group_ID} g={g} distributionCount={distCounts[g.VBL_Group_ID]} />
        ))}
      </div>
    </div>
  );
}

function VBLCard({ g, distributionCount }: { g: VBL; distributionCount?: number }) {
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
        <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>Members</div>
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
