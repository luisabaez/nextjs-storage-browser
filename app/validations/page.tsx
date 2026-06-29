'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import './validations.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';

Amplify.configure(config);

// Same Lambda Function URL the rest of the app uses (AP-Invoice-Processor)
const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

const SAMPLING_FOLDER = 'Sampling/';

interface ChildRel {
  table: string;
  display: string;
  link_field: string;
}

interface TargetInfo {
  table: string;
  display: string;
  child_count: number;
  children: ChildRel[];
}

interface ChildSummary {
  child: string;
  display: string;
  link_field: string;
  parent_column: string;
  child_column: string;
  row_count: number;
}

interface UnresolvedLink {
  child: string;
  link_field: string;
  reason: string;
}

interface SampleRun {
  ok?: boolean;
  target_table: string;
  target_display: string;
  requested_sample_size: number;
  selected_count: number;
  population: number;
  children: ChildSummary[];
  unresolved_links: UnresolvedLink[];
  child_total_rows: number;
  actor: string;
  created_at: string;
  xlsx_key: string;
  filename: string;
  method: string;
  download_url?: string;
  error?: string;
}

type TabId = 'sampling';

function ValidationsPage() {
  const [userEmail, setUserEmail] = useState('');
  const [activeTab] = useState<TabId>('sampling');

  // Sampling state
  const [targets, setTargets] = useState<TargetInfo[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [selectedTable, setSelectedTable] = useState('');
  const [sampleSize, setSampleSize] = useState('56');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SampleRun | null>(null);
  const [error, setError] = useState('');
  const [recentRuns, setRecentRuns] = useState<SampleRun[]>([]);

  const selectedTarget = targets.find(t => t.table === selectedTable) || null;

  useEffect(() => {
    (async () => {
      try {
        const attrs = await fetchUserAttributes();
        setUserEmail(attrs.email || '');
      } catch (e) {
        console.error('Failed to fetch user attrs', e);
      }
    })();
  }, []);

  // Load target tables
  useEffect(() => {
    (async () => {
      setTargetsLoading(true);
      try {
        const resp = await fetch(`${LAMBDA_URL}?action=sampling_targets`);
        const data = await resp.json();
        if (data.ok) setTargets(data.targets || []);
        else setError(data.error || 'Failed to load target tables');
      } catch (e) {
        setError(`Failed to load target tables: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setTargetsLoading(false);
      }
    })();
  }, []);

  const loadRecentRuns = useCallback(async () => {
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=sampling_runs`);
      const data = await resp.json();
      if (data.ok) setRecentRuns(data.runs || []);
    } catch (e) {
      console.error('Failed to load recent runs', e);
    }
  }, []);

  useEffect(() => { loadRecentRuns(); }, [loadRecentRuns]);

  const triggerDownload = (url: string, filename: string) => {
    // Single user-initiated download. ResponseContentDisposition on the
    // presigned URL forces the attachment; no target=_blank (popup-blocker safe).
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const runSampling = async () => {
    setError('');
    setResult(null);
    const size = parseInt(sampleSize, 10);
    if (!selectedTable) { setError('Pick a target table first.'); return; }
    if (!Number.isFinite(size) || size < 1) { setError('Enter a sample size of 1 or more.'); return; }

    setRunning(true);
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=run_sampling`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_table: selectedTable,
          sample_size: size,
          actor: userEmail,
        }),
      });
      const data: SampleRun = await resp.json();
      if (!data.ok) {
        setError(data.error || 'Sampling failed.');
      } else {
        setResult(data);
        loadRecentRuns();
      }
    } catch (e) {
      setError(`Sampling failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const fmtDate = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  return (
    <div className="val-page">
      <header className="val-header">
        <div className="val-header-left">
          <Link href="/" className="val-back-link">&larr; File Browser</Link>
          <div className="val-header-title">
            <h1>Validations</h1>
            <p className="val-header-subtitle">
              Sampling and validation tooling for the ERP conversion effort
            </p>
          </div>
        </div>
        <div className="val-header-right">
          <Link href={`/?path=${encodeURIComponent(SAMPLING_FOLDER)}`} className="val-folder-link">
            📁 Open Sampling Folder
          </Link>
        </div>
      </header>

      {/* Tabs (room to grow — Sampling is the first) */}
      <div className="val-tabs">
        <button className={`val-tab-btn ${activeTab === 'sampling' ? 'active' : ''}`}>
          Sampling
        </button>
      </div>

      {activeTab === 'sampling' && (
        <div className="val-tab-content">
          <div className="val-intro">
            <h2>Record Sampling</h2>
            <p>
              Pick a target table and a sample size. The system selects that many
              records at random, gathers the child records linked to them, and
              writes the full sample set to an Excel workbook in the{' '}
              <Link href={`/?path=${encodeURIComponent(SAMPLING_FOLDER)}`}>Sampling folder</Link>.
            </p>
            <div className="val-note">
              <strong>Interim version.</strong> Pending confirmation of Ethree&rsquo;s
              sizing methodology, the sample size is a manual input, selection is
              random (not yet reproducible), and only the target&rsquo;s direct
              children are gathered.
            </div>
          </div>

          {error && <div className="val-error">{error}</div>}

          <div className="val-form">
            <div className="val-field">
              <label htmlFor="target">Target table</label>
              <select
                id="target"
                value={selectedTable}
                onChange={e => { setSelectedTable(e.target.value); setResult(null); }}
                disabled={targetsLoading}
              >
                <option value="">
                  {targetsLoading ? 'Loading target tables…' : '— Select a target table —'}
                </option>
                {targets.map(t => (
                  <option key={t.table} value={t.table}>
                    {t.display} ({t.child_count} child{t.child_count === 1 ? '' : 'ren'})
                  </option>
                ))}
              </select>
            </div>

            <div className="val-field val-field-size">
              <label htmlFor="size">Sample size</label>
              <input
                id="size"
                type="number"
                min={1}
                value={sampleSize}
                onChange={e => setSampleSize(e.target.value)}
                placeholder="e.g. 56"
              />
            </div>

            <button className="val-run-btn" onClick={runSampling} disabled={running || !selectedTable}>
              {running ? <><span className="val-spinner" /> Selecting sample…</> : 'Run Sampling'}
            </button>
          </div>

          {/* Children that will be gathered */}
          {selectedTarget && (
            <div className="val-children-preview">
              <h3>Linked children gathered with each sampled record</h3>
              {selectedTarget.children.length === 0 ? (
                <p className="val-muted">This target has no child tables — only its own records are sampled.</p>
              ) : (
                <table className="val-table">
                  <thead>
                    <tr><th>Child table</th><th>Link field</th></tr>
                  </thead>
                  <tbody>
                    {selectedTarget.children.map(c => (
                      <tr key={c.table}>
                        <td>{c.display}</td>
                        <td>{c.link_field}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="val-result">
              <div className="val-result-head">
                <h3>Sample created: {result.target_display}</h3>
                {result.download_url && (
                  <button
                    className="val-download-btn"
                    onClick={() => triggerDownload(result.download_url!, result.filename)}
                  >
                    ⬇ Download workbook
                  </button>
                )}
              </div>
              <div className="val-result-stats">
                <div className="val-stat">
                  <span className="val-stat-num">{result.selected_count.toLocaleString()}</span>
                  <span className="val-stat-label">records selected{result.population ? ` of ${result.population.toLocaleString()}` : ''}</span>
                </div>
                <div className="val-stat">
                  <span className="val-stat-num">{result.children.length}</span>
                  <span className="val-stat-label">child tables gathered</span>
                </div>
                <div className="val-stat">
                  <span className="val-stat-num">{result.child_total_rows.toLocaleString()}</span>
                  <span className="val-stat-label">child rows total</span>
                </div>
              </div>

              {result.children.length > 0 && (
                <table className="val-table">
                  <thead>
                    <tr><th>Child table</th><th>Link field</th><th>Matched column</th><th>Rows</th></tr>
                  </thead>
                  <tbody>
                    {result.children.map(c => (
                      <tr key={c.child}>
                        <td>{c.display}</td>
                        <td>{c.link_field}</td>
                        <td><code>{c.parent_column} → {c.child_column}</code></td>
                        <td>{c.row_count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {result.unresolved_links.length > 0 && (
                <div className="val-warn">
                  <strong>{result.unresolved_links.length} link field(s) could not be resolved</strong> and were
                  skipped — these need the field-name → column mapping confirmed:
                  <ul>
                    {result.unresolved_links.map((u, i) => (
                      <li key={i}><code>{u.child}</code> — &ldquo;{u.link_field}&rdquo; ({u.reason})</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Recent runs */}
          <div className="val-recent">
            <h3>Recent sampling runs</h3>
            {recentRuns.length === 0 ? (
              <p className="val-muted">No sampling runs yet.</p>
            ) : (
              <table className="val-table">
                <thead>
                  <tr><th>When</th><th>Target</th><th>Selected</th><th>Children</th><th>By</th><th></th></tr>
                </thead>
                <tbody>
                  {recentRuns.map(r => (
                    <tr key={r.xlsx_key}>
                      <td>{fmtDate(r.created_at)}</td>
                      <td>{r.target_display}</td>
                      <td>{(r.selected_count ?? 0).toLocaleString()}</td>
                      <td>{(r.child_total_rows ?? 0).toLocaleString()} rows / {r.children?.length ?? 0} tables</td>
                      <td className="val-muted">{r.actor || '—'}</td>
                      <td>
                        <Link href={`/?path=${encodeURIComponent(SAMPLING_FOLDER)}`} className="val-link-sm">
                          View in folder
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default withAuthenticator(ValidationsPage);
