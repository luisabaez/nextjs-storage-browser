'use client';

import React, { useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import '../lib/symphony.css';
import './config.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import { ApiResult, ROLE_LABEL, SymphonySession, apiPost, fmtDateTime, usePortalGuard, useSymphonySession } from '../lib/symphony';
import { HistoryTab, RulesTab } from './RulesEditor';

Amplify.configure(config);

type Tab = 'mock' | 'rules' | 'history';

interface ConfigSetResult extends ApiResult { current_mock: string; previous: string | null }
interface ReconLinkResult extends ApiResult { recon_tool_url?: string }

function MockCycleTab({ session }: { session: SymphonySession }) {
  const cfg = session.config;
  const [next, setNext] = useState(cfg?.current_mock || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [reconUrl, setReconUrl] = useState(cfg?.recon_tool_url || '');
  const [reconSaving, setReconSaving] = useState(false);
  const [reconError, setReconError] = useState('');
  const [reconSuccess, setReconSuccess] = useState('');

  if (!cfg) return <div className="sy-error">{session.error || 'The configuration could not be loaded.'}</div>;

  const apply = async () => {
    if (!next || next === cfg.current_mock) return;
    if (!window.confirm(
      `Set ${next} as the current Mock Cycle?\n\n`
      + `Every screen of the tool will default to ${next} for every user from now on (it is ${cfg.current_mock} today). `
      + `Files and results already stored for other cycles are not changed.`
    )) return;
    setSaving(true);
    setError('');
    setSuccess('');
    const res = await apiPost<ConfigSetResult>('app_config_set', { actor: session.email, current_mock: next });
    if (!res.ok) {
      setError(res.error || 'The Mock Cycle could not be changed');
    } else {
      await session.reloadConfig();
      session.setMock(res.current_mock);
      setSuccess(`The current Mock Cycle is now ${res.current_mock} (it was ${res.previous || 'not set'}).`);
    }
    setSaving(false);
  };

  const reconValue = reconUrl.trim();
  const reconValid = reconValue === '' || (/^https:\/\/\S+$/i.test(reconValue) && reconValue.length <= 500);
  const saveRecon = async () => {
    setReconSaving(true);
    setReconError('');
    setReconSuccess('');
    const res = await apiPost<ReconLinkResult>('app_config_set', { actor: session.email, recon_tool_url: reconValue });
    if (!res.ok) {
      setReconError(res.error || 'The link could not be saved');
    } else {
      await session.reloadConfig();
      setReconUrl(res.recon_tool_url ?? reconValue);
      setReconSuccess(reconValue ? 'The Recon Report Tools link was saved.' : 'The Recon Report Tools link was cleared.');
    }
    setReconSaving(false);
  };

  return (
    <>
      <section className="sy-stats">
        <div className="sy-stat"><div className="sy-stat-num">{cfg.current_mock}</div><div className="sy-stat-label">Current Mock Cycle</div></div>
        <div className="sy-stat"><div className="sy-stat-num">{cfg.default_mock}</div><div className="sy-stat-label">Default until a cycle is set</div></div>
        <div className="sy-stat"><div className="cfg-stat-text">{cfg.updated_by || '—'}</div><div className="sy-stat-label">Last changed by</div></div>
        <div className="sy-stat"><div className="cfg-stat-text">{fmtDateTime(cfg.updated_at)}</div><div className="sy-stat-label">Last changed</div></div>
      </section>

      <section className="sy-card">
        <h2>Change the current Mock Cycle</h2>
        <p className="sy-muted small">The cycles listed are the ones with a conversion plan in the conversion database.</p>
        {error && <div className="sy-error">{error}</div>}
        {success && <div className="sy-success">{success}</div>}
        <div className="cfg-set">
          <label className="sy-field">
            <span>Mock Cycle</span>
            <select value={next} onChange={e => setNext(e.target.value)} disabled={saving}>
              {session.mocks.map(m => <option key={m} value={m}>{m}{m === cfg.current_mock ? ' (current)' : ''}</option>)}
            </select>
          </label>
          <button className="btn btn-primary" disabled={saving || !next || next === cfg.current_mock} onClick={apply}>
            {saving ? 'Saving…' : 'Set as current cycle'}
          </button>
        </div>
      </section>

      <section className="sy-card">
        <h2>Recon Report Tools link</h2>
        <p className="sy-muted small">The address the Recon Report Tools tile of the HCM portal opens. Leave it empty to switch the tile off.</p>
        {reconError && <div className="sy-error">{reconError}</div>}
        {reconSuccess && <div className="sy-success">{reconSuccess}</div>}
        <div className="cfg-set">
          <label className="sy-field sy-field-wide">
            <span>Link (https)</span>
            <input type="url" value={reconUrl} maxLength={500} placeholder="https://" disabled={reconSaving}
              onChange={e => setReconUrl(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={reconSaving || !reconValid || reconValue === (cfg.recon_tool_url || '')} onClick={saveRecon}>
            {reconSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {!reconValid && <p className="sy-muted small">Enter an address that starts with https:// (500 characters at most).</p>}
      </section>

      <section className="sy-card">
        <h2>Change history</h2>
        {cfg.history.length === 0 ? <p className="sy-muted">No changes have been recorded yet.</p> : (
          <div className="sy-scroll">
            <table className="sy-table">
              <thead><tr><th>When</th><th>Setting</th><th>From</th><th>To</th><th>Changed by</th></tr></thead>
              <tbody>
                {cfg.history.map((h, i) => (
                  <tr key={i}>
                    <td className="mono">{fmtDateTime(h.at)}</td>
                    <td>{h.key === 'current_mock' ? 'Current Mock Cycle' : h.key === 'recon_tool_url' ? 'Recon Report Tools link' : h.key}</td>
                    <td className="mono">{h.old || '—'}</td>
                    <td className="mono">{h.new || '—'}</td>
                    <td>{h.by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ConfigPage() {
  const session = useSymphonySession();
  const toPortal = usePortalGuard(session);   // portal-only users are sent to the HCM portal
  const [tab, setTab] = useState<Tab | ''>('');
  const [rulesDirty, setRulesDirty] = useState(false);

  if (!session.ready) return <div className="sy-page"><p className="sy-muted">Loading the configuration…</p></div>;
  if (toPortal) return null;

  if (!session.canReview) {
    return (
      <div className="sy-denied">
        <h2>Configuration</h2>
        {session.error && <div className="sy-error">{session.error}</div>}
        <p>This page is for super users; certification reviewers can view the validation rules. {session.email || 'Your account'} has the role: {ROLE_LABEL[session.role] || ROLE_LABEL['']}.</p>
        <Link href="/" className="btn btn-secondary">← File Browser</Link>
      </div>
    );
  }

  // The Mock Cycle setting is super-user business; reviewers get the rule views.
  const tabs: { id: Tab; label: string }[] = [
    ...(session.isSuperUser ? [{ id: 'mock' as Tab, label: 'Mock Cycle' }] : []),
    { id: 'rules', label: 'Validation Rules' },
    { id: 'history', label: 'Rule change history' },
  ];
  const active: Tab = tab || tabs[0].id;

  const switchTab = (id: Tab) => {
    if (id === active) return;
    if (active === 'rules' && rulesDirty && !window.confirm('Leave the Validation Rules tab and discard the unsaved changes?')) return;
    setRulesDirty(false);
    setTab(id);
  };

  return (
    <div className="sy-page">
      <header className="sy-header">
        <div>
          <h1>
            Configuration
            <span className="sy-mock">{session.mock}</span>
            <span className="sy-pill sy-pill-role">{ROLE_LABEL[session.role] || session.role}</span>
          </h1>
          <p className="sy-sub">Set the Mock Cycle every screen defaults to, and maintain the validation rules (messages, severity, path forward and report flags).</p>
        </div>
        <div className="sy-links">
          <label className="cfg-cycle">
            <span>Cycle</span>
            <select value={session.mock} onChange={e => session.setMock(e.target.value)}>
              {session.mocks.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <Link href="/" className="btn btn-secondary">← File Browser</Link>
        </div>
      </header>
      <p className="sy-muted cfg-hint">
        The cycle selector changes nothing on this page: validation rules are shared by every Mock Cycle, and the cycle the whole tool uses is changed on the Mock Cycle tab.
      </p>

      {session.error && <div className="sy-error">{session.error}</div>}

      <nav className="sy-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`sy-tab${active === t.id ? ' active' : ''}`} onClick={() => switchTab(t.id)}>{t.label}</button>
        ))}
      </nav>

      {active === 'mock' && <MockCycleTab session={session} />}
      {active === 'rules' && <RulesTab email={session.email} onDirtyChange={setRulesDirty} />}
      {active === 'history' && <HistoryTab email={session.email} />}
    </div>
  );
}

export default withAuthenticator(ConfigPage);
