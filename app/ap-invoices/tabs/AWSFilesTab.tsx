'use client';
/**
 * Phase 6 — AWS Files event log tab.
 *
 * Reads from ?action=aws_files (Phase 6 lambda endpoint) with filters and
 * pagination. Renders a sortable/filterable table; click a row to open the
 * detail overlay. Currently the overlay is a side panel that shows the full
 * row (Phase 6.1). Version chain + lineage tree come in Phase 6.2.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface AWSFileRow {
  AWS_eTag: string;
  Movement_Sequence: number;
  File_Name: string;
  File_Category: string;
  File_Size_KB: number | null;
  Record_Count: number | null;
  Conversion_Plan_Table_Name: string | null;
  Conversion_Plan_Entity: string | null;
  Validation_Group_ID: string | null;
  VBL_Group_ID: string | null;
  WBS_ID: string | null;
  Pillar: string | null;
  Module: string | null;
  Data_Entity: string | null;
  Source: string | null;
  Business_Unit: string | null;
  Mock_Number: string | null;
  S3_Bucket: string | null;
  Parent_Folder: string | null;
  File_URL: string | null;
  Moved_To_Folder: string | null;
  Received_DateTime: string | null;
  Processed_DateTime: string | null;
  File_Status: string;
  Error_Type: string | null;
  Error_Owner: string | null;
  Supersedes_eTag: string | null;
  Superseded_By_eTag: string | null;
  Split_From_eTag: string | null;
  Check_File_Name: string | null;
  Check_File_Expected: string | null;
  Check_Column_Headers: string | null;
  Check_TSQL_File_Found: string | null;
  Check_TSQL_Load: string | null;
  Sterling_Transmission_Status: string | null;
  Sterling_Transmission_DateTime: string | null;
  Created_By: string | null;
  Last_Updated_By: string | null;
  Last_Updated_DateTime: string | null;
  Reason_for_Upload?: string | null;
}

interface Filters {
  mock: string;
  vgid: string;
  category: string;
  status: string;
  source: string;
  search: string;
}

const STATUS_COLORS: Record<string, string> = {
  'Received':              '#dbeafe',
  'Gate Check Running':    '#fef3c7',
  'Table Load Success':    '#dcfce7',
  'Invalid File Name':     '#fee2e2',
  'File Not Expected':     '#fee2e2',
  'Invalid Headers':       '#fee2e2',
  'TSQL Load File Not Found': '#fee2e2',
  'TSQL Load Error':       '#fee2e2',
  'Pending Approval':      '#fef3c7',
  'Approved':              '#dcfce7',
  'Rejected':              '#fee2e2',
  'Sent to Oracle':        '#ddd6fe',
  'Distributed':           '#cffafe',
  'Superseded':            '#f3f4f6',
  'Archived':              '#f3f4f6',
};

const STATUS_TEXT: Record<string, string> = {
  'Received':              '#1e40af',
  'Gate Check Running':    '#92400e',
  'Table Load Success':    '#166534',
  'Invalid File Name':     '#991b1b',
  'File Not Expected':     '#991b1b',
  'Invalid Headers':       '#991b1b',
  'TSQL Load File Not Found': '#991b1b',
  'TSQL Load Error':       '#991b1b',
  'Pending Approval':      '#92400e',
  'Approved':              '#166534',
  'Rejected':              '#991b1b',
  'Sent to Oracle':        '#5b21b6',
  'Distributed':           '#155e75',
  'Superseded':            '#374151',
  'Archived':              '#374151',
};

export function AWSFilesTab({ userBUFilter }: { userBUFilter: string[] | null }) {
  const [filters, setFilters] = useState<Filters>({
    mock: '', vgid: '', category: '', status: '', source: '', search: '',
  });
  const [rows, setRows] = useState<AWSFileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [limit] = useState(200);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedRow, setSelectedRow] = useState<AWSFileRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      (Object.keys(filters) as Array<keyof Filters>).forEach(k => {
        if (filters[k]) qs.set(k, filters[k]);
      });
      const resp = await fetch(`${LAMBDA_URL}?action=aws_files&${qs.toString()}`);
      const data = await resp.json();
      if (!data.ok) {
        setError(data.error || 'Load failed');
        setRows([]); setTotal(0);
      } else {
        setRows(data.rows || []);
        setTotal(data.total || 0);
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [filters, limit, offset]);

  useEffect(() => { load(); }, [load]);

  // Apply BU permission filter client-side (the BU column may be NULL for
  // rows that are still in flight; admins see everything).
  const filteredRows = useMemo(() => {
    if (!userBUFilter) return rows;            // admin / no restriction
    if (userBUFilter.length === 0) return [];  // user with no BUs assigned
    const allowed = new Set(userBUFilter);
    return rows.filter(r => !r.Business_Unit || allowed.has(r.Business_Unit));
  }, [rows, userBUFilter]);

  const fmt = (s: string | null) => s ? new Date(s).toLocaleString() : '—';
  const short = (s: string | null) => s ? s.slice(0, 10) + '…' : '—';

  return (
    <div style={{ padding: 16 }}>
      {/* Filter bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12, marginBottom: 16,
        padding: 12, background: '#f9fafb', borderRadius: 8,
      }}>
        <FilterInput label="Mock"     value={filters.mock}     onChange={v => { setOffset(0); setFilters({ ...filters, mock: v }); }} placeholder="MOCK12" />
        <FilterInput label="VG"       value={filters.vgid}     onChange={v => { setOffset(0); setFilters({ ...filters, vgid: v }); }} placeholder="APINV-PRIFAS" />
        <FilterSelect label="Category" value={filters.category} onChange={v => { setOffset(0); setFilters({ ...filters, category: v }); }} options={['', 'Extract', 'Validation to Source', 'Conversion Load', 'Recon Report', 'Validation Before Load', 'Distribution - Extract', 'Distribution - Validation to Source', 'Distribution - Conversion Load', 'Distribution - Recon Report', 'Distribution - Validation Before Load']} />
        <FilterSelect label="Status"  value={filters.status}   onChange={v => { setOffset(0); setFilters({ ...filters, status: v }); }} options={['', 'Received', 'Table Load Success', 'Invalid File Name', 'File Not Expected', 'Invalid Headers', 'TSQL Load Error', 'Pending Approval', 'Approved', 'Rejected', 'Sent to Oracle', 'Distributed', 'Superseded', 'Archived']} />
        <FilterInput label="Source"   value={filters.source}   onChange={v => { setOffset(0); setFilters({ ...filters, source: v.toUpperCase() }); }} placeholder="PRIFAS" />
        <FilterInput label="Search filename" value={filters.search} onChange={v => { setOffset(0); setFilters({ ...filters, search: v }); }} placeholder="MOCK12_PRIFAS" />
      </div>

      {/* Result summary + pagination */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: '#4b5563' }}>
          {loading
            ? 'Loading…'
            : `Showing ${filteredRows.length} of ${total.toLocaleString()} (offset ${offset})`}
          {userBUFilter && filteredRows.length !== rows.length && (
            <span style={{ marginLeft: 8, color: '#92400e' }}>
              ({rows.length - filteredRows.length} hidden by BU permission)
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-secondary"
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={loading || offset === 0}
          >
            ← Prev
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setOffset(offset + limit)}
            disabled={loading || offset + limit >= total}
          >
            Next →
          </button>
          <button className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Event table */}
      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1100 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left', position: 'sticky', top: 0 }}>
              <th style={{ padding: 8 }}>eTag</th>
              <th style={{ padding: 8, textAlign: 'center' }}>Seq</th>
              <th style={{ padding: 8 }}>File</th>
              <th style={{ padding: 8 }}>Status</th>
              <th style={{ padding: 8 }}>Category</th>
              <th style={{ padding: 8 }}>Entity</th>
              <th style={{ padding: 8 }}>Source</th>
              <th style={{ padding: 8 }}>VG</th>
              <th style={{ padding: 8 }}>Mock</th>
              <th style={{ padding: 8, textAlign: 'right' }}>Records</th>
              <th style={{ padding: 8 }}>Received</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 && !loading && (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                No rows. Try clearing filters or loading more files.
              </td></tr>
            )}
            {filteredRows.map((r, i) => (
              <tr
                key={`${r.AWS_eTag}-${r.Movement_Sequence}`}
                onClick={() => setSelectedRow(r)}
                style={{
                  cursor: 'pointer',
                  background: i % 2 === 0 ? '#fff' : '#fafafa',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#eff6ff')}
                onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa')}
              >
                <td style={{ padding: 8, fontFamily: 'monospace' }}>{short(r.AWS_eTag)}</td>
                <td style={{ padding: 8, textAlign: 'center' }}>{r.Movement_Sequence}</td>
                <td style={{ padding: 8, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.File_Name}</td>
                <td style={{ padding: 8 }}>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                    background: STATUS_COLORS[r.File_Status] || '#f3f4f6',
                    color: STATUS_TEXT[r.File_Status] || '#374151',
                    fontSize: 11, fontWeight: 600,
                  }}>
                    {r.File_Status}
                  </span>
                </td>
                <td style={{ padding: 8, color: '#6b7280' }}>{r.File_Category}</td>
                <td style={{ padding: 8 }}>{r.Conversion_Plan_Entity || '—'}</td>
                <td style={{ padding: 8 }}>{r.Source || '—'}</td>
                <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{r.Validation_Group_ID || '—'}</td>
                <td style={{ padding: 8 }}>{r.Mock_Number || '—'}</td>
                <td style={{ padding: 8, textAlign: 'right' }}>{r.Record_Count?.toLocaleString() || '—'}</td>
                <td style={{ padding: 8, fontSize: 11, color: '#6b7280' }}>{fmt(r.Received_DateTime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail panel — Phase 6.1: just shows the full row. Phase 6.2 adds
          version chain + lineage tree + gate-check timeline. */}
      {selectedRow && (
        <div
          onClick={() => setSelectedRow(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed', right: 0, top: 0, bottom: 0,
              width: 'min(540px, 95vw)', background: '#fff',
              boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
              padding: 20, overflowY: 'auto', zIndex: 1000,
            }}
          >
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>{selectedRow.File_Name}</h2>
                <div style={{ marginTop: 4, fontSize: 13, color: '#6b7280', fontFamily: 'monospace' }}>
                  {selectedRow.AWS_eTag}
                </div>
              </div>
              <button
                onClick={() => setSelectedRow(null)}
                style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: '#6b7280' }}
              >×</button>
            </header>

            <DetailSection title="Status">
              <DetailRow label="File_Status" value={selectedRow.File_Status} pill={STATUS_COLORS[selectedRow.File_Status]} pillFG={STATUS_TEXT[selectedRow.File_Status]} />
              <DetailRow label="Movement_Sequence" value={String(selectedRow.Movement_Sequence)} />
              <DetailRow label="File_Category" value={selectedRow.File_Category} />
              <DetailRow label="Error_Type" value={selectedRow.Error_Type || '—'} />
              <DetailRow label="Error_Owner" value={selectedRow.Error_Owner || '—'} />
            </DetailSection>

            <DetailSection title="Gate Checks">
              <DetailRow label="Check_File_Name"        value={selectedRow.Check_File_Name || '—'} />
              <DetailRow label="Check_File_Expected"    value={selectedRow.Check_File_Expected || '—'} />
              <DetailRow label="Check_Column_Headers"   value={selectedRow.Check_Column_Headers || '—'} />
              <DetailRow label="Check_TSQL_File_Found"  value={selectedRow.Check_TSQL_File_Found || '—'} />
              <DetailRow label="Check_TSQL_Load"        value={selectedRow.Check_TSQL_Load || '—'} />
            </DetailSection>

            <DetailSection title="Conversion Plan Link">
              <DetailRow label="WBS_ID"           value={selectedRow.WBS_ID || '—'} />
              <DetailRow label="Pillar / Module"  value={`${selectedRow.Pillar || '—'} · ${selectedRow.Module || '—'}`} />
              <DetailRow label="Entity"           value={selectedRow.Conversion_Plan_Entity || '—'} />
              <DetailRow label="Source"           value={selectedRow.Source || '—'} />
              <DetailRow label="Validation_Group_ID" value={selectedRow.Validation_Group_ID || '—'} />
              <DetailRow label="VBL_Group_ID"     value={selectedRow.VBL_Group_ID || '—'} />
              <DetailRow label="Mock_Number"      value={selectedRow.Mock_Number || '—'} />
              <DetailRow label="Business_Unit"    value={selectedRow.Business_Unit || '—'} />
              <DetailRow label="Table_Name"       value={selectedRow.Conversion_Plan_Table_Name || '—'} />
            </DetailSection>

            <DetailSection title="Location">
              <DetailRow label="Parent_Folder"    value={selectedRow.Parent_Folder || '—'} />
              <DetailRow label="Moved_To_Folder"  value={selectedRow.Moved_To_Folder || '—'} />
              <DetailRow label="File_URL"         value={selectedRow.File_URL || '—'} mono small />
            </DetailSection>

            <ChainAndLineage etag={selectedRow.AWS_eTag} onJump={e => {
              // When user clicks a chain/lineage node, swap the selected row
              // in-place so we re-fetch its chain. Cheap UX: just reset the
              // selection to a stub with the eTag — the row fetch will run
              // again via the panel.
              setSelectedRow(prev => prev ? { ...prev, AWS_eTag: e } : prev);
            }} />

            <DetailSection title="Lifecycle">
              <DetailRow label="Received"   value={fmt(selectedRow.Received_DateTime)} />
              <DetailRow label="Processed"  value={fmt(selectedRow.Processed_DateTime)} />
              <DetailRow label="Updated"    value={fmt(selectedRow.Last_Updated_DateTime)} />
              <DetailRow label="Record_Count" value={selectedRow.Record_Count?.toLocaleString() || '—'} />
              <DetailRow label="File_Size_KB" value={selectedRow.File_Size_KB?.toLocaleString() || '—'} />
            </DetailSection>

            <ReasonForUploadEditor
              etag={selectedRow.AWS_eTag}
              currentValue={selectedRow.Reason_for_Upload}
              onSaved={(newVal) => {
                setSelectedRow(prev => prev ? { ...prev, Reason_for_Upload: newVal } : prev);
              }}
            />

            {selectedRow.Sterling_Transmission_Status && (
              <DetailSection title="Sterling">
                <DetailRow label="Status"    value={selectedRow.Sterling_Transmission_Status} />
                <DetailRow label="Sent at"   value={fmt(selectedRow.Sterling_Transmission_DateTime)} />
              </DetailSection>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 6.4 — Version Chain walk + Split lineage tree
// ────────────────────────────────────────────────────────────────────────────
interface ChainResp {
  ok: boolean;
  anchor: ChainNode;
  older_versions: ChainNode[];
  newer_versions: ChainNode[];
  split_parent: ChainNode | null;
  split_children: ChainNode[];
  error?: string;
}

interface ChainNode {
  AWS_eTag: string;
  Movement_Sequence?: number;
  File_Name: string;
  File_Category?: string;
  File_Status: string;
  Conversion_Plan_Entity?: string | null;
  Source?: string | null;
  Business_Unit?: string | null;
  Mock_Number?: string | null;
  Parent_Folder?: string | null;
  File_URL?: string | null;
  Received_DateTime?: string | null;
  Supersedes_eTag?: string | null;
  Superseded_By_eTag?: string | null;
  Split_From_eTag?: string | null;
}

function ChainAndLineage({ etag, onJump }: { etag: string; onJump: (e: string) => void }) {
  const [data, setData] = useState<ChainResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    (async () => {
      try {
        const resp = await fetch(`${LAMBDA_URL}?action=aws_file_chain&etag=${encodeURIComponent(etag)}`);
        const j: ChainResp = await resp.json();
        if (!live) return;
        if (!j.ok) setError(j.error || 'Chain load failed');
        else setData(j);
      } catch (e) {
        if (live) setError(`Network error: ${(e as Error).message}`);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [etag]);

  const hasVersionChain = data && (data.older_versions.length > 0 || data.newer_versions.length > 0);
  const hasLineage = data && (data.split_parent || (data.split_children?.length || 0) > 0);

  return (
    <>
      <DetailSection title="Version Chain">
        {loading && <div style={{ color: '#9ca3af', fontSize: 12, padding: 8 }}>Loading chain…</div>}
        {error && <div style={{ color: '#dc2626', fontSize: 12 }}>{error}</div>}
        {data && !hasVersionChain && (
          <div style={{ color: '#9ca3af', fontSize: 12, padding: 8 }}>
            No prior or subsequent versions for this entity+source.
          </div>
        )}
        {data && hasVersionChain && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Oldest first → anchor → newest last */}
            {data.older_versions.slice().reverse().map(n => (
              <ChainNodeRow key={n.AWS_eTag} node={n} relation="older" onJump={onJump} />
            ))}
            <ChainNodeRow node={data.anchor} relation="anchor" onJump={onJump} />
            {data.newer_versions.map(n => (
              <ChainNodeRow key={n.AWS_eTag} node={n} relation="newer" onJump={onJump} />
            ))}
          </div>
        )}
      </DetailSection>

      <DetailSection title="Split Lineage (BU Distribution)">
        {loading && <div style={{ color: '#9ca3af', fontSize: 12, padding: 8 }}>Loading lineage…</div>}
        {data && !hasLineage && (
          <div style={{ color: '#9ca3af', fontSize: 12, padding: 8 }}>
            This file is not part of a BU split (no parent or children).
          </div>
        )}
        {data && hasLineage && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.split_parent && (
              <>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
                  ↑ Consolidated parent
                </div>
                <ChainNodeRow node={data.split_parent} relation="parent" onJump={onJump} />
                <div style={{ fontSize: 18, textAlign: 'center', color: '#9ca3af', lineHeight: 1 }}>↓</div>
              </>
            )}
            <ChainNodeRow node={data.anchor} relation="anchor" onJump={onJump} />
            {(data.split_children?.length || 0) > 0 && (
              <>
                <div style={{ fontSize: 18, textAlign: 'center', color: '#9ca3af', lineHeight: 1 }}>↓</div>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
                  ↓ BU split children ({data.split_children.length})
                </div>
                {data.split_children.map(c => (
                  <ChainNodeRow key={c.AWS_eTag} node={c} relation="child" onJump={onJump} indent />
                ))}
              </>
            )}
          </div>
        )}
      </DetailSection>
    </>
  );
}

function ChainNodeRow({ node, relation, onJump, indent }: {
  node: ChainNode;
  relation: 'older' | 'newer' | 'anchor' | 'parent' | 'child';
  onJump: (e: string) => void;
  indent?: boolean;
}) {
  const isAnchor = relation === 'anchor';
  const bg = isAnchor ? '#fef3c7' : '#fff';
  const border = isAnchor ? '2px solid #f59e0b' : '1px solid #e5e7eb';
  const relLabel = ({
    older: 'older',
    newer: 'newer',
    anchor: 'current',
    parent: 'parent',
    child: 'child',
  } as const)[relation];
  const fmt = (s?: string | null) => s ? new Date(s).toLocaleString() : '';

  return (
    <div
      onClick={() => !isAnchor && onJump(node.AWS_eTag)}
      style={{
        background: bg, border, borderRadius: 6, padding: 8,
        cursor: isAnchor ? 'default' : 'pointer',
        marginLeft: indent ? 16 : 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: isAnchor ? '#92400e' : '#374151', fontWeight: isAnchor ? 700 : 400 }}>
          {node.AWS_eTag.slice(0, 16)}…
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <span style={{ background: '#f3f4f6', color: '#6b7280', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 600 }}>
            {relLabel}
          </span>
          {node.Business_Unit && (
            <span style={{ background: '#dbeafe', color: '#1e40af', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 600 }}>
              BU {node.Business_Unit}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.File_Name}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#6b7280', marginTop: 2 }}>
        <span>{node.File_Status}</span>
        <span>{fmt(node.Received_DateTime)}</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 6.9 — Reason_for_Upload editor on the file detail panel
// ────────────────────────────────────────────────────────────────────────────
const REASON_OPTIONS = [
  '', 'Initial Load', 'Re-extract', 'Correction',
  'Late Arrival', 'Manual Re-upload', 'Other',
];

function ReasonForUploadEditor({ etag, currentValue, onSaved }: {
  etag: string;
  currentValue: string | null | undefined;
  onSaved: (newVal: string | null) => void;
}) {
  const [value, setValue] = useState(currentValue || '');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setValue(currentValue || ''); }, [currentValue, etag]);

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const resp = await fetch(`${LAMBDA_URL}?action=update_aws_file_reason`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ etag, reason: value, actor: 'dashboard' }),
      });
      const d = await resp.json();
      if (!d.ok) setErr(d.error || 'Save failed');
      else { setEditing(false); onSaved(value || null); }
    } catch (e) { setErr(`Network error: ${(e as Error).message}`); }
    finally { setSaving(false); }
  };

  return (
    <DetailSection title="Reason for Upload">
      {err && <div style={{ color: '#dc2626', fontSize: 11, marginBottom: 6 }}>{err}</div>}
      {!editing ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 4px' }}>
          <span style={{ fontSize: 13 }}>
            {currentValue || <span style={{ color: '#9ca3af' }}>— not set —</span>}
          </span>
          <button
            onClick={() => setEditing(true)}
            style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#374151', cursor: 'pointer' }}
          >
            Edit
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 4 }}>
          <select
            value={value}
            onChange={e => setValue(e.target.value)}
            style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13, background: '#fff' }}
          >
            {REASON_OPTIONS.map(o => (
              <option key={o} value={o}>{o || '— Clear (set to null) —'}</option>
            ))}
          </select>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              onClick={() => { setEditing(false); setValue(currentValue || ''); }}
              disabled={saving}
              style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="btn btn-primary"
              style={{ padding: '4px 10px', fontSize: 12 }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </DetailSection>
  );
}

function FilterInput({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
      />
    </label>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: string[];
}) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13, background: '#fff' }}
      >
        {options.map(o => <option key={o} value={o}>{o || '— Any —'}</option>)}
      </select>
    </label>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px 0' }}>{title}</h3>
      <div style={{ background: '#f9fafb', borderRadius: 6, padding: 8 }}>
        {children}
      </div>
    </section>
  );
}

function DetailRow({ label, value, pill, pillFG, mono, small }: {
  label: string; value: string; pill?: string; pillFG?: string; mono?: boolean; small?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 4px', borderBottom: '1px solid #fff', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>{label}</span>
      {pill ? (
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
          background: pill, color: pillFG || '#374151',
          fontSize: 11, fontWeight: 600,
        }}>
          {value}
        </span>
      ) : (
        <span style={{
          fontFamily: mono ? 'monospace' : 'inherit',
          fontSize: small ? 11 : 13,
          textAlign: 'right', wordBreak: 'break-all',
        }}>
          {value}
        </span>
      )}
    </div>
  );
}
