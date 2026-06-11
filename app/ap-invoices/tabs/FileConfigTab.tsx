'use client';
/**
 * Phase 6.2 — File Configuration tab.
 *
 * Replaces the "upload Excel to seed Conversion Plan" workflow.
 *
 *   List view  →  click a file  →  detail panel with:
 *     - metadata (File_Expected, Parent_Entity, Validation_Group_ID, Table_Name, BU)
 *     - children rollup (any entities where Parent_Entity = this entity)
 *     - loaded files (recent AWS_FILES rows for this entity+source)
 *     - column mapping table (file header -> SQL table column)
 *
 *   "Add new file" launches a wizard:
 *     - pick existing SQL table (or create one)
 *     - enter file column headers (paste from CSV or type one per line)
 *     - map each header to a target SQL column
 *     - save → INSERTs a SETUP_CONVERSION_PLAN row + column mappings
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface ConfigRow {
  Pillar: string | null; Module: string | null;
  Entity: string | null; SubEntity: string | null;
  SOURCE: string | null; Table_Name: string | null;
  File_Expected: string | null;
  Validation_Group_ID: string | null;
  Parent_Entity: string | null;
  Mock_Number: string | null;
  Current_Process_Stage: string | null;
  Latest_File_ID: string | null;
  Latest_File_Upload_Date: string | null;
  Total_Upload_Attempts: number | null;
  Latest_Validation_Status: string | null;
  Latest_Approval_Status: string | null;
  BU: string | null;
  FileName: string | null;
  RowCount: string | null;
  LoadedAt: string | null;
  LoadedBy: string | null;
}

interface ColumnMapping {
  Mapping_ID?: number;
  File_Header: string;
  Table_Column: string | null;
  Header_Order: number | null;
  Sample_Value?: string | null;
  Data_Type?: string | null;
  Is_Required?: string | null;
  Notes?: string | null;
}

interface LoadedFile {
  AWS_eTag: string; Movement_Sequence: number;
  File_Name: string; File_Status: string;
  Record_Count: number | null;
  Received_DateTime: string | null;
  Processed_DateTime: string | null;
  Supersedes_eTag: string | null;
  Superseded_By_eTag: string | null;
}

interface DetailResponse {
  ok: boolean;
  detail: ConfigRow;
  column_mappings: ColumnMapping[];
  loaded_files: LoadedFile[];
  children: Array<{ Entity: string; SubEntity: string; SOURCE: string; Table_Name: string; File_Expected: string }>;
  error?: string;
}

interface SQLColumn {
  name: string; data_type: string;
  char_length: number | null;
  numeric_precision: number | null;
  is_nullable: string;
  ordinal_position: number;
}

export function FileConfigTab({ userEmail }: { userEmail: string }) {
  const [mock, setMock] = useState('MOCK12');
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [selected, setSelected] = useState<ConfigRow | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ action: 'file_configs', mock });
      if (moduleFilter) qs.set('module', moduleFilter);
      if (search) qs.set('search', search);
      const resp = await fetch(`${LAMBDA_URL}?${qs.toString()}`);
      const data = await resp.json();
      if (!data.ok) {
        setError(data.error || 'Load failed');
        setRows([]);
      } else {
        setRows(data.rows || []);
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [mock, moduleFilter, search]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'end', marginBottom: 16,
        padding: 12, background: '#f9fafb', borderRadius: 8, flexWrap: 'wrap',
      }}>
        <LabelledInput label="Mock" value={mock} onChange={v => setMock(v.toUpperCase())} width={110} />
        <LabelledInput label="Module" value={moduleFilter} onChange={setModuleFilter} placeholder="FIN / HCM / SCM" width={140} />
        <LabelledInput label="Search" value={search} onChange={setSearch} placeholder="Entity, table, filename..." width={260} />
        <button className="btn btn-primary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => setShowAdd(true)}
          style={{ marginLeft: 'auto', background: '#16a34a', borderColor: 'transparent' }}
        >
          + Add new file
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ fontSize: 13, color: '#4b5563', marginBottom: 8 }}>
        {loading ? 'Loading…' : `${rows.length} entit${rows.length === 1 ? 'y' : 'ies'} in ${mock}`}
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1100 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
              <th style={{ padding: 8 }}>Pillar</th>
              <th style={{ padding: 8 }}>Module</th>
              <th style={{ padding: 8 }}>Entity</th>
              <th style={{ padding: 8 }}>Source</th>
              <th style={{ padding: 8 }}>Table</th>
              <th style={{ padding: 8, textAlign: 'center' }}>Expected?</th>
              <th style={{ padding: 8 }}>VG</th>
              <th style={{ padding: 8 }}>Parent</th>
              <th style={{ padding: 8 }}>Stage</th>
              <th style={{ padding: 8 }}>Latest load</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                No entities found. Click <strong>+ Add new file</strong> to onboard one.
              </td></tr>
            )}
            {rows.map((r, i) => (
              <tr
                key={`${r.Entity}-${r.SOURCE}-${i}`}
                onClick={() => setSelected(r)}
                style={{ cursor: 'pointer', background: i % 2 === 0 ? '#fff' : '#fafafa' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#eff6ff')}
                onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa')}
              >
                <td style={{ padding: 8 }}>{r.Pillar || '—'}</td>
                <td style={{ padding: 8 }}>{r.Module || '—'}</td>
                <td style={{ padding: 8, fontWeight: 600 }}>{r.Entity || '—'}</td>
                <td style={{ padding: 8 }}>{r.SOURCE || '—'}</td>
                <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.Table_Name || '—'}</td>
                <td style={{ padding: 8, textAlign: 'center' }}>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                    background: r.File_Expected === 'Y' ? '#dcfce7' : '#fee2e2',
                    color: r.File_Expected === 'Y' ? '#166534' : '#991b1b',
                    fontSize: 11, fontWeight: 600,
                  }}>{r.File_Expected || '—'}</span>
                </td>
                <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{r.Validation_Group_ID || '—'}</td>
                <td style={{ padding: 8 }}>{r.Parent_Entity || '—'}</td>
                <td style={{ padding: 8, fontSize: 11, color: '#6b7280' }}>{r.Current_Process_Stage || '—'}</td>
                <td style={{ padding: 8, fontSize: 11, color: '#6b7280' }}>
                  {r.LoadedAt ? new Date(r.LoadedAt).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <DetailPanel
          mock={mock}
          row={selected}
          userEmail={userEmail}
          onClose={() => setSelected(null)}
          onSaved={() => { setSelected(null); load(); }}
        />
      )}

      {showAdd && (
        <AddNewFileWizard
          mock={mock}
          userEmail={userEmail}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Detail panel — slides in from right
// ────────────────────────────────────────────────────────────────────────────
function DetailPanel({ mock, row, userEmail, onClose, onSaved }: {
  mock: string; row: ConfigRow; userEmail: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({
        action: 'file_config_detail', mock,
        entity: row.Entity || '', source: row.SOURCE || '',
      });
      const resp = await fetch(`${LAMBDA_URL}?${qs.toString()}`);
      const r = await resp.json();
      if (!r.ok) setError(r.error || 'Load failed');
      else setData(r);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [mock, row.Entity, row.SOURCE]);

  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    if (!data) return;
    setEdits({
      File_Expected: data.detail.File_Expected || 'Y',
      Validation_Group_ID: data.detail.Validation_Group_ID || '',
      Parent_Entity: data.detail.Parent_Entity || '',
      Table_Name: data.detail.Table_Name || '',
      BU: data.detail.BU || '',
    });
    setEditing(true);
  };

  const saveEdits = async () => {
    setSaving(true); setError('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=update_file_config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, entity: row.Entity, source: row.SOURCE,
          updates: edits, actor: userEmail,
        }),
      });
      const r = await resp.json();
      if (!r.ok) {
        setError(r.error || 'Save failed');
      } else {
        setEditing(false);
        await load();
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: 'min(680px, 96vw)', background: '#fff',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
        padding: 20, overflowY: 'auto', zIndex: 1000,
      }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>{row.Entity}</h2>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
              {row.SOURCE} · {row.Module} · {row.Pillar} · {mock}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!editing && (
              <button className="btn btn-primary" onClick={startEdit} disabled={loading || !data}>
                Edit
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6b7280' }}>×</button>
          </div>
        </header>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {loading && !data ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
        ) : data && (
          <>
            {/* Metadata */}
            <Section title="Metadata">
              {editing ? (
                <>
                  <EditField label="File_Expected">
                    <select
                      value={edits.File_Expected}
                      onChange={e => setEdits({ ...edits, File_Expected: e.target.value })}
                      style={fieldStyle()}
                    >
                      <option value="Y">Y — accept new uploads</option>
                      <option value="N">N — reject new uploads</option>
                    </select>
                  </EditField>
                  <EditField label="Validation_Group_ID">
                    <input value={edits.Validation_Group_ID} onChange={e => setEdits({ ...edits, Validation_Group_ID: e.target.value.toUpperCase() })} placeholder="APINV-PRIFAS" style={fieldStyle()} />
                  </EditField>
                  <EditField label="Parent_Entity">
                    <input value={edits.Parent_Entity} onChange={e => setEdits({ ...edits, Parent_Entity: e.target.value })} placeholder="e.g. Person (for child Person Address)" style={fieldStyle()} />
                  </EditField>
                  <EditField label="Table_Name">
                    <input value={edits.Table_Name} onChange={e => setEdits({ ...edits, Table_Name: e.target.value })} style={fieldStyle('monospace')} />
                  </EditField>
                  <EditField label="BU">
                    <input value={edits.BU} onChange={e => setEdits({ ...edits, BU: e.target.value })} placeholder="14,25 (comma-separated)" style={fieldStyle()} />
                  </EditField>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                    <button className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                    <button className="btn btn-primary" onClick={saveEdits} disabled={saving}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <DetailRow label="File_Expected" value={data.detail.File_Expected} pill />
                  <DetailRow label="Validation_Group_ID" value={data.detail.Validation_Group_ID} />
                  <DetailRow label="Parent_Entity" value={data.detail.Parent_Entity} />
                  <DetailRow label="Table_Name" value={data.detail.Table_Name} mono />
                  <DetailRow label="BU" value={data.detail.BU} />
                  <DetailRow label="Current_Process_Stage" value={data.detail.Current_Process_Stage} />
                  <DetailRow label="Total_Upload_Attempts" value={data.detail.Total_Upload_Attempts?.toString() || null} />
                  <DetailRow label="Latest load" value={data.detail.LoadedAt ? new Date(data.detail.LoadedAt).toLocaleString() : null} />
                </>
              )}
            </Section>

            {/* Children */}
            {data.children.length > 0 && (
              <Section title={`Child Entities (${data.children.length})`}>
                {data.children.map((c, i) => (
                  <DetailRow
                    key={i}
                    label={`${c.Entity} / ${c.SOURCE}`}
                    value={`File_Expected=${c.File_Expected || '—'}`}
                  />
                ))}
              </Section>
            )}

            {/* Loaded files */}
            <Section title={`Recent loads (${data.loaded_files.length})`}>
              {data.loaded_files.length === 0 ? (
                <div style={{ color: '#9ca3af', fontSize: 12, padding: 8 }}>No files loaded yet for this entity+source.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#fff' }}>
                      <th style={{ padding: 4, textAlign: 'left' }}>eTag</th>
                      <th style={{ padding: 4, textAlign: 'center' }}>Seq</th>
                      <th style={{ padding: 4, textAlign: 'left' }}>Status</th>
                      <th style={{ padding: 4, textAlign: 'right' }}>Records</th>
                      <th style={{ padding: 4, textAlign: 'left' }}>Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.loaded_files.map(f => (
                      <tr key={`${f.AWS_eTag}-${f.Movement_Sequence}`}>
                        <td style={{ padding: 4, fontFamily: 'monospace' }}>{f.AWS_eTag.slice(0, 10)}…</td>
                        <td style={{ padding: 4, textAlign: 'center' }}>{f.Movement_Sequence}</td>
                        <td style={{ padding: 4 }}>{f.File_Status}</td>
                        <td style={{ padding: 4, textAlign: 'right' }}>{f.Record_Count?.toLocaleString() || '—'}</td>
                        <td style={{ padding: 4, color: '#6b7280' }}>{f.Received_DateTime ? new Date(f.Received_DateTime).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            {/* Column mappings */}
            <ColumnMappingEditor
              mock={mock}
              entity={row.Entity || ''}
              source={row.SOURCE || ''}
              tableName={row.Table_Name || ''}
              initialMappings={data.column_mappings}
              userEmail={userEmail}
              onSaved={load}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Column mapping editor — pulls live SQL columns + edits mappings
// ────────────────────────────────────────────────────────────────────────────
function ColumnMappingEditor({ mock, entity, source, tableName, initialMappings, userEmail, onSaved }: {
  mock: string; entity: string; source: string; tableName: string;
  initialMappings: ColumnMapping[]; userEmail: string; onSaved: () => void;
}) {
  const [mappings, setMappings] = useState<ColumnMapping[]>(initialMappings);
  const [sqlCols, setSqlCols] = useState<SQLColumn[]>([]);
  const [colsError, setColsError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pasteHeaders, setPasteHeaders] = useState('');

  useEffect(() => { setMappings(initialMappings); }, [initialMappings]);

  // Fetch the target table's columns
  useEffect(() => {
    if (!tableName) { setSqlCols([]); return; }
    (async () => {
      try {
        const resp = await fetch(`${LAMBDA_URL}?action=sql_table_columns&table=${encodeURIComponent(tableName)}`);
        const r = await resp.json();
        if (!r.ok) {
          setColsError(r.error || 'Failed to load columns');
          setSqlCols([]);
        } else {
          setSqlCols(r.columns || []);
          setColsError('');
        }
      } catch (e) { setColsError((e as Error).message); }
    })();
  }, [tableName]);

  const colNames = useMemo(() => sqlCols.map(c => c.name), [sqlCols]);

  const importPasted = () => {
    const lines = pasteHeaders.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const seen = new Set(mappings.map(m => m.File_Header));
    const next: ColumnMapping[] = [...mappings];
    let order = mappings.length;
    for (const h of lines) {
      if (seen.has(h)) continue;
      seen.add(h);
      // Try auto-match by case-insensitive equality
      const auto = colNames.find(c => c.toLowerCase() === h.toLowerCase());
      next.push({
        File_Header: h, Table_Column: auto || null,
        Header_Order: ++order,
      });
    }
    setMappings(next);
    setPasteHeaders('');
  };

  const updateMapping = (i: number, patch: Partial<ColumnMapping>) => {
    const next = [...mappings];
    next[i] = { ...next[i], ...patch };
    setMappings(next);
  };

  const removeMapping = (i: number) => {
    const next = mappings.filter((_, idx) => idx !== i);
    setMappings(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=save_column_mapping`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock, entity, source, table_name: tableName,
          mappings: mappings.map((m, i) => ({
            file_header: m.File_Header,
            table_column: m.Table_Column,
            header_order: i,
            sample_value: m.Sample_Value,
            data_type: m.Data_Type,
            is_required: m.Is_Required === 'Y',
            notes: m.Notes,
          })),
          actor: userEmail,
        }),
      });
      const r = await resp.json();
      if (!r.ok) alert(r.error || 'Save failed');
      else { setEditing(false); onSaved(); }
    } catch (e) {
      alert(`Network error: ${(e as Error).message}`);
    } finally { setSaving(false); }
  };

  return (
    <Section title={`Column Mapping (${mappings.length} headers ↔ ${sqlCols.length} table columns)`}>
      {colsError && (
        <div style={{ background: '#fef3c7', color: '#92400e', padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>
          Target table columns unavailable: {colsError}
        </div>
      )}
      {!editing ? (
        <>
          {mappings.length === 0 ? (
            <div style={{ color: '#9ca3af', fontSize: 12, padding: 8 }}>
              No mapping defined yet. Click <strong>Edit</strong> to add one.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#fff' }}>
                  <th style={{ padding: 4, textAlign: 'left' }}>#</th>
                  <th style={{ padding: 4, textAlign: 'left' }}>File header</th>
                  <th style={{ padding: 4, textAlign: 'left' }}>→ Table column</th>
                  <th style={{ padding: 4, textAlign: 'left' }}>Type</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m, i) => (
                  <tr key={`${m.Mapping_ID}-${i}`}>
                    <td style={{ padding: 4 }}>{(m.Header_Order || i) + 1}</td>
                    <td style={{ padding: 4, fontFamily: 'monospace' }}>{m.File_Header}</td>
                    <td style={{ padding: 4, fontFamily: 'monospace', color: m.Table_Column ? '#111' : '#dc2626' }}>
                      {m.Table_Column || '— unmapped —'}
                    </td>
                    <td style={{ padding: 4, color: '#6b7280' }}>{m.Data_Type || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button onClick={() => setEditing(true)} className="btn btn-primary" style={{ marginTop: 8 }}>
            Edit mapping
          </button>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
              Paste headers from the CSV first row (one per line, or comma-separated):
            </div>
            <textarea
              value={pasteHeaders}
              onChange={e => setPasteHeaders(e.target.value)}
              placeholder="HEADER_1&#10;HEADER_2&#10;..."
              style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 4, fontFamily: 'monospace', fontSize: 12, minHeight: 60 }}
            />
            <button onClick={importPasted} className="btn btn-secondary" style={{ marginTop: 4 }} disabled={!pasteHeaders.trim()}>
              + Add pasted headers
            </button>
          </div>

          {mappings.length === 0 ? (
            <div style={{ color: '#9ca3af', fontSize: 12, padding: 8 }}>No headers yet — paste some above.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#fff' }}>
                  <th style={{ padding: 4, textAlign: 'left' }}>File header</th>
                  <th style={{ padding: 4, textAlign: 'left' }}>→ Table column</th>
                  <th style={{ padding: 4 }}></th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m, i) => (
                  <tr key={i}>
                    <td style={{ padding: 2 }}>
                      <input
                        value={m.File_Header}
                        onChange={e => updateMapping(i, { File_Header: e.target.value })}
                        style={{ width: '100%', padding: 4, border: '1px solid #d1d5db', borderRadius: 4, fontFamily: 'monospace', fontSize: 12 }}
                      />
                    </td>
                    <td style={{ padding: 2 }}>
                      <select
                        value={m.Table_Column || ''}
                        onChange={e => updateMapping(i, { Table_Column: e.target.value || null })}
                        style={{ width: '100%', padding: 4, border: '1px solid #d1d5db', borderRadius: 4, fontFamily: 'monospace', fontSize: 12, background: '#fff' }}
                      >
                        <option value="">— unmapped —</option>
                        {colNames.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: 2 }}>
                      <button onClick={() => removeMapping(i)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => { setEditing(false); setMappings(initialMappings); }} className="btn btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button onClick={save} className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save mapping'}
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Add new file wizard
// ────────────────────────────────────────────────────────────────────────────
function AddNewFileWizard({ mock, userEmail, onClose, onSaved }: {
  mock: string; userEmail: string; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    Pillar: 'FIN', Module: 'FIN', Entity: '', SubEntity: '',
    Source: '', Table_Name: '', FileName: '',
    Parent_Entity: '', Validation_Group_ID: '',
    File_Expected: 'Y', BU: '',
  });
  const [tables, setTables] = useState<string[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const loadTables = useCallback(async () => {
    setTablesLoading(true);
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=list_sql_tables`);
      const r = await resp.json();
      if (r.ok) setTables(r.tables || []);
    } catch { /* swallow */ }
    finally { setTablesLoading(false); }
  }, []);

  useEffect(() => { loadTables(); }, [loadTables]);

  const submit = async () => {
    setError('');
    if (!form.Entity.trim() || !form.Source.trim() || !form.Table_Name.trim()) {
      setError('Entity, Source, and Table_Name are required');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=add_file_entity`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mock,
          payload: {
            Pillar: form.Pillar, Module: form.Module,
            Entity: form.Entity.trim(),
            SubEntity: form.SubEntity.trim() || form.Entity.trim(),
            Source: form.Source.trim().toUpperCase(),
            Table_Name: form.Table_Name.trim(),
            FileName: form.FileName.trim() || null,
            Parent_Entity: form.Parent_Entity.trim() || null,
            Validation_Group_ID: form.Validation_Group_ID.trim().toUpperCase() || null,
            File_Expected: form.File_Expected,
            BU: form.BU.trim() || null,
          },
          actor: userEmail,
        }),
      });
      const r = await resp.json();
      if (!r.ok) setError(r.error || 'Save failed');
      else onSaved();
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally { setSubmitting(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 12, padding: 24,
        width: 'min(680px, 96vw)', maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
      }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Add new file entity</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </header>

        <p style={{ fontSize: 13, color: '#4b5563', marginTop: 0 }}>
          Registers a new entity in <code>SETUP_CONVERSION_PLAN_{mock}</code>.
          The next upload matching this Entity+Source will be processed
          (assuming File_Expected is <code>Y</code>). After saving, click the
          row in the file list to define the column mapping.
        </p>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Pillar">
            <select value={form.Pillar} onChange={e => setForm({ ...form, Pillar: e.target.value })} style={fieldStyle()}>
              <option>FIN</option><option>Finance</option>
              <option>HCM</option><option>Human Capital</option>
              <option>SCM</option><option>Supply Chain</option>
            </select>
          </Field>
          <Field label="Module">
            <input value={form.Module} onChange={e => setForm({ ...form, Module: e.target.value })} style={fieldStyle()} />
          </Field>
          <Field label="Entity *">
            <input value={form.Entity} onChange={e => setForm({ ...form, Entity: e.target.value })} placeholder="AP Invoices" style={fieldStyle()} />
          </Field>
          <Field label="SubEntity (entity_prefix)">
            <input value={form.SubEntity} onChange={e => setForm({ ...form, SubEntity: e.target.value })} placeholder="FIN_AP_INVOICE_HDR" style={fieldStyle('monospace')} />
          </Field>
          <Field label="Source *">
            <input value={form.Source} onChange={e => setForm({ ...form, Source: e.target.value.toUpperCase() })} placeholder="PRIFAS" style={fieldStyle()} />
          </Field>
          <Field label="Table_Name *">
            <select value={form.Table_Name} onChange={e => setForm({ ...form, Table_Name: e.target.value })} style={fieldStyle('monospace')}>
              <option value="">{tablesLoading ? 'Loading…' : `— pick from ${tables.length} tables —`}</option>
              {tables.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              Or type a new name: <input
                value={tables.includes(form.Table_Name) ? '' : form.Table_Name}
                onChange={e => setForm({ ...form, Table_Name: e.target.value })}
                placeholder="MY_NEW_TABLE_MOCK12_PRIFAS"
                style={{ ...fieldStyle('monospace'), marginTop: 2 }}
              />
            </div>
          </Field>
          <Field label="Parent_Entity">
            <input value={form.Parent_Entity} onChange={e => setForm({ ...form, Parent_Entity: e.target.value })} placeholder="Person (if this is a child entity)" style={fieldStyle()} />
          </Field>
          <Field label="Validation_Group_ID">
            <input value={form.Validation_Group_ID} onChange={e => setForm({ ...form, Validation_Group_ID: e.target.value.toUpperCase() })} placeholder="APINV-PRIFAS" style={fieldStyle()} />
          </Field>
          <Field label="File_Expected">
            <select value={form.File_Expected} onChange={e => setForm({ ...form, File_Expected: e.target.value })} style={fieldStyle()}>
              <option value="Y">Y</option><option value="N">N</option>
            </select>
          </Field>
          <Field label="BU">
            <input value={form.BU} onChange={e => setForm({ ...form, BU: e.target.value })} placeholder="14 or 14,25" style={fieldStyle()} />
          </Field>
          <Field label="FileName (sample)" full>
            <input value={form.FileName} onChange={e => setForm({ ...form, FileName: e.target.value })} placeholder="FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260301_1200.csv" style={fieldStyle('monospace')} />
          </Field>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Create entity'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Small UI helpers
// ────────────────────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px 0' }}>
        {title}
      </h3>
      <div style={{ background: '#f9fafb', borderRadius: 6, padding: 10 }}>{children}</div>
    </section>
  );
}

function DetailRow({ label, value, pill, mono }: {
  label: string; value: string | null; pill?: boolean; mono?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 4px', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>{label}</span>
      {pill && value ? (
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
          background: value === 'Y' ? '#dcfce7' : '#fee2e2',
          color: value === 'Y' ? '#166534' : '#991b1b',
          fontSize: 11, fontWeight: 600,
        }}>{value}</span>
      ) : (
        <span style={{ fontFamily: mono ? 'monospace' : 'inherit', fontSize: 13, textAlign: 'right', wordBreak: 'break-all' }}>
          {value || '—'}
        </span>
      )}
    </div>
  );
}

function LabelledInput({ label, value, onChange, placeholder, width }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; width?: number;
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: width || 200, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
      />
    </label>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label style={{ display: 'block', gridColumn: full ? '1 / -1' : 'auto' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function fieldStyle(family?: string): React.CSSProperties {
  return {
    width: '100%', padding: '8px 10px',
    border: '1px solid #d1d5db', borderRadius: 6,
    fontSize: 13, fontFamily: family || 'inherit',
    background: '#fff',
  };
}
