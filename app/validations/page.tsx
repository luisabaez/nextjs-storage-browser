'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import './validations.css';
import config from '../../amplify_outputs.json';
import Link from 'next/link';
import {
  ENTITY_NAMES,
  ENTITY_CLASSIFICATION,
  TIERS,
  tierForEntity,
  computeSampleSize,
  parseFilename,
  selectSample,
  readWorkbook,
  buildAndDownload,
  FileData,
} from './sampling';

Amplify.configure(config);

const SAMPLING_FOLDER = 'Sampling/';

type TabId = 'sampling';

interface FileEntry {
  id: string;
  fileName: string;
  entity: string; // entity key from ENTITY_CLASSIFICATION, or '' if unknown
  agency: string;
  N: number;
  loading: boolean;
  error: string;
  data: FileData | null;
  generated: { seed: number; n: number; at: string } | null;
}

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function stamp(d: Date) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ValidationsPage() {
  const [userEmail, setUserEmail] = useState('');
  const [activeTab] = useState<TabId>('sampling');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const patch = useCallback((id: string, p: Partial<FileEntry>) => {
    setEntries(prev => prev.map(e => (e.id === id ? { ...e, ...p } : e)));
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => /\.(xlsx|xlsm|xls)$/i.test(f.name));
    for (const file of list) {
      const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const parsed = parseFilename(file.name);
      setEntries(prev => [...prev, {
        id, fileName: file.name,
        entity: parsed.entity || '', agency: parsed.agency,
        N: 0, loading: true, error: '', data: null, generated: null,
      }]);
      try {
        const data = await readWorkbook(file);
        patch(id, { data, N: data.rows.length, loading: false });
      } catch (err) {
        patch(id, { loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [patch]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const generate = (entry: FileEntry) => {
    if (!entry.data || !entry.entity) return;
    const tier = tierForEntity(entry.entity);
    if (!tier) return;
    const n = computeSampleSize(entry.N, tier);
    const seed = Math.floor(Math.random() * 2 ** 32) >>> 0;
    const selectedIndices = selectSample(entry.N, n, seed);
    const now = new Date();
    const agency = entry.agency || 'NA';
    const fname = `${entry.entity.replace(/\s+/g, '_')}_${agency}_Sample_${stamp(now)}.xlsx`;
    buildAndDownload(entry.data, {
      entity: entry.entity, agency, tier, N: entry.N, n, seed,
      generatedAt: now.toISOString(), generatedBy: userEmail, selectedIndices,
    }, fname);
    patch(entry.id, { generated: { seed, n, at: now.toLocaleString() } });
  };

  const nFor = (entry: FileEntry): number | null => {
    const tier = entry.entity ? tierForEntity(entry.entity) : null;
    if (!tier || !entry.N) return null;
    return computeSampleSize(entry.N, tier);
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
              Drop one or more consolidated master files (one per agency). Each file&rsquo;s
              population is sized with the Data Validation Framework V2 formula for its entity
              classification, a simple random sample is drawn, and a workbook with the{' '}
              <strong>Sample</strong>, full <strong>Population</strong>, and a{' '}
              <strong>Sizing/Evidence</strong> sheet is produced. Files are read and sampled in
              your browser — the data never leaves your machine.
            </p>
            <div className="val-note">
              n = N·Z²·p·(1−p) / [ e²·(N−1) + Z²·p·(1−p) ], rounded up. Classification tiers:
              {' '}HIGH 99% · MODERATE 95% · LOW 90% · AUTO 85%. Selection uses a recorded random
              seed so any sample can be reproduced.
            </div>
          </div>

          {/* Drop zone */}
          <div
            className={`val-dropzone ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xlsm,.xls"
              multiple
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
            />
            <span className="val-dropzone-icon">📥</span>
            <p><strong>Drop consolidated master files here</strong> or click to browse</p>
            <p className="val-dropzone-hint">.xlsx — one file per agency (e.g. Consolidated_Suppliers_015.xlsx)</p>
          </div>

          {/* Files table */}
          {entries.length > 0 && (
            <table className="val-table val-files">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Entity</th>
                  <th className="val-col-agency">Agency</th>
                  <th className="val-col-num">Population (N)</th>
                  <th className="val-col-class">Class</th>
                  <th className="val-col-num">Sample (n)</th>
                  <th className="val-col-gen">Action</th>
                  <th className="val-col-caret"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => {
                  const cls = entry.entity ? ENTITY_CLASSIFICATION[entry.entity] : null;
                  const n = nFor(entry);
                  return (
                    <tr key={entry.id}>
                      <td className="val-file-name" title={entry.fileName}>
                        {entry.fileName}
                        {entry.loading && <span className="val-spinner val-spinner-dark" />}
                        {entry.error && <div className="val-file-err">{entry.error}</div>}
                      </td>
                      <td>
                        <select
                          value={entry.entity}
                          onChange={e => patch(entry.id, { entity: e.target.value, generated: null })}
                          className={entry.entity ? '' : 'val-select-empty'}
                        >
                          <option value="">— select entity —</option>
                          {ENTITY_NAMES.map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      </td>
                      <td className="val-col-agency">
                        <input
                          type="text"
                          value={entry.agency}
                          onChange={e => patch(entry.id, { agency: e.target.value })}
                          placeholder="—"
                        />
                      </td>
                      <td className="val-col-num">{entry.N ? entry.N.toLocaleString() : (entry.loading ? '…' : '0')}</td>
                      <td className="val-col-class">
                        {cls ? <span className={`val-class val-class-${cls.toLowerCase()}`}>{cls}</span> : <span className="val-muted">—</span>}
                      </td>
                      <td className="val-col-num val-n">{n ?? '—'}</td>
                      <td className="val-col-gen">
                        <button
                          className="val-btn-row"
                          disabled={!entry.data || !entry.entity || !entry.N}
                          onClick={() => generate(entry)}
                        >
                          {entry.generated ? '↻ Re-generate' : '⬇ Generate'}
                        </button>
                        {entry.generated && (
                          <div className="val-gen-note" title={`seed ${entry.generated.seed}`}>
                            {entry.generated.n} rows · seed {entry.generated.seed}
                          </div>
                        )}
                      </td>
                      <td className="val-col-caret">
                        <button
                          className="val-remove"
                          onClick={() => setEntries(prev => prev.filter(e => e.id !== entry.id))}
                          aria-label="Remove"
                        >×</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Framework reference */}
          <div className="val-framework">
            <h3>Framework V2 — classification parameters</h3>
            <table className="val-table val-tiers">
              <thead>
                <tr><th>Class</th><th>Confidence</th><th>Z</th><th>Margin (e)</th><th>Expected error (p)</th><th>Entities</th></tr>
              </thead>
              <tbody>
                {Object.values(TIERS).map(t => (
                  <tr key={t.name}>
                    <td><span className={`val-class val-class-${t.name.toLowerCase()}`}>{t.name}</span></td>
                    <td>{Math.round(t.confidence * 100)}%</td>
                    <td>{t.Z}</td>
                    <td>{(t.e * 100).toFixed(t.e < 0.1 ? 0 : 0)}%</td>
                    <td>{(t.p * 100).toFixed(2)}%</td>
                    <td className="val-muted">
                      {ENTITY_NAMES.filter(e => ENTITY_CLASSIFICATION[e] === t.name).map(e => e.toLowerCase()).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default withAuthenticator(ValidationsPage);
