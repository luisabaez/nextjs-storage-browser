'use client';

import React, { useEffect, useState } from 'react';
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

// Same Lambda Function URL the dashboard uses (AP-Invoice-Processor)
const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

// Shape of a dry-run preview row from the Lambda
interface TablePreview {
  table_base: string;
  source_table: string;
  target_table: string;
  source_exists: boolean;
  target_exists: boolean;
  source_row_count: number | null;
  rows_to_copy: number;
}

interface DryRunResponse {
  ok: boolean;
  dry_run: true;
  source_mock: string;
  target_mock: string;
  tables: TablePreview[];
  warnings: string[];
  error?: string;
}

interface PromoteResponse {
  ok: boolean;
  source_mock: string;
  target_mock: string;
  row_counts: Record<string, number>;
  duration_seconds: number;
  error?: string;
}

function PromoteMockPage() {
  const [userEmail, setUserEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Form
  const [sourceMock, setSourceMock] = useState('13');
  const [targetMock, setTargetMock] = useState('14');

  // Async state
  const [previewing, setPreviewing] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [preview, setPreview] = useState<DryRunResponse | null>(null);
  const [result, setResult] = useState<PromoteResponse | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const attrs = await fetchUserAttributes();
        const email = attrs.email || '';
        setUserEmail(email);
        setIsAdmin(isAdminUser(email));
      } catch (e) {
        console.error('Failed to fetch user attrs', e);
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  const runDryRun = async () => {
    setError('');
    setPreview(null);
    setResult(null);
    setPreviewing(true);
    try {
      const url =
        `${LAMBDA_URL}?action=promote_mock` +
        `&source=${encodeURIComponent(sourceMock.trim())}` +
        `&target=${encodeURIComponent(targetMock.trim())}` +
        `&actor=${encodeURIComponent(userEmail)}` +
        `&dry_run=true`;
      const resp = await fetch(url);
      const data: DryRunResponse = await resp.json();
      if (!data.ok) {
        setError(data.error || 'Preview failed');
      } else {
        setPreview(data);
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setPreviewing(false);
    }
  };

  const runPromotion = async () => {
    if (!preview) return;
    const blocked = preview.tables.some(t => t.target_exists);
    if (blocked && !window.confirm(
      'One or more target tables already exist and will be skipped. Continue?'
    )) {
      return;
    }
    if (!window.confirm(
      `This will create MOCK${targetMock} tables and copy structural rows from MOCK${sourceMock}.\n\n` +
      'Tracking columns (LoadedAt, Latest_*, Approval_*, etc.) will be cleared on the new Mock.\n\n' +
      'Proceed?'
    )) return;

    setError('');
    setResult(null);
    setPromoting(true);
    try {
      const url =
        `${LAMBDA_URL}?action=promote_mock` +
        `&source=${encodeURIComponent(sourceMock.trim())}` +
        `&target=${encodeURIComponent(targetMock.trim())}` +
        `&actor=${encodeURIComponent(userEmail)}` +
        `&dry_run=false`;
      const resp = await fetch(url);
      const data: PromoteResponse = await resp.json();
      if (!data.ok) {
        setError(data.error || 'Promotion failed');
      } else {
        setResult(data);
        // Refresh the preview against the new state so the panel reflects reality
        await runDryRun();
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setPromoting(false);
    }
  };

  if (!authChecked) {
    return <div style={{ padding: 40 }}>Loading…</div>;
  }

  if (!isAdmin) {
    return (
      <div style={{ padding: 40 }}>
        <h2>Access denied</h2>
        <p>Admin role required to promote a Mock.</p>
        <Link href="/admin" className="btn btn-secondary">Back to Admin</Link>
      </div>
    );
  }

  const canPromote = !!preview && preview.tables.some(t => t.rows_to_copy > 0);

  return (
    <div className="admin-container" style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Promote to Mock N+1</h1>
        <Link href="/admin" className="btn btn-secondary">← Back to Admin</Link>
      </header>

      <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <p style={{ marginTop: 0, color: '#444' }}>
          Clones the structural data of a source Mock into a new target Mock —
          conversion plan rows, validation groups, VBL groups & members, and VG
          dependencies. Tracking columns (file loads, validation status, approvals)
          are cleared so the new Mock starts clean. The <strong>AWS_FILES</strong>
          event log is global and is never touched by this operation.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 16, alignItems: 'end', marginTop: 16 }}>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Source Mock</div>
            <input
              type="text"
              value={sourceMock}
              onChange={e => setSourceMock(e.target.value)}
              placeholder="13"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              disabled={previewing || promoting}
            />
          </label>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Target Mock</div>
            <input
              type="text"
              value={targetMock}
              onChange={e => setTargetMock(e.target.value)}
              placeholder="14"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              disabled={previewing || promoting}
            />
          </label>
          <button
            className="btn btn-primary"
            onClick={runDryRun}
            disabled={previewing || promoting || !sourceMock.trim() || !targetMock.trim()}
            style={{ padding: '8px 16px' }}
          >
            {previewing ? 'Previewing…' : 'Preview Promotion'}
          </button>
        </div>
      </section>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 12, borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {preview && (
        <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>Preview: MOCK{preview.source_mock.replace('MOCK', '')} → MOCK{preview.target_mock.replace('MOCK', '')}</h2>

          {preview.warnings.length > 0 && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', padding: 12, borderRadius: 6, marginBottom: 16 }}>
              <strong>Warnings:</strong>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Table</th>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Source</th>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>Source rows</th>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Target</th>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb', textAlign: 'right' }}>Rows to copy</th>
              </tr>
            </thead>
            <tbody>
              {preview.tables.map(t => (
                <tr key={t.table_base}>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', fontWeight: 600 }}>{t.table_base}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', color: t.source_exists ? '#111827' : '#9ca3af' }}>
                    {t.source_table} {!t.source_exists && '(missing)'}
                  </td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', textAlign: 'right' }}>
                    {t.source_row_count == null ? '—' : t.source_row_count.toLocaleString()}
                  </td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', color: t.target_exists ? '#b91c1c' : '#15803d' }}>
                    {t.target_table} {t.target_exists ? '(already exists)' : '(will be created)'}
                  </td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', textAlign: 'right', fontWeight: 600 }}>
                    {t.rows_to_copy.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 12, marginTop: 20, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setPreview(null)} disabled={promoting}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={runPromotion}
              disabled={!canPromote || promoting}
              title={!canPromote ? 'No rows would be copied (all targets exist or sources missing)' : ''}
            >
              {promoting ? 'Promoting…' : `Promote to ${preview.target_mock}`}
            </button>
          </div>
        </section>
      )}

      {result && (
        <section style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: 20 }}>
          <h2 style={{ marginTop: 0, color: '#166534' }}>✓ Promotion complete</h2>
          <p style={{ marginBottom: 12 }}>
            <strong>{result.source_mock} → {result.target_mock}</strong> in {result.duration_seconds}s.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fff', textAlign: 'left' }}>
                <th style={{ padding: 10, borderBottom: '1px solid #d1fae5' }}>Table</th>
                <th style={{ padding: 10, borderBottom: '1px solid #d1fae5', textAlign: 'right' }}>Rows copied</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result.row_counts).map(([table, count]) => (
                <tr key={table}>
                  <td style={{ padding: 10, borderBottom: '1px solid #d1fae5' }}>{table}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #d1fae5', textAlign: 'right' }}>
                    {count === -1 ? <span style={{ color: '#6b7280' }}>skipped (source missing)</span> :
                     count === -2 ? <span style={{ color: '#6b7280' }}>skipped (target existed)</span> :
                     count.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export default withAuthenticator(PromoteMockPage);
