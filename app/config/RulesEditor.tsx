'use client';

// The validation rules editor and its change history, shared by the
// Configuration page and the HCM portal.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../lib/symphony.css';
import './config.css';
import { ApiResult, apiGet, apiPost, fmtDateTime } from '../lib/symphony';

// Field rules come from the server so the screen and the save agree.
interface FieldMeta {
  name: string; label: string; editable: boolean; values: string[] | null;
  max_length: number | null; multiline: boolean; allow_blank: boolean;
}
type RuleRow = Record<string, string | null>;
export interface RulesList extends ApiResult {
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

interface RulesTabProps {
  email: string;
  onDirtyChange: (dirty: boolean) => void;
  onLoaded?: (list: RulesList) => void;   // the HCM portal reads which database the rules come from
  showTechnical?: boolean;                // the HCM portal keeps the database name and the setup warnings for administrators
}

export function RulesTab({ email, onDirtyChange, onLoaded, showTechnical = true }: RulesTabProps) {
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
  useEffect(() => { if (list && onLoaded) onLoaded(list); }, [list, onLoaded]);

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
      {showTechnical && list?.warnings && list.warnings.length > 0 && (
        <ul className="sy-warnings">{list.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}

      <div className={`cfg-split${selected ? ' cfg-open' : ''}`}>
        <section className="sy-card">
          <div className="sy-card-head">
            <h2>Validation rules</h2>
            <div className="sy-card-tools">
              {list && showTechnical && <span className="sy-muted">Database: {list.db}</span>}
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
                    <td className="mono">
                      {/* the row opens on a click; the button opens it from the keyboard */}
                      <button type="button" className="sy-link" onClick={e => { e.stopPropagation(); openRule(r); }}>{r[CODE]}</button>
                    </td>
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

export function HistoryTab({ email }: { email: string }) {
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
          <input className="sy-input" aria-label="Validation code" value={codeInput} onChange={e => setCodeInput(e.target.value)} placeholder="Validation code (optional)" />
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
