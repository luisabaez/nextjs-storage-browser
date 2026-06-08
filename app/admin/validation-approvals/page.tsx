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

interface ValidationRun {
  Validation_Run_ID: string;
  Validation_Group_ID: string;
  Run_Number: number;
  Trigger_Reason: string;
  Run_Status: string;
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

function ValidationApprovalsPage() {
  const [userEmail, setUserEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  const [mock, setMock] = useState('MOCK12');
  const [runs, setRuns] = useState<ValidationRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Decision modal state
  const [decidingRun, setDecidingRun] = useState<ValidationRun | null>(null);
  const [decision, setDecision] = useState<'Approved' | 'Rejected'>('Approved');
  const [comments, setComments] = useState('');
  const [reextract, setReextract] = useState(false);
  const [affected, setAffected] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
      const url = `${LAMBDA_URL}?action=validation_runs&mock=${encodeURIComponent(mock)}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data.ok) setError(data.error || 'Failed to load runs');
      else setRuns(data.runs || []);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [mock]);

  useEffect(() => { if (authChecked && isAdmin) load(); }, [authChecked, isAdmin, load]);

  const openDecide = (r: ValidationRun) => {
    setDecidingRun(r);
    setDecision('Approved');
    setComments('');
    setReextract((r.Threshold_Exceeded === 'Y'));
    setAffected('');
  };

  const submitDecision = async () => {
    if (!decidingRun) return;
    if (!comments.trim()) { setError('Comments required'); return; }
    if (decision === 'Rejected' && reextract && !affected.trim()) {
      setError('Affected members required when re-extract requested');
      return;
    }
    setSubmitting(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=validation_run_decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock,
          run_id: decidingRun.Validation_Run_ID,
          decision,
          comments: comments.trim(),
          reextract_required: decision === 'Rejected' && reextract,
          affected_members: affected.trim(),
          actor: userEmail,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        setError(data.error || 'Decision failed');
      } else {
        setDecidingRun(null);
        await load();
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (!authChecked) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!isAdmin) return (
    <div style={{ padding: 40 }}>
      <h2>Access denied</h2><p>Admin role required to approve validation runs.</p>
      <Link href="/admin" className="btn btn-secondary">Back to Admin</Link>
    </div>
  );

  const pending = runs.filter(r => r.Run_Status === 'Pending Approval');
  const other   = runs.filter(r => r.Run_Status !== 'Pending Approval');

  return (
    <div className="admin-container" style={{ maxWidth: 1300, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Validation Approvals</h1>
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
          {pending.length} pending · {other.length} in flight
        </div>
      </section>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 12, borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Pending Approval ({pending.length})</h2>
        {pending.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No runs awaiting approval.</p>
        ) : (
          <RunTable runs={pending} onDecide={openDecide} showActions />
        )}
      </section>

      <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>In Flight ({other.length})</h2>
        {other.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No runs in flight.</p>
        ) : (
          <RunTable runs={other} onDecide={openDecide} showActions={false} />
        )}
      </section>

      {decidingRun && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 'min(560px, 90vw)', boxShadow: '0 24px 48px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0 }}>
              {decidingRun.Validation_Run_ID} — {decidingRun.Validation_Group_ID}
            </h3>
            <div style={{ background: '#f9fafb', padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
              <div>Errors: <strong>{decidingRun.Error_Count ?? '—'}</strong></div>
              <div>Warnings: <strong>{decidingRun.Warning_Count ?? '—'}</strong></div>
              <div>Informative: <strong>{decidingRun.Informative_Record_Count ?? '—'}</strong></div>
              <div>Threshold exceeded: <strong>{decidingRun.Threshold_Exceeded ?? '—'}</strong></div>
            </div>

            <label style={{ display: 'block', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Decision</div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  className="btn"
                  style={{ flex: 1, padding: 10, background: decision === 'Approved' ? '#16a34a' : '#fff', color: decision === 'Approved' ? '#fff' : '#111', border: '1px solid #16a34a', borderRadius: 6 }}
                  onClick={() => setDecision('Approved')}
                >✓ Approve</button>
                <button
                  className="btn"
                  style={{ flex: 1, padding: 10, background: decision === 'Rejected' ? '#dc2626' : '#fff', color: decision === 'Rejected' ? '#fff' : '#111', border: '1px solid #dc2626', borderRadius: 6 }}
                  onClick={() => setDecision('Rejected')}
                >✕ Reject</button>
              </div>
            </label>

            <label style={{ display: 'block', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Comments <span style={{ color: '#dc2626' }}>*</span></div>
              <textarea
                value={comments}
                onChange={e => setComments(e.target.value)}
                style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6, minHeight: 70, fontFamily: 'inherit' }}
              />
            </label>

            {decision === 'Rejected' && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={reextract}
                    onChange={e => setReextract(e.target.checked)}
                  />
                  <span>Re-extract required (flips File_Expected → Y on affected members)</span>
                </label>
                {reextract && (
                  <label style={{ display: 'block', marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Affected members (semicolon-separated table names) <span style={{ color: '#dc2626' }}>*</span></div>
                    <input
                      value={affected}
                      onChange={e => setAffected(e.target.value)}
                      placeholder="e.g. FIN_AP_INVOICE_HDR_MOCK12_PRIFAS;FIN_AP_INVOICE_LINES_MOCK12_PRIFAS"
                      style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}
                    />
                  </label>
                )}
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setDecidingRun(null)} disabled={submitting}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={submitDecision}
                disabled={submitting}
                style={{ background: decision === 'Approved' ? '#16a34a' : '#dc2626', borderColor: 'transparent' }}
              >
                {submitting ? 'Submitting…' : `Submit ${decision}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunTable({ runs, onDecide, showActions }: {
  runs: ValidationRun[]; onDecide: (r: ValidationRun) => void; showActions: boolean;
}) {
  const fmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—';
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Run ID</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Group</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb', textAlign: 'center' }}>#</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Trigger</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Status</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>Err</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>Warn</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Threshold</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Started</th>
          <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Finished</th>
          {showActions && <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}></th>}
        </tr>
      </thead>
      <tbody>
        {runs.map(r => (
          <tr key={r.Validation_Run_ID}>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', fontFamily: 'monospace' }}>{r.Validation_Run_ID}</td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', fontWeight: 600 }}>{r.Validation_Group_ID}</td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', textAlign: 'center' }}>{r.Run_Number}</td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.Trigger_Reason}</td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.Run_Status}</td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', textAlign: 'right', color: (r.Error_Count ?? 0) > 0 ? '#dc2626' : '#111' }}>
              {r.Error_Count ?? '—'}
            </td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', textAlign: 'right' }}>{r.Warning_Count ?? '—'}</td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', color: r.Threshold_Exceeded === 'Y' ? '#dc2626' : '#111' }}>
              {r.Threshold_Exceeded ?? '—'}
            </td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#6b7280' }}>{fmt(r.Run_Start_DateTime)}</td>
            <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#6b7280' }}>{fmt(r.Run_End_DateTime)}</td>
            {showActions && (
              <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>
                <button className="btn btn-primary" onClick={() => onDecide(r)} style={{ fontSize: 12, padding: '4px 10px' }}>
                  Decide
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default withAuthenticator(ValidationApprovalsPage);
