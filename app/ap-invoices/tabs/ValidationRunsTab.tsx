'use client';
/**
 * Phase 6.3 — Validation Runs tab.
 *
 * Read-only history of every VAL-NNNN run with filters by group and status.
 * Click any row to see the full triggered-by eTag, comments, etc.
 * Decision making lives in /admin/validation-approvals (Phase 4).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Chip, LabelledInput, pillToneForStatus } from './ValidationGroupsTab';

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface Run {
  Validation_Run_ID: string;
  Validation_Group_ID: string;
  Run_Number: number;
  Trigger_Reason: string | null;
  Run_Status: string | null;
  Error_Count: number | null;
  Warning_Count: number | null;
  Informative_Record_Count: number | null;
  Threshold_Exceeded: string | null;
  Reextract_Required: string | null;
  Affected_Members: string | null;
  Run_Start_DateTime: string | null;
  Run_End_DateTime: string | null;
  Approval_Status: string | null;
  Approver_Email: string | null;
  Approval_DateTime: string | null;
}

const STATUS_OPTIONS = [
  '', 'Pending Trigger', 'Running', 'Pending Approval', 'Approved', 'Rejected',
];

export function ValidationRunsTab() {
  const [mock, setMock] = useState('MOCK12');
  const [statusFilter, setStatusFilter] = useState('');
  const [vgFilter, setVgFilter] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Run | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ action: 'validation_runs', mock });
      if (statusFilter) qs.set('status', statusFilter);
      const resp = await fetch(`${LAMBDA_URL}?${qs.toString()}`);
      const d = await resp.json();
      if (!d.ok) { setError(d.error || 'Load failed'); setRuns([]); }
      else setRuns(d.runs || []);
    } catch (e) { setError(`Network error: ${(e as Error).message}`); }
    finally { setLoading(false); }
  }, [mock, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!vgFilter) return runs;
    const s = vgFilter.toUpperCase();
    return runs.filter(r => r.Validation_Group_ID.toUpperCase().includes(s));
  }, [runs, vgFilter]);

  const rollup = useMemo(() => ({
    total: runs.length,
    pending: runs.filter(r => r.Run_Status === 'Pending Approval').length,
    approved: runs.filter(r => r.Approval_Status === 'Approved').length,
    rejected: runs.filter(r => r.Approval_Status === 'Rejected').length,
  }), [runs]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'end', marginBottom: 12,
        padding: 12, background: '#f9fafb', borderRadius: 8, flexWrap: 'wrap',
      }}>
        <LabelledInput label="Mock" value={mock} onChange={v => setMock(v.toUpperCase())} width={110} />
        <LabelledInput label="Validation Group" value={vgFilter} onChange={setVgFilter} placeholder="APINV-PRIFAS" width={200} />
        <label style={{ display: 'block' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2 }}>Status</div>
          <select
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13, width: 180, background: '#fff' }}
          >
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s || '— In flight (default) —'}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <a
          href="/admin/validation-approvals"
          style={{ marginLeft: 'auto', textDecoration: 'none', padding: '8px 14px', borderRadius: 6, background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 600 }}
        >
          ⇗ Open approver console
        </a>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Chip label={`${rollup.total} runs in view`} tone="gray" />
        <Chip label={`${rollup.pending} pending approval`} tone="amber" />
        <Chip label={`${rollup.approved} approved`} tone="green" />
        <Chip label={`${rollup.rejected} rejected`} tone="red" />
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1000 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
              <th style={{ padding: 8 }}>Run ID</th>
              <th style={{ padding: 8 }}>Group</th>
              <th style={{ padding: 8, textAlign: 'center' }}>#</th>
              <th style={{ padding: 8 }}>Trigger</th>
              <th style={{ padding: 8 }}>Status</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Errors</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Warnings</th>
              <th style={{ padding: 8 }}>Threshold</th>
              <th style={{ padding: 8 }}>Approval</th>
              <th style={{ padding: 8 }}>Started</th>
              <th style={{ padding: 8 }}>Finished</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                No runs yet. Runs fire automatically once a Validation Group has Members_Total set
                and all members reach Table Load Success.
              </td></tr>
            )}
            {filtered.map((r, i) => (
              <tr
                key={r.Validation_Run_ID}
                onClick={() => setSelected(r)}
                style={{ cursor: 'pointer', background: i % 2 === 0 ? '#fff' : '#fafafa' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#eff6ff')}
                onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa')}
              >
                <td style={{ padding: 8, fontFamily: 'monospace', fontWeight: 600 }}>{r.Validation_Run_ID}</td>
                <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.Validation_Group_ID}</td>
                <td style={{ padding: 8, textAlign: 'center' }}>{r.Run_Number}</td>
                <td style={{ padding: 8 }}>{r.Trigger_Reason || '—'}</td>
                <td style={{ padding: 8 }}>
                  <Chip label={r.Run_Status || '—'} tone={pillToneForStatus(r.Run_Status || '')} small />
                </td>
                <td style={{ padding: 8, textAlign: 'right', color: (r.Error_Count ?? 0) > 0 ? '#dc2626' : '#111' }}>
                  {r.Error_Count ?? '—'}
                </td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.Warning_Count ?? '—'}</td>
                <td style={{ padding: 8 }}>
                  {r.Threshold_Exceeded && (
                    <Chip label={r.Threshold_Exceeded} tone={r.Threshold_Exceeded === 'Y' ? 'red' : 'gray'} small />
                  )}
                </td>
                <td style={{ padding: 8 }}>
                  {r.Approval_Status && <Chip label={r.Approval_Status} tone={pillToneForStatus(r.Approval_Status)} small />}
                </td>
                <td style={{ padding: 8, fontSize: 11, color: '#6b7280' }}>
                  {r.Run_Start_DateTime ? new Date(r.Run_Start_DateTime).toLocaleString() : '—'}
                </td>
                <td style={{ padding: 8, fontSize: 11, color: '#6b7280' }}>
                  {r.Run_End_DateTime ? new Date(r.Run_End_DateTime).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && <RunDetailPanel run={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function RunDetailPanel({ run, onClose }: { run: Run; onClose: () => void }) {
  const fmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—';
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999 }}>
      <div onClick={e => e.stopPropagation()} style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: 'min(520px, 95vw)', background: '#fff',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
        padding: 20, overflowY: 'auto', zIndex: 1000,
      }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: 'monospace' }}>{run.Validation_Run_ID}</h2>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{run.Validation_Group_ID}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </header>

        <Block title="Run">
          <Row label="Run number" value={String(run.Run_Number)} />
          <Row label="Trigger reason" value={run.Trigger_Reason || '—'} />
          <Row label="Status" value={run.Run_Status || '—'} pill toneFn={pillToneForStatus} />
          <Row label="Started" value={fmt(run.Run_Start_DateTime)} />
          <Row label="Finished" value={fmt(run.Run_End_DateTime)} />
        </Block>

        <Block title="Counts">
          <Row label="Errors" value={String(run.Error_Count ?? '—')} highlight={(run.Error_Count ?? 0) > 0 ? '#dc2626' : undefined} />
          <Row label="Warnings" value={String(run.Warning_Count ?? '—')} />
          <Row label="Informative" value={String(run.Informative_Record_Count ?? '—')} />
          <Row label="Threshold exceeded" value={run.Threshold_Exceeded || '—'} />
          <Row label="Reextract required" value={run.Reextract_Required || '—'} />
        </Block>

        {run.Affected_Members && (
          <Block title="Affected members">
            <div style={{ fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
              {run.Affected_Members.split(';').map(m => m.trim()).filter(Boolean).join('\n')}
            </div>
          </Block>
        )}

        {(run.Approval_Status || run.Approver_Email) && (
          <Block title="Approval">
            <Row label="Status" value={run.Approval_Status || '—'} pill toneFn={pillToneForStatus} />
            <Row label="Approver" value={run.Approver_Email || '—'} />
            <Row label="Decided at" value={fmt(run.Approval_DateTime)} />
          </Block>
        )}

        <div style={{ marginTop: 16 }}>
          <a
            href="/admin/validation-approvals"
            style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 6, background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
          >
            Open approver console
          </a>
        </div>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px 0' }}>{title}</h3>
      <div style={{ background: '#f9fafb', borderRadius: 6, padding: 10 }}>{children}</div>
    </section>
  );
}

function Row({ label, value, pill, toneFn, highlight }: {
  label: string; value: string; pill?: boolean;
  toneFn?: (v: string) => 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'purple';
  highlight?: string;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 12, color: '#6b7280' }}>{label}</span>
      {pill && toneFn ? (
        <Chip label={value} tone={toneFn(value)} small />
      ) : (
        <span style={{ fontSize: 13, fontFamily: 'monospace', textAlign: 'right', color: highlight || '#111', fontWeight: highlight ? 700 : 400 }}>{value}</span>
      )}
    </div>
  );
}
