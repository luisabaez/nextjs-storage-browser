'use client';

import { Amplify } from 'aws-amplify';
import { list, getUrl, remove, copy } from 'aws-amplify/storage';
import { withAuthenticator } from '@aws-amplify/ui-react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { FilePreviewModal } from '../components/FilePreviewModal';
import outputs from '../../amplify_outputs.json';
import './ap-invoices.css';

Amplify.configure(outputs as any);

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedFileInfo {
  filename: string;
  pillar: string;
  entityType: string;        // HDR, LINES, LINES_DTL1
  entityTypeDisplay: string;  // Header, Lines, Lines DTL1
  mockNumber: string;         // MOCK10
  source: string;             // PRIFAS, HACIENDA, etc.
  dateStr: string;
  timeStr: string;
  valid: boolean;
  error?: string;
}

interface APFile {
  key: string;
  name: string;
  size: number;
  lastModified: Date;
  folder: 'input' | 'uploaded' | 'failed';
  parsed: ParsedFileInfo;
  status: 'pending' | 'processing' | 'success' | 'failed';
  rowCount?: number;
  errorMessage?: string;
}

interface ProcessingStatus {
  status: 'idle' | 'processing' | 'complete' | 'error';
  startedAt: string | null;
  completedAt: string | null;
  totalFiles: number;
  processedFiles: number;
  successCount: number;
  failCount: number;
  files: {
    filename: string;
    source: string;
    type: string;
    mockNumber: string;
    status: string;
    rowCount: number;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

const KNOWN_SOURCES = ['PRIFAS', 'HACIENDA', 'FIMAS', 'ASSMCA', 'SIFDE', 'SALUD', 'RETIRO'];

const S3_FOLDERS = {
  input: 'APInvoiceInput/',
  uploaded: 'UploadedAPInvoices/',
  failed: 'FailedAPInvoices/',
};

type TabId = 'all' | 'pending' | 'uploaded' | 'failed';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseAPFilename(filename: string): ParsedFileInfo {
  const base: ParsedFileInfo = {
    filename,
    pillar: '',
    entityType: '',
    entityTypeDisplay: '',
    mockNumber: '',
    source: '',
    dateStr: '',
    timeStr: '',
    valid: false,
  };

  // Remove path prefix, keep just the filename
  const name = filename.split('/').pop() || filename;
  base.filename = name;

  // Skip non-CSV files and hidden files
  if (!name.toLowerCase().endsWith('.csv') || name.startsWith('_') || name.startsWith('.')) {
    base.error = 'Not a CSV file';
    return base;
  }

  // Pattern: FIN_AP_INVOICE_{TYPE}_MOCK{N}_{SOURCE}_{DATE}_{TIME}.csv
  // Where TYPE = HDR | LINES_DTL1 | LINES
  // Note: LINES_DTL1 must be checked before LINES since LINES is a prefix of LINES_DTL1

  const dtl1Match = name.match(
    /^(FIN)_AP_INVOICE_LINES_DTL1_MOCK(\d+)_([A-Z0-9]+)_(\d{8})_(\d{4})\.csv$/i
  );
  if (dtl1Match) {
    base.pillar = dtl1Match[1].toUpperCase();
    base.entityType = 'LINES_DTL1';
    base.entityTypeDisplay = 'Lines DTL1';
    base.mockNumber = `MOCK${dtl1Match[2]}`;
    base.source = dtl1Match[3].toUpperCase();
    base.dateStr = dtl1Match[4];
    base.timeStr = dtl1Match[5];
    base.valid = true;
    return base;
  }

  const linesMatch = name.match(
    /^(FIN)_AP_INVOICE_LINES_MOCK(\d+)_([A-Z0-9]+)_(\d{8})_(\d{4})\.csv$/i
  );
  if (linesMatch) {
    base.pillar = linesMatch[1].toUpperCase();
    base.entityType = 'LINES';
    base.entityTypeDisplay = 'Lines';
    base.mockNumber = `MOCK${linesMatch[2]}`;
    base.source = linesMatch[3].toUpperCase();
    base.dateStr = linesMatch[4];
    base.timeStr = linesMatch[5];
    base.valid = true;
    return base;
  }

  const hdrMatch = name.match(
    /^(FIN)_AP_INVOICE_HDR_MOCK(\d+)_([A-Z0-9]+)_(\d{8})_(\d{4})\.csv$/i
  );
  if (hdrMatch) {
    base.pillar = hdrMatch[1].toUpperCase();
    base.entityType = 'HDR';
    base.entityTypeDisplay = 'Header';
    base.mockNumber = `MOCK${hdrMatch[2]}`;
    base.source = hdrMatch[3].toUpperCase();
    base.dateStr = hdrMatch[4];
    base.timeStr = hdrMatch[5];
    base.valid = true;
    return base;
  }

  base.error = 'Filename does not match expected AP Invoice pattern';
  return base;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

// ─── Main Component ──────────────────────────────────────────────────────────

function APInvoiceDashboard() {
  const [files, setFiles] = useState<APFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [filterSource, setFilterSource] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [previewFile, setPreviewFile] = useState<{name: string; path: string; size?: number} | null>(null);

  // ─── Load files from S3 ──────────────────────────────────────────────────

  const loadFiles = useCallback(async () => {
    try {
      const allFiles: APFile[] = [];

      // Load from all three folders in parallel
      const [inputResult, uploadedResult, failedResult] = await Promise.all([
        list({ path: S3_FOLDERS.input }).catch(() => ({ items: [] })),
        list({ path: S3_FOLDERS.uploaded }).catch(() => ({ items: [] })),
        list({ path: S3_FOLDERS.failed }).catch(() => ({ items: [] })),
      ]);

      const processItems = (items: any[], folder: APFile['folder'], status: APFile['status']) => {
        for (const item of items) {
          if (!item.path || item.path.endsWith('/') || item.path.endsWith('_processing_status.json')) continue;
          const name = item.path.split('/').pop() || '';
          if (!name || name.startsWith('_') || name.startsWith('.') || name.endsWith('_error.txt')) continue;

          const parsed = parseAPFilename(name);

          allFiles.push({
            key: item.path,
            name,
            size: item.size || 0,
            lastModified: item.lastModified ? new Date(item.lastModified) : new Date(),
            folder,
            parsed,
            status,
          });
        }
      };

      processItems(inputResult.items || [], 'input', 'pending');
      processItems(uploadedResult.items || [], 'uploaded', 'success');
      processItems(failedResult.items || [], 'failed', 'failed');

      // Load last processing status to get row counts
      try {
        const statusUrl = await getUrl({ path: S3_FOLDERS.input + '_processing_status.json' });
        if (statusUrl?.url) {
          const statusResp = await fetch(statusUrl.url.toString());
          if (statusResp.ok) {
            const statusData: ProcessingStatus = await statusResp.json();
            if (statusData.files && statusData.files.length > 0) {
              for (const file of allFiles) {
                const match = statusData.files.find(sf => sf.filename === file.name);
                if (match) {
                  if (match.rowCount) file.rowCount = match.rowCount;
                  if (match.error) file.errorMessage = match.error;
                }
              }
            }
          }
        }
      } catch {
        // No status file, that's ok
      }

      // Check for error detail files for failed files without error messages
      for (const file of allFiles) {
        if (file.status === 'failed' && !file.errorMessage) {
          try {
            const errorKey = file.key + '_error.txt';
            const errorUrl = await getUrl({ path: errorKey });
            if (errorUrl?.url) {
              const resp = await fetch(errorUrl.url.toString());
              if (resp.ok) {
                file.errorMessage = await resp.text();
              }
            }
          } catch {
            // No error file, that's ok
          }
        }
      }

      setFiles(allFiles);
    } catch (err) {
      console.error('Error loading files:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // ─── Check for active processing status ──────────────────────────────────

  const checkProcessingStatus = useCallback(async () => {
    try {
      const statusUrl = await getUrl({ path: S3_FOLDERS.input + '_processing_status.json' });
      if (statusUrl?.url) {
        const resp = await fetch(statusUrl.url.toString());
        if (resp.ok) {
          const status: ProcessingStatus = await resp.json();
          setProcessingStatus(status);

          // Update file statuses from processing status
          if (status.files && status.files.length > 0) {
            setFiles(prev => prev.map(f => {
              const statusEntry = status.files.find(sf => sf.filename === f.name);
              if (statusEntry) {
                return {
                  ...f,
                  status: statusEntry.status as APFile['status'],
                  rowCount: statusEntry.rowCount || undefined,
                  errorMessage: statusEntry.error || undefined,
                };
              }
              return f;
            }));
          }

          if (status.status === 'complete' || status.status === 'error') {
            setIsProcessing(false);
            // Reload files to get updated folder locations
            setTimeout(() => loadFiles(), 2000);
          }

          return status;
        }
      }
    } catch {
      // No status file
    }
    return null;
  }, [loadFiles]);

  // ─── Polling for processing updates ──────────────────────────────────────

  useEffect(() => {
    if (isProcessing) {
      const interval = setInterval(async () => {
        const status = await checkProcessingStatus();
        if (status && (status.status === 'complete' || status.status === 'error')) {
          clearInterval(interval);
        }
      }, 3000);
      setPollingInterval(interval);
      return () => clearInterval(interval);
    } else if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
    }
  }, [isProcessing, checkProcessingStatus]);

  // ─── Run AP Invoices ─────────────────────────────────────────────────────

  const handleRunAPInvoices = useCallback(async () => {
    if (isProcessing) return;

    const inputFiles = files.filter(f => f.folder === 'input');
    if (inputFiles.length === 0) {
      alert('No files in the AP Invoice Input folder to process.');
      return;
    }

    if (!confirm(`Process ${inputFiles.length} file(s) in the AP Invoice Input folder?\n\nThis will:\n- Validate each file\n- Load data into Hacienda_ERP_Test database\n- Move files to Uploaded or Failed folders\n\nTarget tables will be truncated before loading.`)) {
      return;
    }

    setIsProcessing(true);
    setProcessingStatus({
      status: 'processing',
      startedAt: new Date().toISOString(),
      completedAt: null,
      totalFiles: inputFiles.length,
      processedFiles: 0,
      successCount: 0,
      failCount: 0,
      files: inputFiles.map(f => ({
        filename: f.name,
        source: f.parsed.source,
        type: f.parsed.entityTypeDisplay,
        mockNumber: f.parsed.mockNumber,
        status: 'pending',
        rowCount: 0,
        error: null,
        startedAt: null,
        completedAt: null,
      })),
    });

    try {
      if (!LAMBDA_URL) {
        // If Lambda URL not yet configured, show a message
        alert('Lambda Function URL not yet configured. Set the LAMBDA_URL constant in ap-invoices/page.tsx after deploying the Lambda.');
        setIsProcessing(false);
        return;
      }

      const response = await fetch(`${LAMBDA_URL}?action=process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'hacienda-erp-dev',
          inputFolder: S3_FOLDERS.input,
          uploadedFolder: S3_FOLDERS.uploaded,
          failedFolder: S3_FOLDERS.failed,
        }),
      });

      if (!response.ok) {
        throw new Error(`Lambda returned ${response.status}: ${response.statusText}`);
      }

      // Response is immediate, polling will track progress
    } catch (err: any) {
      console.error('Error invoking Lambda:', err);
      setProcessingStatus(prev => prev ? { ...prev, status: 'error' } : null);
      setIsProcessing(false);
      alert(`Error starting processing: ${err.message}`);
    }
  }, [isProcessing, files]);

  // ─── File actions ────────────────────────────────────────────────────────

  const handleViewFile = useCallback((file: APFile) => {
    setPreviewFile({ name: file.name, path: file.key, size: file.size });
  }, []);

  const handleDownloadPreviewFile = useCallback(async () => {
    if (!previewFile) return;
    try {
      const result = await getUrl({ path: previewFile.path, options: { expiresIn: 3600 } });
      const link = document.createElement('a');
      link.href = result.url.toString();
      link.download = previewFile.name;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Download error:', err);
    }
  }, [previewFile]);

  const toggleExpandRow = useCallback((key: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // ─── Filtered files ──────────────────────────────────────────────────────

  const filteredFiles = useMemo(() => {
    let result = [...files];

    // Tab filter
    if (activeTab === 'pending') result = result.filter(f => f.folder === 'input');
    else if (activeTab === 'uploaded') result = result.filter(f => f.folder === 'uploaded');
    else if (activeTab === 'failed') result = result.filter(f => f.folder === 'failed');

    // Source filter
    if (filterSource !== 'all') {
      result = result.filter(f => f.parsed.source === filterSource);
    }

    // Type filter
    if (filterType !== 'all') {
      result = result.filter(f => f.parsed.entityType === filterType);
    }

    // Status filter
    if (filterStatus !== 'all') {
      result = result.filter(f => f.status === filterStatus);
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(f => f.name.toLowerCase().includes(q));
    }

    // Sort: processing first, then by lastModified desc
    result.sort((a, b) => {
      if (a.status === 'processing' && b.status !== 'processing') return -1;
      if (b.status === 'processing' && a.status !== 'processing') return 1;
      return b.lastModified.getTime() - a.lastModified.getTime();
    });

    return result;
  }, [files, activeTab, filterSource, filterType, filterStatus, searchQuery]);

  // ─── Stats ───────────────────────────────────────────────────────────────

  const stats = useMemo(() => ({
    total: files.length,
    pending: files.filter(f => f.folder === 'input').length,
    uploaded: files.filter(f => f.folder === 'uploaded').length,
    failed: files.filter(f => f.folder === 'failed').length,
    processing: files.filter(f => f.status === 'processing').length,
  }), [files]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="ap-dashboard">
        <div className="ap-loading">
          <span className="ap-spinner"></span>
          Loading AP Invoice Dashboard...
        </div>
      </div>
    );
  }

  return (
    <div className="ap-dashboard">
      {/* Header */}
      <header className="ap-header">
        <div className="ap-header-left">
          <Link href="/" className="ap-back-link">
            &larr; File Browser
          </Link>
          <div className="ap-header-title">
            <h1>AP Invoice Processing Dashboard</h1>
            <p className="ap-header-subtitle">
              Track AP invoice file uploads and processing lifecycle
            </p>
          </div>
        </div>
        <div className="ap-header-right">
          <button className="ap-refresh-btn" onClick={loadFiles} title="Refresh">
            &#x21bb; Refresh
          </button>
          <button
            className={`ap-run-btn ${isProcessing ? 'processing' : ''}`}
            onClick={handleRunAPInvoices}
            disabled={isProcessing || stats.pending === 0}
          >
            {isProcessing ? (
              <>
                <span className="ap-spinner"></span>
                Processing...
              </>
            ) : (
              <>
                &#9654; Run AP Invoices
              </>
            )}
          </button>
        </div>
      </header>

      <div className="ap-content">
        {/* Stat Cards */}
        <div className="ap-stats-grid">
          <div className="ap-stat-card">
            <div className="ap-stat-icon total">&#128196;</div>
            <div className="ap-stat-info">
              <h3>{stats.total}</h3>
              <p>Total Files</p>
            </div>
          </div>
          <div className="ap-stat-card">
            <div className="ap-stat-icon uploaded">&#9989;</div>
            <div className="ap-stat-info">
              <h3>{stats.uploaded}</h3>
              <p>Uploaded</p>
            </div>
          </div>
          <div className="ap-stat-card">
            <div className="ap-stat-icon processing">&#9203;</div>
            <div className="ap-stat-info">
              <h3>{stats.pending + stats.processing}</h3>
              <p>Pending / Processing</p>
            </div>
          </div>
          <div className="ap-stat-card">
            <div className="ap-stat-icon failed">&#9888;</div>
            <div className="ap-stat-info">
              <h3>{stats.failed}</h3>
              <p>Errors</p>
            </div>
          </div>
        </div>

        {/* Processing Panel */}
        {processingStatus && processingStatus.status !== 'idle' && (
          <div className="ap-processing-panel">
            <div className="ap-processing-header">
              <h3>
                {processingStatus.status === 'processing' && (
                  <><span className="ap-spinner"></span> Processing Files...</>
                )}
                {processingStatus.status === 'complete' && '&#9989; Processing Complete'}
                {processingStatus.status === 'error' && '&#9888; Processing Ended With Errors'}
              </h3>
              <span className="ap-progress-text">
                {processingStatus.processedFiles} of {processingStatus.totalFiles} files
                {processingStatus.successCount > 0 && ` | ${processingStatus.successCount} succeeded`}
                {processingStatus.failCount > 0 && ` | ${processingStatus.failCount} failed`}
              </span>
            </div>
            <div className="ap-progress-bar-wrapper">
              <div
                className={`ap-progress-bar ${processingStatus.failCount > 0 ? 'has-errors' : ''}`}
                style={{
                  width: processingStatus.totalFiles > 0
                    ? `${(processingStatus.processedFiles / processingStatus.totalFiles) * 100}%`
                    : '0%'
                }}
              ></div>
            </div>
            {processingStatus.files && processingStatus.files.length > 0 && (
              <ul className="ap-processing-files">
                {processingStatus.files.map((f, i) => (
                  <li
                    key={i}
                    className={`ap-processing-file ${
                      f.status === 'processing' ? 'current' :
                      f.status === 'success' ? 'done' :
                      f.status === 'failed' ? 'error' : ''
                    }`}
                  >
                    {f.status === 'processing' && <span className="ap-spinner"></span>}
                    {f.status === 'success' && <span>&#10003;</span>}
                    {f.status === 'failed' && <span>&#10007;</span>}
                    {f.status === 'pending' && <span className="ap-status-dot pending"></span>}
                    <span>{f.filename}</span>
                    {f.rowCount > 0 && <span className="ap-row-count">({formatNumber(f.rowCount)} rows)</span>}
                    {f.error && <span style={{ color: '#dc2626', fontSize: '12px' }}> - {f.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="ap-filters">
          <select
            className="ap-filter-select"
            value={filterSource}
            onChange={e => setFilterSource(e.target.value)}
          >
            <option value="all">All Sources</option>
            {KNOWN_SOURCES.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            className="ap-filter-select"
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
          >
            <option value="all">All Types</option>
            <option value="HDR">Header</option>
            <option value="LINES">Lines</option>
            <option value="LINES_DTL1">Lines DTL1</option>
          </select>

          <select
            className="ap-filter-select"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>

          <div className="ap-search-wrapper">
            <span className="ap-search-icon">&#128269;</span>
            <input
              type="text"
              className="ap-search-input"
              placeholder="Search files..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Tabs + Table */}
        <div className="ap-tabs">
          <div className="ap-tab-list">
            {([
              { id: 'all' as TabId, label: 'All Files', count: stats.total },
              { id: 'pending' as TabId, label: 'Pending', count: stats.pending },
              { id: 'uploaded' as TabId, label: 'Uploaded', count: stats.uploaded },
              { id: 'failed' as TabId, label: 'Failed', count: stats.failed },
            ]).map(tab => (
              <button
                key={tab.id}
                className={`ap-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                <span className="ap-tab-count">{tab.count}</span>
              </button>
            ))}
          </div>

          {/* Table */}
          {filteredFiles.length === 0 ? (
            <div className="ap-empty-state">
              <div className="ap-empty-icon">&#128451;</div>
              <h3>No files found</h3>
              <p>
                {activeTab === 'pending'
                  ? 'Upload AP Invoice CSV files to the APInvoiceInput folder to get started.'
                  : 'No files match the current filters.'}
              </p>
            </div>
          ) : (
            <table className="ap-file-table">
              <thead>
                <tr>
                  <th style={{ width: '30px' }}></th>
                  <th>File Name</th>
                  <th>Source</th>
                  <th>Type</th>
                  <th>Mock</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredFiles.map(file => (
                  <>
                    <tr key={file.key}>
                      <td>
                        {(file.status === 'failed' && file.errorMessage) && (
                          <button
                            className={`ap-expand-btn ${expandedRows.has(file.key) ? 'expanded' : ''}`}
                            onClick={() => toggleExpandRow(file.key)}
                          >
                            &#9654;
                          </button>
                        )}
                      </td>
                      <td>
                        <div className="ap-file-name">
                          <span
                            className="ap-file-link"
                            onClick={() => handleViewFile(file)}
                            title="Click to view file"
                          >
                            {file.name}
                          </span>
                        </div>
                      </td>
                      <td>
                        {file.parsed.source ? (
                          <span className={`ap-source-badge ${file.parsed.source.toLowerCase()}`}>
                            {file.parsed.source}
                          </span>
                        ) : (
                          <span style={{ color: '#999' }}>-</span>
                        )}
                      </td>
                      <td>
                        <span className="ap-type-badge">
                          {file.parsed.entityTypeDisplay || 'Unknown'}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: '12px', fontWeight: 500 }}>
                          {file.parsed.mockNumber || '-'}
                        </span>
                      </td>
                      <td>
                        <span className={`ap-status-badge ${file.status}`}>
                          <span className={`ap-status-dot ${file.status}`}></span>
                          {file.status.charAt(0).toUpperCase() + file.status.slice(1)}
                        </span>
                      </td>
                      <td>
                        <span className="ap-row-count">
                          {file.rowCount ? formatNumber(file.rowCount) : '-'}
                        </span>
                      </td>
                      <td>
                        <span className="ap-timestamp">{formatDate(file.lastModified)}</span>
                      </td>
                      <td>
                        <button
                          className="ap-action-btn"
                          onClick={() => handleViewFile(file)}
                          title="View file"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                    {expandedRows.has(file.key) && file.errorMessage && (
                      <tr key={`${file.key}-error`} className="ap-error-row">
                        <td colSpan={9}>
                          <div className="ap-error-details">
                            <strong>Error Details:</strong>
                            {file.errorMessage}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <FilePreviewModal
        isOpen={!!previewFile}
        onClose={() => setPreviewFile(null)}
        file={previewFile}
        onDownload={handleDownloadPreviewFile}
      />
    </div>
  );
}

export default withAuthenticator(APInvoiceDashboard);
