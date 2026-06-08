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

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface ResetResponse {
  ok: boolean;
  mock_number?: string;
  rows_updated?: number;
  entity?: string;
  source?: string;
  validation_group_id?: string;
  reason?: string;
  actor?: string;
  error?: string;
}

function ResetFileExpectedPage() {
  const [userEmail, setUserEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  const [mock, setMock] = useState('12');
  const [entity, setEntity] = useState('');
  const [source, setSource] = useState('');
  const [vgid, setVgid] = useState('');
  const [reason, setReason] = useState('');
  const [matchBy, setMatchBy] = useState<'entity_source' | 'vgid_source'>('entity_source');

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ResetResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const attrs = await fetchUserAttributes();
        const email = attrs.email || '';
        setUserEmail(email);
        setIsAdmin(isAdminUser(email));
      } catch (e) {
        console.error(e);
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  const canSubmit = !!mock.trim() && !!source.trim() && (
    (matchBy === 'entity_source' && !!entity.trim()) ||
    (matchBy === 'vgid_source'    && !!vgid.trim())
  ) && !!reason.trim();

  const submit = async () => {
    if (!canSubmit) return;
    if (!window.confirm(
      `Flip File_Expected back to Y for ${matchBy === 'entity_source' ? entity : vgid} / ${source} in MOCK${mock}?\n\n` +
      'Affected rows will be marked re-upload-ready. Reason will be appended to Notes.'
    )) return;

    setSubmitting(true);
    setError('');
    setResult(null);
    try {
      const qs = new URLSearchParams({
        action: 'reset_file_expected',
        mock: `MOCK${mock.replace(/^MOCK/i, '').trim()}`,
        source: source.trim(),
        reason: reason.trim(),
        actor: userEmail,
      });
      if (matchBy === 'entity_source') qs.set('entity', entity.trim());
      if (matchBy === 'vgid_source')   qs.set('validation_group_id', vgid.trim());

      const resp = await fetch(`${LAMBDA_URL}?${qs.toString()}`);
      const data: ResetResponse = await resp.json();
      if (!data.ok) setError(data.error || 'Reset failed');
      else setResult(data);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (!authChecked) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!isAdmin) {
    return (
      <div style={{ padding: 40 }}>
        <h2>Access denied</h2>
        <p>Admin role required to reset File_Expected.</p>
        <Link href="/admin" className="btn btn-secondary">Back to Admin</Link>
      </div>
    );
  }

  return (
    <div className="admin-container" style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Reset File_Expected</h1>
        <Link href="/admin" className="btn btn-secondary">← Back to Admin</Link>
      </header>

      <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <p style={{ marginTop: 0, color: '#444' }}>
          When a file successfully loads, the Lambda automatically flips
          <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4, margin: '0 4px' }}>File_Expected = N</code>
          on the matching <code>SETUP_CONVERSION_PLAN_MOCK{mock || 'N'}</code> row(s).
          Any new upload for the same entity will then be rejected with
          <strong> &quot;File Not Expected&quot;</strong>. Use this tool to flip it back
          to <code>Y</code> when a corrected re-upload is genuinely needed.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr', gap: 12, alignItems: 'end', marginTop: 16 }}>
          <label>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Mock</div>
            <input
              type="text"
              value={mock}
              onChange={e => setMock(e.target.value)}
              placeholder="12"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              disabled={submitting}
            />
          </label>
          <label>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Match by</div>
            <select
              value={matchBy}
              onChange={e => setMatchBy(e.target.value as 'entity_source' | 'vgid_source')}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              disabled={submitting}
            >
              <option value="entity_source">Entity + Source</option>
              <option value="vgid_source">Validation Group ID + Source</option>
            </select>
          </label>
          <label>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Source</div>
            <input
              type="text"
              value={source}
              onChange={e => setSource(e.target.value.toUpperCase())}
              placeholder="PRIFAS / SIFDE / HACIENDA…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              disabled={submitting}
            />
          </label>
        </div>

        {matchBy === 'entity_source' && (
          <label style={{ display: 'block', marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Entity</div>
            <input
              type="text"
              value={entity}
              onChange={e => setEntity(e.target.value)}
              placeholder="e.g. AP Invoices, Supplier, Person Address"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              disabled={submitting}
            />
          </label>
        )}

        {matchBy === 'vgid_source' && (
          <label style={{ display: 'block', marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Validation Group ID</div>
            <input
              type="text"
              value={vgid}
              onChange={e => setVgid(e.target.value.toUpperCase())}
              placeholder="e.g. APINV-PRIFAS, SUP-PRIFAS, PO-HACIENDA"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
              disabled={submitting}
            />
          </label>
        )}

        <label style={{ display: 'block', marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Reason <span style={{ color: '#dc2626' }}>*</span>
          </div>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. Source team identified incorrect amounts; re-extract required"
            style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, minHeight: 60, fontFamily: 'inherit' }}
            disabled={submitting}
          />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
            Appended to the Notes column for audit. Required.
          </div>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={!canSubmit || submitting}
          >
            {submitting ? 'Resetting…' : 'Reset File_Expected to Y'}
          </button>
        </div>
      </section>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 12, borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {result && result.ok && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', color: '#166534', padding: 16, borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>✓ File_Expected reset</h3>
          <p style={{ margin: '4px 0' }}>
            <strong>{result.rows_updated}</strong> row(s) in <code>SETUP_CONVERSION_PLAN_{result.mock_number}</code> flipped to <code>File_Expected = Y</code>.
          </p>
          {result.rows_updated === 0 && (
            <p style={{ margin: '4px 0', color: '#92400e' }}>
              No rows matched — double-check the Entity / VG ID and Source values.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default withAuthenticator(ResetFileExpectedPage);
