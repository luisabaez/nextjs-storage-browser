'use client';
/**
 * Phase 6.5 — lightweight pipeline metrics strip.
 *
 * Mounts at the top of the dashboard. Polls ?action=pipeline_metrics every
 * 30 seconds and renders a row of compact tiles:
 *   queue depth · in flight · loaded (window) · failed (window) ·
 *   success rate · mean load · throughput · pending approvals ·
 *   Sterling pending.
 *
 * Click a tile to deep-link into the relevant tab (the parent dashboard
 * passes onJump for tab navigation). Auto-refresh can be paused.
 */
import React, { useCallback, useEffect, useState } from 'react';

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

interface Metrics {
  ok: boolean;
  mock: string | null;
  window_hours: number;
  queue_depth: number;
  in_flight: number;
  loaded_window: number;
  failed_window: number;
  superseded_window: number;
  mean_load_seconds: number | null;
  throughput_per_hour: number;
  success_rate: number | null;
  validation_runs_pending: number | null;
  vbl_runs_pending: number | null;
  sterling_pending: number | null;
  by_module: Record<string, number>;
  by_status: Record<string, number>;
}

interface Props {
  defaultMock?: string;
  onJump?: (target: 'aws_files' | 'validation_runs' | 'vbl_groups' | 'file_config') => void;
}

export function PipelineMetrics({ defaultMock = 'MOCK12', onJump }: Props) {
  const [mock, setMock] = useState(defaultMock);
  const [windowHours, setWindowHours] = useState(24);
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({
        action: 'pipeline_metrics',
        window_hours: String(windowHours),
      });
      if (mock) qs.set('mock', mock);
      const resp = await fetch(`${LAMBDA_URL}?${qs.toString()}`);
      const d: Metrics = await resp.json();
      if (!d.ok) setError((d as unknown as { error?: string }).error || 'Load failed');
      else { setData(d); setLastRefreshed(new Date()); }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [mock, windowHours]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh tick
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const fmtSec = (s: number | null) => {
    if (s == null) return '—';
    if (s < 1) return `${(s * 1000).toFixed(0)}ms`;
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };
  const fmtPct = (n: number | null) =>
    n == null ? '—' : `${(n * 100).toFixed(1)}%`;

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
      padding: 12, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: collapsed ? 0 : 10 }}>
        <button
          onClick={() => setCollapsed(c => !c)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700 }}
          title={collapsed ? 'Expand metrics' : 'Collapse metrics'}
        >
          {collapsed ? '▸' : '▾'} Pipeline metrics
        </button>
        <label style={{ fontSize: 12, color: '#4b5563' }}>
          Mock&nbsp;
          <input
            value={mock}
            onChange={e => setMock(e.target.value.toUpperCase())}
            placeholder="(global)"
            style={{ width: 110, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
          />
        </label>
        <label style={{ fontSize: 12, color: '#4b5563' }}>
          Window&nbsp;
          <select
            value={windowHours}
            onChange={e => setWindowHours(parseInt(e.target.value, 10))}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, background: '#fff' }}
          >
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={72}>3d</option>
            <option value={168}>7d</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: '#4b5563', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (30s)
        </label>
        <button onClick={load} disabled={loading} className="btn btn-primary" style={{ padding: '4px 12px', fontSize: 12 }}>
          {loading ? '…' : '↻ Refresh'}
        </button>
        {lastRefreshed && (
          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
            Updated {lastRefreshed.toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}

      {!collapsed && data && (
        <>
          <div style={{
            display: 'grid', gap: 8,
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          }}>
            <Tile
              label="Queue depth"
              value={data.queue_depth.toLocaleString()}
              hint="Received / gate-check running"
              tone={data.queue_depth > 0 ? 'amber' : 'gray'}
              onClick={() => onJump?.('aws_files')}
            />
            <Tile
              label="In flight"
              value={data.in_flight.toLocaleString()}
              hint="Past gate, not yet loaded"
              tone={data.in_flight > 0 ? 'blue' : 'gray'}
              onClick={() => onJump?.('aws_files')}
            />
            <Tile
              label={`Loaded (${data.window_hours}h)`}
              value={data.loaded_window.toLocaleString()}
              hint={`${data.throughput_per_hour.toFixed(1)}/hr`}
              tone="green"
              onClick={() => onJump?.('aws_files')}
            />
            <Tile
              label={`Failed (${data.window_hours}h)`}
              value={data.failed_window.toLocaleString()}
              hint="Gate or load failures"
              tone={data.failed_window > 0 ? 'red' : 'gray'}
              onClick={() => onJump?.('aws_files')}
            />
            <Tile
              label="Success rate"
              value={fmtPct(data.success_rate)}
              hint={`${data.loaded_window} of ${data.loaded_window + data.failed_window}`}
              tone={data.success_rate == null ? 'gray' :
                    data.success_rate >= 0.95 ? 'green' :
                    data.success_rate >= 0.80 ? 'amber' : 'red'}
            />
            <Tile
              label="Mean load"
              value={fmtSec(data.mean_load_seconds)}
              hint="Receive → processed"
              tone="gray"
            />
            <Tile
              label="Pending approvals"
              value={data.validation_runs_pending == null
                ? '—'
                : data.validation_runs_pending.toLocaleString()}
              hint="Validation runs awaiting"
              tone={data.validation_runs_pending && data.validation_runs_pending > 0 ? 'amber' : 'gray'}
              onClick={() => onJump?.('validation_runs')}
            />
            <Tile
              label="VBL pending"
              value={data.vbl_runs_pending == null ? '—' : data.vbl_runs_pending.toLocaleString()}
              hint="VBL runs awaiting"
              tone={data.vbl_runs_pending && data.vbl_runs_pending > 0 ? 'amber' : 'gray'}
              onClick={() => onJump?.('vbl_groups')}
            />
            <Tile
              label="Sterling pending"
              value={data.sterling_pending == null ? '—' : data.sterling_pending.toLocaleString()}
              hint="Approved + not sent"
              tone={data.sterling_pending && data.sterling_pending > 0 ? 'purple' : 'gray'}
              onClick={() => onJump?.('vbl_groups')}
            />
            <Tile
              label="Superseded"
              value={data.superseded_window.toLocaleString()}
              hint={`Re-uploads in ${data.window_hours}h`}
              tone="gray"
            />
          </div>

          {/* Module + status mini bars */}
          {(Object.keys(data.by_module).length > 0 || Object.keys(data.by_status).length > 0) && (
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr', marginTop: 12 }}>
              <MiniBars title="By module" data={data.by_module} />
              <MiniBars title="By status" data={data.by_status} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, hint, tone, onClick }: {
  label: string; value: string; hint?: string;
  tone: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'purple';
  onClick?: () => void;
}) {
  const tones: Record<string, { bg: string; border: string; fg: string }> = {
    gray:   { bg: '#f9fafb', border: '#e5e7eb', fg: '#111827' },
    green:  { bg: '#f0fdf4', border: '#bbf7d0', fg: '#166534' },
    red:    { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' },
    amber:  { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' },
    blue:   { bg: '#eff6ff', border: '#bfdbfe', fg: '#1e40af' },
    purple: { bg: '#f5f3ff', border: '#ddd6fe', fg: '#5b21b6' },
  };
  const c = tones[tone];
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        background: c.bg, border: `1px solid ${c.border}`, borderRadius: 6,
        padding: '8px 10px', textAlign: 'left',
        cursor: onClick ? 'pointer' : 'default',
        color: c.fg,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#6b7280', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{hint}</div>}
    </button>
  );
}

function MiniBars({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <div style={{ background: '#f9fafb', borderRadius: 6, padding: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#6b7280', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 50px', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</span>
            <div style={{ height: 8, background: '#fff', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${(v / max) * 100}%`, height: '100%', background: '#3b82f6' }} />
            </div>
            <span style={{ fontSize: 11, fontFamily: 'monospace', textAlign: 'right', color: '#374151' }}>{v.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
