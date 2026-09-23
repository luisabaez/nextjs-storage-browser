'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiResult, apiGet } from '../lib/symphony';
import { useHcm } from './HcmShell';

/*
 * The failing records behind one validation, read a page at a time. An agency
 * sees only its own party's records; the validation team passes a source and
 * optionally a BU instead of an agency.
 */

interface RecordsPage extends ApiResult {
  party?: string;
  columns?: { name: string; label: string }[];
  rows?: (string | null)[][];
  total?: number;
  offset?: number;
  limit?: number;
}

const PAGE = 200;

export default function RecordsTable({ validationCode, source, agency, bu }: {
  validationCode: string;
  source: string;
  agency?: string;
  bu?: string;
}) {
  const { mock, email, view } = useHcm();
  const [page, setPage] = useState<RecordsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = useCallback(async (from: number) => {
    const id = ++latest.current;
    setLoading(true);
    setError('');
    const d = await apiGet<RecordsPage>('cert_validation_rows', {
      mock, validation_code: validationCode, source, agency: agency || '', bu: bu || '', offset: from, limit: PAGE, email,
    });
    if (id !== latest.current) return;
    setLoading(false);
    if (!d.ok) {
      setPage(null);
      setError((view === 'staff' && d.error) || 'The records could not be loaded. Please try again in a moment.');
      return;
    }
    setPage(d);
    setOffset(d.offset ?? from);
  }, [mock, validationCode, source, agency, bu, email, view]);

  useEffect(() => { load(0); }, [load]);

  // Columns nobody filled on this page only add noise.
  const columns = useMemo(() => {
    const cols = page?.columns ?? [];
    const rows = page?.rows ?? [];
    return cols.map((c, i) => ({ ...c, i })).filter(c => rows.some(r => (r[c.i] ?? '') !== ''));
  }, [page]);

  const total = page?.total ?? 0;
  const shown = page?.rows?.length ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + shown;

  return (
    <div className="hcm-records" aria-live="polite">
      <div className="hcm-records-bar">
        <span className="sy-muted">
          {loading ? 'Loading records…'
            : total === 0 ? 'No records were found for this validation.'
            : `Records ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
        {total > PAGE && (
          <span className="hcm-records-nav">
            <button type="button" className="btn btn-secondary" disabled={loading || offset === 0} onClick={() => load(Math.max(0, offset - PAGE))}>
              Previous
            </button>
            <button type="button" className="btn btn-secondary" disabled={loading || last >= total} onClick={() => load(offset + PAGE)}>
              Next
            </button>
          </span>
        )}
      </div>
      {error && <div className="sy-error" role="alert">{error}</div>}
      {shown > 0 && (
        <div className="hcm-records-scroll" tabIndex={0} role="region" aria-label={`Records of ${validationCode}`}>
          <table className="sy-table hcm-records-table">
            <thead>
              <tr>{columns.map(c => <th key={c.name} scope="col">{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {(page?.rows ?? []).map((r, n) => (
                <tr key={n}>{columns.map(c => <td key={c.name}>{r[c.i] ?? ''}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
