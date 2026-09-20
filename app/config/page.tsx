'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import '../lib/symphony.css';
import './config.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import { ApiResult, ROLE_LABEL, SymphonySession, apiGet, apiPost, fmtDateTime, useSymphonySession } from '../lib/symphony';

Amplify.configure(config);

type Tab = 'mock' | 'rules' | 'history';

interface ConfigSetResult extends ApiResult { current_mock: string; previous: string | null }
// Field rules come from the server so the screen and the save agree.
interface FieldMeta {
  name: string; label: string; editable: boolean; values: string[] | null;
  max_length: number | null; multiline: boolean; allow_blank: boolean;
}
type RuleRow = Record<string, string | null>;
interface RulesList extends ApiResult {
  db: string; can_edit: boolean; fields: FieldMeta[]; rows: RuleRow[]; entities: string[];
  validation_types: string[]; severities: string[]; total: number; warnings?: string[];
}
interface RuleUpdateResult extends ApiResult { validation_code: string; changed: string[]; rows_affected: number; row: RuleRow | null }
interface AuditRow { id: number; validation_code: string; field: string; old: string | null; new: string | null; by: string | null; at: string | null }
interface AuditList extends ApiResult { rows: AuditRow[]; total: number }

const CODE = 'Validation_code';
// Text areas report line breaks as \n; compare and edit in that form.
const text = (v: string | null | undefined) => (v ?? '').replace(/\r\n/g, '\n');
const toForm = (fields: FieldMeta[], row: RuleRow): Record<string, string> =>
  Object.fromEntries(fields.map((f): [string, string] => [f.name, text(row[f.name])]));

function ChangeCell({ row }: { row: AuditRow }) {
  return (
    <td className="cfg-change">
      <span className="cfg-old">{row.old ?? '(blank)'}</span>{' → '}<span className="cfg-new">{row.new ?? '(blank)'}</span>
    </td>
  );
}

function MockCycleTab({ session }: { session: SymphonySession }) {
  const cfg = session.config;
  const [next, setNext] = useState(cfg?.current_mock || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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
        <h2>Change history</h2>
        {cfg.history.length === 0 ? <p className="sy-muted">No changes have been recorded yet.</p> : (
          <div className="sy-scroll">
            <table className="sy-table">
              <thead><tr><th>When</th><th>Setting</th><th>From</th><th>To</th><th>Changed by</th></tr></thead>
              <tbody>
                {cfg.history.map((h, i) => (
                  <tr key={i}>
                    <td className="mono">{fmtDateTime(h.at)}</td>
                    <td>{h.key === 'current_mock' ? 'Current Mock Cycle' : h.key}</td>
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

function RulesTab({ email, onDirtyChange }: { email: string; onDirtyChange: (dirty: boolean) => void }) {
  const [entity, setEntity] = useState('');
  const [vtype, setVtype] = useState('');
  const [severity, setSeverity] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [list, setList] = useState<RulesList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<RuleRow | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveOk, setSaveOk] = useState('');
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 350);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = useCallback(async () => {
    if (!email) return;
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    const res = await apiGet<RulesList>('rules_list', { email, entity, validation_type: vtype, severity, q });
    if (mine !== seq.current) return; // a newer filter change is already in flight
    if (!res.ok) setError(res.error || 'The validation rules could not be loaded'); else setList(res);
    setLoading(false);
  }, [email, entity, vtype, severity, q]);

  useEffect(() => { load(); }, [load]);

  const loadAudit = useCallback(async (code: string) => {
    const res = await apiGet<AuditList>('rules_audit', { email, validation_code: code });
    setAudit(res.ok ? res.rows.slice(0, 10) : []);
  }, [email]);

  const fields = useMemo(() => list?.fields ?? [], [list]);
  const canEdit = !!list?.can_edit;
  const changed = useMemo(
    () => (selected && canEdit ? fields.filter(f => f.editable && (form[f.name] ?? '') !== text(selected[f.name])) : []),
    [selected, canEdit, fields, form],
  );
  const dirty = changed.length > 0;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const selectedCode = selected?.[CODE] || '';
  const confirmDiscard = () => !dirty || window.confirm(`Discard the unsaved changes to ${selectedCode}?`);

  const openRule = (row: RuleRow) => {
    if (row === selected || !confirmDiscard()) return;
    setSelected(row);
    setForm(toForm(fields, row));
    setSaveError('');
    setSaveOk('');
    setAudit([]);
    loadAudit(row[CODE] || '');
  };

  const closeRule = () => {
    if (!confirmDiscard()) return;
    setSelected(null);
    setForm({});
    setAudit([]);
  };

  const save = async () => {
    if (!selected || !list || !dirty) return;
    const sharing = list.rows.filter(r => r[CODE] === selectedCode).length;
    if (!window.confirm(
      `Save ${changed.length} change${changed.length === 1 ? '' : 's'} to ${selectedCode}?\n\n${changed.map(f => f.label).join(', ')}`
      + (sharing > 1 ? `\n\n${sharing} rules share this validation code; all of them will be updated.` : '')
    )) return;
    const changes: Record<string, string | null> = {};
    changed.forEach(f => { changes[f.name] = form[f.name] === '' ? null : form[f.name]; });
    setSaving(true);
    setSaveError('');
    setSaveOk('');
    const send = (allowMultiple: boolean) => apiPost<RuleUpdateResult>('rules_update', {
      actor: email, validation_code: selectedCode, changes, allow_multiple: allowMultiple,
    });
    // The server refuses to change several rules at once unless told to: the
    // list on screen may be filtered, so it is the server that knows how many share the code.
    let res = await send(sharing > 1);
    if (!res.ok && /share the code/i.test(res.error || '') && window.confirm(`${res.error}`)) {
      res = await send(true);
    }
    if (!res.ok) {
      setSaveError(res.error || 'The changes could not be saved');
    } else {
      const fresh = res.row;
      if (fresh) {
        // Only the fields that were sent: a code can be shared by several rules.
        const patch: RuleRow = Object.fromEntries(Object.keys(changes).map((n): [string, string | null] => [n, fresh[n] ?? null]));
        const merged = { ...selected, ...patch };
        setList(prev => (prev ? { ...prev, rows: prev.rows.map(r => (r === selected ? merged : r[CODE] === selectedCode ? { ...r, ...patch } : r)) } : prev));
        setSelected(merged);
        setForm(toForm(fields, merged));
      }
      setSaveOk(res.changed.length === 0
        ? 'Nothing to save: the stored values already match.'
        : `Saved ${res.changed.map(n => fields.find(f => f.name === n)?.label || n).join(', ')}`
          + (res.rows_affected > 1 ? ` on the ${res.rows_affected} rules that share this code.` : '.'));
      loadAudit(selectedCode);
    }
    setSaving(false);
  };

  const setValue = (name: string, value: string) => setForm(prev => ({ ...prev, [name]: value }));

  const renderField = (f: FieldMeta) => {
    if (!selected) return null;
    const original = text(selected[f.name]);
    const value = form[f.name] ?? '';
    const editable = canEdit && f.editable;
    const isChanged = editable && value !== original;
    const cls = `sy-field${f.multiline ? ' cfg-wide' : ''}${isChanged ? ' cfg-changed' : ''}`;
    let control: React.ReactNode;
    if (!editable) {
      control = f.multiline
        ? <textarea className="sy-readonly" readOnly value={value} />
        : <input className="sy-readonly" readOnly value={value} />;
    } else if (f.values) {
      // A stored value outside the list is still shown, but cannot be chosen again once changed.
      const offList = !f.values.includes(original) && !(original === '' && f.allow_blank);
      control = (
        <select value={value} onChange={e => setValue(f.name, e.target.value)} disabled={saving}>
          {f.allow_blank && <option value="">(blank)</option>}
          {offList && <option value={original}>{original === '' ? '(not set)' : `${original} (current, not a valid value)`}</option>}
          {f.values.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      );
    } else if (f.multiline) {
      control = <textarea value={value} maxLength={f.max_length ?? undefined} onChange={e => setValue(f.name, e.target.value)} disabled={saving} />;
    } else {
      control = <input value={value} maxLength={f.max_length ?? undefined} onChange={e => setValue(f.name, e.target.value)} disabled={saving} />;
    }
    return (
      <label key={f.name} className={cls}>
        <span className="cfg-label">
          <span>{f.label}{!f.editable && <span className="sy-muted"> (read-only)</span>}</span>
          {editable && f.max_length != null && <span className="cfg-counter">{value.length}/{f.max_length}</span>}
        </span>
        {control}
      </label>
    );
  };

  const flag = (v: string | null) => {
    const t = (v || '').trim().toUpperCase();
    if (t === 'Y') return <span className="sy-badge sy-badge-ok">Y</span>;
    return <span className="sy-muted">{t || '—'}</span>;
  };

  return (
    <>
      <section className="sy-controls cfg-filters">
        <label>
          <span>Entity</span>
          <select value={entity} onChange={e => setEntity(e.target.value)}>
            <option value="">All entities</option>
            {(list?.entities ?? []).map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>
          <span>Validation type</span>
          <select value={vtype} onChange={e => setVtype(e.target.value)}>
            <option value="">All types</option>
            {(list?.validation_types ?? []).map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>
          <span>Severity</span>
          <select value={severity} onChange={e => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            {(list?.severities ?? []).map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>
          <span>Search</span>
          <input type="search" value={qInput} onChange={e => setQInput(e.target.value)} placeholder="Code, message or Spanish message" />
        </label>
      </section>

      {error && <div className="sy-error">{error}</div>}
      {list && !list.can_edit && <div className="sy-note">You can view the validation rules. Only super users can change them.</div>}
      {list?.warnings && list.warnings.length > 0 && (
        <ul className="sy-warnings">{list.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}

      <div className={`cfg-split${selected ? ' cfg-open' : ''}`}>
        <section className="sy-card">
          <div className="sy-card-head">
            <h2>Validation rules</h2>
            <div className="sy-card-tools">
              {list && <span className="sy-muted">Database: {list.db}</span>}
              <span className="sy-total">{loading ? 'Loading…' : `${(list?.total ?? 0).toLocaleString()} rules`}</span>
              <button className="btn btn-secondary" onClick={load} disabled={loading}>Refresh</button>
            </div>
          </div>
          <div className="cfg-table-wrap">
            <table className="sy-table">
              <thead>
                <tr>
                  <th>Validation code</th><th>Entity</th><th>Type</th><th>Severity</th><th>Error message</th>
                  <th>Agency</th><th>Source</th><th>OATRH</th>
                </tr>
              </thead>
              <tbody>
                {(list?.rows ?? []).map((r, i) => (
                  <tr key={`${r[CODE]}|${i}`} onClick={() => openRule(r)}
                    className={selected && r[CODE] === selectedCode ? 'sy-selected' : 'sy-clickable'}>
                    <td className="mono">{r[CODE]}</td>
                    <td>{r.Entity}</td>
                    <td>{r.Validation_Type || '—'}</td>
                    <td>{r.Severity ? <span className={`sy-sev sy-sev-${r.Severity.trim().toLowerCase()}`}>{r.Severity}</span> : '—'}</td>
                    <td className="cfg-msg">{r.Error_Message}</td>
                    <td className="cfg-flag">{flag(r.AgencyReports)}</td>
                    <td className="cfg-flag">{flag(r.Sourcereports)}</td>
                    <td className="cfg-flag">{flag(r.OATRHReports)}</td>
                  </tr>
                ))}
                {list && list.rows.length === 0 && !loading && (
                  <tr><td colSpan={8} className="sy-muted">No rules match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {selected && (
          <section className="sy-card cfg-panel">
            <div className="sy-card-head">
              <h2>{canEdit ? 'Edit rule' : 'Rule'} <span className="sy-chip">{selectedCode}</span></h2>
              <button className="sy-link" onClick={closeRule}>Close</button>
            </div>
            {saveError && <div className="sy-error">{saveError}</div>}
            {saveOk && <div className="sy-success">{saveOk}</div>}
            <div className="sy-form-grid">{fields.map(renderField)}</div>
            {canEdit && (
              <div className="sy-actions">
                <button className="btn btn-secondary" disabled={!dirty || saving} onClick={() => setForm(toForm(fields, selected))}>Reset</button>
                <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
                  {saving ? 'Saving…' : dirty ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'Save'}
                </button>
              </div>
            )}
            <h3>Recent changes to this rule</h3>
            {audit.length === 0 ? <p className="sy-muted small">No changes recorded.</p> : (
              <div className="sy-scroll">
                <table className="sy-table">
                  <thead><tr><th>When</th><th>Who</th><th>Field</th><th>Old → new</th></tr></thead>
                  <tbody>
                    {audit.map(a => (
                      <tr key={a.id}>
                        <td className="mono small">{fmtDateTime(a.at)}</td>
                        <td className="small">{a.by || '—'}</td>
                        <td className="small">{a.field}</td>
                        <ChangeCell row={a} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}

function HistoryTab({ email }: { email: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [codeInput, setCodeInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (code: string) => {
    if (!email) return;
    setLoading(true);
    setError('');
    const res = await apiGet<AuditList>('rules_audit', { email, validation_code: code.trim() });
    if (!res.ok) setError(res.error || 'The change history could not be loaded'); else setRows(res.rows);
    setLoading(false);
  }, [email]);

  useEffect(() => { load(''); }, [load]);

  return (
    <section className="sy-card">
      <div className="sy-card-head">
        <h2>Rule change history</h2>
        <form className="sy-card-tools" onSubmit={e => { e.preventDefault(); load(codeInput); }}>
          <input className="sy-input" value={codeInput} onChange={e => setCodeInput(e.target.value)} placeholder="Validation code (optional)" />
          <button type="submit" className="btn btn-secondary" disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </form>
      </div>
      <p className="sy-muted small">The latest 200 changes made to validation rules from this page, newest first.</p>
      {error && <div className="sy-error">{error}</div>}
      <div className="sy-scroll">
        <table className="sy-table">
          <thead><tr><th>When</th><th>Who</th><th>Validation code</th><th>Field</th><th>Old → new</th></tr></thead>
          <tbody>
            {rows.map(a => (
              <tr key={a.id}>
                <td className="mono">{fmtDateTime(a.at)}</td>
                <td>{a.by || '—'}</td>
                <td className="mono">{a.validation_code}</td>
                <td>{a.field}</td>
                <ChangeCell row={a} />
              </tr>
            ))}
            {rows.length === 0 && !loading && <tr><td colSpan={5} className="sy-muted">No rule changes have been recorded.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConfigPage() {
  const session = useSymphonySession();
  const [tab, setTab] = useState<Tab | ''>('');
  const [rulesDirty, setRulesDirty] = useState(false);

  if (!session.ready) return <div className="sy-page"><p className="sy-muted">Loading the configuration…</p></div>;

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
