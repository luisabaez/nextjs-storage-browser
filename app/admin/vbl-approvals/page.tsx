'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../../components/enhanced-file-browser.css';
import '../admin.css';
import config from '../../../amplify_outputs.json';
import { isAdminUser } from '../types';
import Link from 'next/link';

Amplify.configure(config);

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

interface VBLGroup {
  VBL_Group_ID: string;
  VBL_Group_Name: string;
  Pillar: string;
  Module: string;
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

function VBLApprovalsPage() {
  const [userEmail, setUserEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  const [mock, setMock] = useState('MOCK12');
  const [groups, setGroups] = useState<VBLGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Decision modal state
  const [decidingGroup, setDecidingGroup] = useState<VBLGroup | null>(null);
  const [decision, setDecision] = useState<'Approved' | 'Rejected'>('Approved');
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Sterling modal state
  const [sterlingGroup, setSterlingGroup] = useState<VBLGroup | null>(null);
  const [sterlingStatus, setSterlingStatus] = useState<'Submitted' | 'Error'>('Submitted');
  const [sterlingNotes, setSterlingNotes] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const a = await fetchUserAttributes();
        const email = a.email || '';
        setUserEmail(email);
        setIsAdmin(isAdminUser(email));
      } catch (e) { console.error(e); }
      finally { setAuthChecked(true); }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=vbl_groups&mock=${encodeURIComponent(mock)}`);
      const data = await resp.json();
      if (!data.ok) setError(data.error || 'Failed to load VBL groups');
      else setGroups(data.groups || []);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally { setLoading(false); }
  }, [mock]);

  useEffect(() => { if (authChecked && isAdmin) load(); }, [authChecked, isAdmin, load]);

  const submitDecision = async () => {
    if (!decidingGroup) return;
    if (!comments.trim()) { setError('Comments required'); return; }
    setSubmitting(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=vbl_run_decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, vbl_group_id: decidingGroup.VBL_Group_ID,
          decision, comments: comments.trim(), actor: userEmail,
        }),
      });
      const data = await resp.json();
      if (!data.ok) setError(data.error || 'Decision failed');
      else { setDecidingGroup(null); setComments(''); await load(); }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally { setSubmitting(false); }
  };

  const submitSterling = async () => {
    if (!sterlingGroup) return;
    setSubmitting(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=mark_sterling_sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, vbl_group_id: sterlingGroup.VBL_Group_ID,
          sterling_status: sterlingStatus,
          error_notes: sterlingStatus === 'Error' ? sterlingNotes.trim() : '',
          actor: userEmail,
        }),
      });
      const data = await resp.json();
      if (!data.ok) setError(data.error || 'Sterling update failed');
      else {
        setSterlingGroup(null);
        setSterlingNotes('');
        setSterlingStatus('Submitted');
        await load();
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally { setSubmitting(false); }
  };

  if (!authChecked) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!isAdmin) return (
    <div style={{ padding: 40 }}>
      <h2>Access denied</h2>
      <p>Admin role required to approve VBL runs.</p>
      <Link href="/admin" className="btn btn-secondary">Back to Admin</Link>
    </div>
  );

  return (
    <div className="admin-container" style={{ maxWidth: 1400, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>VBL Approvals + Sterling</h1>
        <Link href="/admin" className="btn btn-secondary">← Back to Admin</Link>
      </header>

      <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <label>
          <span style={{ fontSize: 13, fontWeight: 600, marginRight: 6 }}>Mock</span>
          <input
            value={mock}
            onChange={e => setMock(e.target.value.toUpperCase())}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, width: 120 }}
            disabled={loading}
          />
        </label>
        <button className="btn btn-primary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#4b5563' }}>
          {groups.length} VBL group(s)
        </div>
      </section>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 12, borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {groups.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
          No VBL groups in {mock}.
        </div>
      ) : groups.map(g => (
        <VBLGroupCard
          key={g.VBL_Group_ID}
          group={g}
          onDecide={() => { setDecidingGroup(g); setDecision('Approved'); setComments(''); }}
          onSterling={() => { setSterlingGroup(g); setSterlingStatus('Submitted'); setSterlingNotes(''); }}
        />
      ))}

      {/* Decision modal */}
      {decidingGroup && (
        <Modal onClose={() => setDecidingGroup(null)}>
          <h3 style={{ marginTop: 0 }}>{decidingGroup.VBL_Group_ID} — VBL Decision</h3>
          <p style={{ color: '#4b5563', fontSize: 13 }}>{decidingGroup.VBL_Group_Name}</p>
          <div style={{ background: '#f9fafb', padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
            <div>Members approved: <strong>{decidingGroup.Val_To_Source_Members_Approved} / {decidingGroup.Val_To_Source_Members_Total}</strong></div>
            <div>VBL file: <code>{decidingGroup.VBL_File_eTag ? decidingGroup.VBL_File_eTag.slice(0, 12) + '…' : '—'}</code></div>
            <div>Recon: <code>{decidingGroup.Recon_File_eTag ? decidingGroup.Recon_File_eTag.slice(0, 12) + '…' : '—'}</code></div>
            <div>Conversion Load: <code>{decidingGroup.Conversion_Load_File_eTag ? decidingGroup.Conversion_Load_File_eTag.slice(0, 12) + '…' : '—'}</code></div>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <button
              onClick={() => setDecision('Approved')}
              style={{ flex: 1, padding: 10, background: decision === 'Approved' ? '#16a34a' : '#fff', color: decision === 'Approved' ? '#fff' : '#111', border: '1px solid #16a34a', borderRadius: 6 }}
            >✓ Approve</button>
            <button
              onClick={() => setDecision('Rejected')}
              style={{ flex: 1, padding: 10, background: decision === 'Rejected' ? '#dc2626' : '#fff', color: decision === 'Rejected' ? '#fff' : '#111', border: '1px solid #dc2626', borderRadius: 6 }}
            >✕ Reject</button>
          </div>
          <textarea
            value={comments}
            onChange={e => setComments(e.target.value)}
            placeholder="Comments (required)…"
            style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6, minHeight: 70, fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => setDecidingGroup(null)} disabled={submitting}>Cancel</button>
            <button
              onClick={submitDecision}
              disabled={submitting}
              style={{ padding: '8px 16px', borderRadius: 6, color: '#fff', background: decision === 'Approved' ? '#16a34a' : '#dc2626', border: 'none' }}
            >
              {submitting ? 'Submitting…' : `Submit ${decision}`}
            </button>
          </div>
        </Modal>
      )}

      {/* Sterling modal */}
      {sterlingGroup && (
        <Modal onClose={() => setSterlingGroup(null)}>
          <h3 style={{ marginTop: 0 }}>{sterlingGroup.VBL_Group_ID} — Sterling Transmission</h3>
          <p style={{ color: '#4b5563', fontSize: 13, marginBottom: 16 }}>
            Per spec, Sterling is a <strong>status update on the existing Conversion Load
            AWS_FILES row</strong> — no new S3 event. This will update both the VBL group
            row AND the Conversion Load file&apos;s lifecycle.
          </p>
          <div style={{ background: '#f9fafb', padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
            Conversion Load eTag: <code>{sterlingGroup.Conversion_Load_File_eTag ? sterlingGroup.Conversion_Load_File_eTag.slice(0, 12) + '…' : '—'}</code>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <button
              onClick={() => setSterlingStatus('Submitted')}
              style={{ flex: 1, padding: 10, background: sterlingStatus === 'Submitted' ? '#1d4ed8' : '#fff', color: sterlingStatus === 'Submitted' ? '#fff' : '#111', border: '1px solid #1d4ed8', borderRadius: 6 }}
            >✓ Submitted</button>
            <button
              onClick={() => setSterlingStatus('Error')}
              style={{ flex: 1, padding: 10, background: sterlingStatus === 'Error' ? '#dc2626' : '#fff', color: sterlingStatus === 'Error' ? '#fff' : '#111', border: '1px solid #dc2626', borderRadius: 6 }}
            >✕ Error</button>
          </div>
          {sterlingStatus === 'Error' && (
            <textarea
              value={sterlingNotes}
              onChange={e => setSterlingNotes(e.target.value)}
              placeholder="Sterling error notes…"
              style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6, minHeight: 70, fontFamily: 'inherit', marginBottom: 12 }}
            />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => setSterlingGroup(null)} disabled={submitting}>Cancel</button>
            <button
              onClick={submitSterling}
              disabled={submitting}
              style={{ padding: '8px 16px', borderRadius: 6, color: '#fff', background: sterlingStatus === 'Submitted' ? '#1d4ed8' : '#dc2626', border: 'none' }}
            >
              {submitting ? 'Submitting…' : `Mark ${sterlingStatus}`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function VBLGroupCard({ group, onDecide, onSterling }: {
  group: VBLGroup; onDecide: () => void; onSterling: () => void;
}) {
  const fmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—';
  const allApproved = group.All_Val_To_Source_Approved === 'Y';
  const status = group.Latest_VBL_Status || '—';
  const approvalStatus = group.Latest_Approval_Status || '';
  const sterlingStatus = group.Sterling_Transmission_Status || '';
  const canDecide = (status === 'Pending Approval' || status === 'Pending Trigger') && allApproved;
  const canSendSterling = approvalStatus === 'Approved' && !!group.Conversion_Load_File_eTag &&
                          sterlingStatus !== 'Submitted';

  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0' }}>{group.VBL_Group_ID}</h2>
          <div style={{ color: '#4b5563', fontSize: 14 }}>{group.VBL_Group_Name}</div>
          <div style={{ color: '#6b7280', fontSize: 12, marginTop: 4 }}>
            {group.Pillar} · {group.Module}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <StatusPill label={status} />
          {approvalStatus && (
            <div style={{ marginTop: 4 }}>
              <StatusPill label={`Approval: ${approvalStatus}`} tone={approvalStatus === 'Approved' ? 'green' : approvalStatus === 'Rejected' ? 'red' : 'gray'} />
            </div>
          )}
          {sterlingStatus && (
            <div style={{ marginTop: 4 }}>
              <StatusPill label={`Sterling: ${sterlingStatus}`} tone={sterlingStatus === 'Submitted' ? 'blue' : sterlingStatus === 'Error' ? 'red' : 'gray'} />
            </div>
          )}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#6b7280', textTransform: 'uppercase' }}>Members</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: 6 }}>Validation Group</th>
                <th style={{ padding: 6 }}>Required</th>
                <th style={{ padding: 6 }}>Status</th>
                <th style={{ padding: 6 }}>Blocks?</th>
              </tr>
            </thead>
            <tbody>
              {group.members.map(m => (
                <tr key={m.Validation_Group_ID}>
                  <td style={{ padding: 6, borderTop: '1px solid #f3f4f6', fontFamily: 'monospace' }}>{m.Validation_Group_ID}</td>
                  <td style={{ padding: 6, borderTop: '1px solid #f3f4f6' }}>{m.Required}</td>
                  <td style={{ padding: 6, borderTop: '1px solid #f3f4f6', color: m.Val_To_Source_Approval_Status === 'Approved' ? '#15803d' : '#6b7280' }}>
                    {m.Val_To_Source_Approval_Status || '—'}
                  </td>
                  <td style={{ padding: 6, borderTop: '1px solid #f3f4f6', color: m.Blocks_VBL_Trigger === 'Y' ? '#b91c1c' : '#15803d' }}>
                    {m.Blocks_VBL_Trigger || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#6b7280', textTransform: 'uppercase' }}>Generated Files</h4>
          <dl style={{ fontSize: 13, margin: 0 }}>
            <Row label="Members approved" value={`${group.Val_To_Source_Members_Approved ?? 0} / ${group.Val_To_Source_Members_Total ?? 0}`} highlight={allApproved} />
            <Row label="VBL file" value={group.VBL_File_eTag ? group.VBL_File_eTag.slice(0, 12) + '…' : '—'} />
            <Row label="Recon file" value={group.Recon_File_eTag ? group.Recon_File_eTag.slice(0, 12) + '…' : '—'} />
            <Row label="Conversion Load" value={group.Conversion_Load_File_eTag ? group.Conversion_Load_File_eTag.slice(0, 12) + '…' : '—'} />
            <Row label="VBL run finished" value={fmt(group.Latest_VBL_DateTime)} />
            <Row label="Approver" value={group.Latest_Approver || '—'} />
            <Row label="Approved at" value={fmt(group.Latest_Approval_DateTime)} />
            <Row label="Sterling at" value={fmt(group.Sterling_Transmission_DateTime)} />
          </dl>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        {canDecide && (
          <button className="btn btn-primary" onClick={onDecide}>
            Decide VBL Run
          </button>
        )}
        {canSendSterling && (
          <button
            onClick={onSterling}
            style={{ padding: '8px 16px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            Mark Sterling Status
          </button>
        )}
      </div>
    </section>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f3f4f6' }}>
      <dt style={{ color: '#6b7280' }}>{label}</dt>
      <dd style={{ margin: 0, fontFamily: 'monospace', color: highlight ? '#15803d' : '#111', fontWeight: highlight ? 600 : 400 }}>{value}</dd>
    </div>
  );
}

function StatusPill({ label, tone = 'gray' }: { label: string; tone?: 'gray' | 'green' | 'red' | 'blue' | 'amber' }) {
  const colours: Record<string, { bg: string; fg: string }> = {
    gray:  { bg: '#f3f4f6', fg: '#374151' },
    green: { bg: '#dcfce7', fg: '#166534' },
    red:   { bg: '#fee2e2', fg: '#991b1b' },
    blue:  { bg: '#dbeafe', fg: '#1e40af' },
    amber: { bg: '#fef3c7', fg: '#92400e' },
  };
  // Auto-tone by label keyword
  if (tone === 'gray') {
    if (/approved|sent|complete/i.test(label)) tone = 'green';
    else if (/reject|error|fail/i.test(label)) tone = 'red';
    else if (/pending|running/i.test(label))   tone = 'amber';
  }
  const c = colours[tone];
  return (
    <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 999, background: c.bg, color: c.fg, fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 24, width: 'min(580px, 90vw)', boxShadow: '0 24px 48px rgba(0,0,0,0.2)' }}>
        {children}
      </div>
    </div>
  );
}

export default withAuthenticator(VBLApprovalsPage);
