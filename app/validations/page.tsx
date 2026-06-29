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
const DEFAULT_SIZE = '56';

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
  source_db?: string;
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

type RunState = 'idle' | 'running' | 'done' | 'error';
interface RunCell {
  state: RunState;
  result?: SampleRun;
  error?: string;
}

type TabId = 'sampling';

function ValidationsPage() {
  const [userEmail, setUserEmail] = useState('');
  const [activeTab] = useState<TabId>('sampling');

  const [targets, setTargets] = useState<TargetInfo[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [error, setError] = useState('');

  // Per-target form + run state, keyed by target table name
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [runStatus, setRunStatus] = useState<Record<string, RunCell>>({});
  const [batch, setBatch] = useState<{ running: boolean; done: number; total: number }>({
    running: false, done: 0, total: 0,
  });
  const [setAllValue, setSetAllValue] = useState(DEFAULT_SIZE);

  const [recentRuns, setRecentRuns] = useState<SampleRun[]>([]);

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

  // Load target tables and seed each with the default sample size
  useEffect(() => {
    (async () => {
      setTargetsLoading(true);
      try {
        const resp = await fetch(`${LAMBDA_URL}?action=sampling_targets`);
        const data = await resp.json();
        if (data.ok) {
          const list: TargetInfo[] = data.targets || [];
          setTargets(list);
          setSizes(Object.fromEntries(list.map(t => [t.table, DEFAULT_SIZE])));
        } else {
          setError(data.error || 'Failed to load target tables');
        }
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

  const toggleExpand = (table: string) =>
    setExpanded(prev => ({ ...prev, [table]: !prev[table] }));

  const applySetAll = () => {
    const v = setAllValue.trim();
    setSizes(prev => Object.fromEntries(Object.keys(prev).map(k => [k, v])));
  };

  // Run a single target. Returns true on success. Updates per-row status.
  const runOne = useCallback(async (target: string): Promise<boolean> => {
    const size = parseInt(sizes[target] ?? '', 10);
    if (!Number.isFinite(size) || size < 1) {
      setRunStatus(prev => ({ ...prev, [target]: { state: 'error', error: 'No sample size' } }));
      return false;
    }
    setRunStatus(prev => ({ ...prev, [target]: { state: 'running' } }));
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=run_sampling`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_table: target, sample_size: size, actor: userEmail }),
      });
      const data: SampleRun = await resp.json();
      if (!data.ok) {
        setRunStatus(prev => ({ ...prev, [target]: { state: 'error', error: data.error || 'Failed' } }));
        return false;
      }
      setRunStatus(prev => ({ ...prev, [target]: { state: 'done', result: data } }));
      return true;
    } catch (e) {
      setRunStatus(prev => ({ ...prev, [target]: { state: 'error', error: e instanceof Error ? e.message : String(e) } }));
      return false;
    }
  }, [sizes, userEmail]);

  // Run every target that has a valid size, one at a time, with live progress.
  const runAll = async () => {
    setError('');
    const queue = targets
      .map(t => t.table)
      .filter(tbl => {
        const n = parseInt(sizes[tbl] ?? '', 10);
        return Number.isFinite(n) && n >= 1;
      });
    if (queue.length === 0) {
      setError('Enter a sample size of 1 or more for at least one target.');
      return;
    }
    setBatch({ running: true, done: 0, total: queue.length });
    for (let i = 0; i < queue.length; i++) {
      await runOne(queue[i]);
      setBatch(prev => ({ ...prev, done: i + 1 }));
    }
    setBatch(prev => ({ ...prev, running: false }));
    loadRecentRuns();
  };

  const runSingle = async (target: string) => {
    setError('');
    await runOne(target);
    loadRecentRuns();
  };

  const fmtDate = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  const anyRunning = batch.running;

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
              Set a sample size for each target table and run them all at once. For
              each target the system selects that many records at random, gathers the
              linked child records, and writes an Excel workbook per target to the{' '}
              <Link href={`/?path=${encodeURIComponent(SAMPLING_FOLDER)}`}>Sampling folder</Link>.
              Expand a row to see which children get gathered.
            </p>
            <div className="val-note">
              <strong>Interim version.</strong> Sample size is a manual input (pending
              Ethree&rsquo;s methodology), selection is random (not yet reproducible),
              and only each target&rsquo;s direct children are gathered. A blank or 0
              size skips that target.
            </div>
          </div>

          {error && <div className="val-error">{error}</div>}

          {/* Batch toolbar */}
          <div className="val-toolbar">
            <div className="val-setall">
              <label htmlFor="setall">Set all sizes to</label>
              <input
                id="setall"
                type="number"
                min={1}
                value={setAllValue}
                onChange={e => setSetAllValue(e.target.value)}
                disabled={anyRunning}
              />
              <button className="val-btn-secondary" onClick={applySetAll} disabled={anyRunning}>
                Apply to all
              </button>
            </div>
            <div className="val-toolbar-right">
              {batch.running && (
                <span className="val-progress">
                  <span className="val-spinner" /> Running {batch.done} / {batch.total}…
                </span>
              )}
              <button className="val-run-btn" onClick={runAll} disabled={anyRunning || targetsLoading}>
                {batch.running ? 'Running…' : '▶ Run All'}
              </button>
            </div>
          </div>

          {/* Targets table */}
          {targetsLoading ? (
            <div className="val-loading"><span className="val-spinner" /> Loading target tables…</div>
          ) : (
            <table className="val-table val-targets">
              <thead>
                <tr>
                  <th className="val-col-caret"></th>
                  <th>Target table</th>
                  <th className="val-col-children">Children</th>
                  <th className="val-col-size">Sample size</th>
                  <th className="val-col-status">Status</th>
                  <th className="val-col-result">Result</th>
                </tr>
              </thead>
              <tbody>
                {targets.map(t => {
                  const cell = runStatus[t.table] || { state: 'idle' as RunState };
                  const isOpen = !!expanded[t.table];
                  return (
                    <React.Fragment key={t.table}>
                      <tr className="val-target-row">
                        <td className="val-col-caret">
                          {t.child_count > 0 && (
                            <button
                              className="val-caret"
                              onClick={() => toggleExpand(t.table)}
                              aria-label={isOpen ? 'Collapse' : 'Expand'}
                            >
                              {isOpen ? '▾' : '▸'}
                            </button>
                          )}
                        </td>
                        <td className="val-target-name">{t.display}</td>
                        <td className="val-col-children">
                          {t.child_count > 0 ? (
                            <button className="val-children-link" onClick={() => toggleExpand(t.table)}>
                              {t.child_count}
                            </button>
                          ) : <span className="val-muted">0</span>}
                        </td>
                        <td className="val-col-size">
                          <input
                            type="number"
                            min={1}
                            value={sizes[t.table] ?? ''}
                            onChange={e => setSizes(prev => ({ ...prev, [t.table]: e.target.value }))}
                            disabled={anyRunning}
                          />
                        </td>
                        <td className="val-col-status">
                          {cell.state === 'running' && <span className="val-status running"><span className="val-spinner" /> Running…</span>}
                          {cell.state === 'done' && (
                            <span className="val-status done">
                              ✓ {cell.result!.selected_count.toLocaleString()} sel
                              {cell.result!.population ? ` / ${cell.result!.population.toLocaleString()}` : ''}
                            </span>
                          )}
                          {cell.state === 'error' && <span className="val-status error" title={cell.error}>✕ {cell.error}</span>}
                          {cell.state === 'idle' && (
                            <button className="val-btn-row" onClick={() => runSingle(t.table)} disabled={anyRunning}>
                              Run
                            </button>
                          )}
                        </td>
                        <td className="val-col-result">
                          {cell.state === 'done' && cell.result && (
                            <div className="val-row-result">
                              <span className="val-muted">{cell.result.child_total_rows.toLocaleString()} child rows</span>
                              {cell.result.download_url && (
                                <button
                                  className="val-download-sm"
                                  onClick={() => triggerDownload(cell.result!.download_url!, cell.result!.filename)}
                                >
                                  ⬇
                                </button>
                              )}
                              {cell.result.unresolved_links.length > 0 && (
                                <span className="val-unresolved-badge" title={cell.result.unresolved_links.map(u => `${u.child}: ${u.reason}`).join('\n')}>
                                  ⚠ {cell.result.unresolved_links.length} unresolved
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                      {isOpen && t.children.length > 0 && (
                        <tr className="val-children-row">
                          <td></td>
                          <td colSpan={5}>
                            <div className="val-children-box">
                              <div className="val-children-title">Children gathered with each sampled record:</div>
                              <table className="val-child-table">
                                <thead><tr><th>Child table</th><th>Link field</th></tr></thead>
                                <tbody>
                                  {t.children.map(c => (
                                    <tr key={c.table}>
                                      <td>{c.display}</td>
                                      <td>{c.link_field}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
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
