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
  module: string;           // FIN, HCM, SCM
  entityPrefix: string;     // FIN_AP_INVOICE_HDR, HCM_PERSON, etc.
  entityDisplay: string;    // "AP Invoice Header", "Person", etc.
  mockNumber: string;       // MOCK10, MOCK10PRE, MOCK11PRE
  source: string;           // PRIFAS, HACIENDA, etc.
  dateStr: string;
  timeStr: string;
  extension: string;        // csv, xlsx
  isLegacy: boolean;
  valid: boolean;
  error?: string;
}

interface APFile {
  key: string;
  name: string;
  size: number;
  lastModified: Date;
  folder: 'input' | 'processed' | 'failed' | 'unmatched';
  parsed: ParsedFileInfo;
  status: 'pending' | 'processing' | 'success' | 'failed';
  rowCount?: number;
  errorMessage?: string;
}

interface ProcessingFileStatus {
  filename: string;
  source: string;
  module: string;
  entity: string;
  entityDisplay: string;
  type: string;
  mockNumber: string;
  status: string;
  rowCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface ProcessingStatus {
  status: 'idle' | 'processing' | 'complete' | 'error';
  startedAt: string | null;
  completedAt: string | null;
  totalFiles: number;
  processedFiles: number;
  successCount: number;
  failCount: number;
  files: ProcessingFileStatus[];
}

interface HistoryRun {
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  totalFiles: number;
  processedFiles: number;
  successCount: number;
  failCount: number;
  durationSeconds?: number;
  files: ProcessingFileStatus[];
}

// ─── Entity Registry (mirrors Python entity_registry.py) ────────────────────

interface EntityInfo {
  module: string;
  displayName: string;
  legacy: boolean;
}

const ENTITY_REGISTRY: Record<string, EntityInfo> = {
  // FIN (19)
  FIN_AP_INVOICE_HDR: { module: 'FIN', displayName: 'AP Invoice Header', legacy: true },
  FIN_AP_INVOICE_LINES_DTL1: { module: 'FIN', displayName: 'AP Invoice Lines Detail', legacy: true },
  FIN_AP_INVOICE_LINES: { module: 'FIN', displayName: 'AP Invoice Lines', legacy: true },
  FIN_AR_INVOICE_DISTRIBUTION: { module: 'FIN', displayName: 'AR Invoice Distribution', legacy: false },
  FIN_AR_INVOICE_LINES: { module: 'FIN', displayName: 'AR Invoice Lines', legacy: false },
  FIN_AR_INVOICE: { module: 'FIN', displayName: 'AR Invoice', legacy: false },
  FIN_AWARDS_CFDACMIA: { module: 'FIN', displayName: 'Awards CFDA/CMIA', legacy: false },
  FIN_BUDGETARY_BALANCES: { module: 'FIN', displayName: 'Budgetary Balances', legacy: false },
  FIN_CUSTOMER_CONTACT: { module: 'FIN', displayName: 'Customer Contact', legacy: false },
  FIN_CUSTOMER: { module: 'FIN', displayName: 'Customer', legacy: false },
  FIN_GL_BALANCES: { module: 'FIN', displayName: 'GL Balances', legacy: false },
  FIN_PROJECT_CLASS: { module: 'FIN', displayName: 'Project Class', legacy: false },
  FIN_PROJECTS_CROSS_REFERENCES: { module: 'FIN', displayName: 'Projects Cross References', legacy: false },
  FIN_PROJECTS_TASK_ACTIVITY: { module: 'FIN', displayName: 'Projects Task Activity', legacy: false },
  FIN_PROJECTS_TEAM_MEMBERS: { module: 'FIN', displayName: 'Projects Team Members', legacy: false },
  FIN_PROJECTS: { module: 'FIN', displayName: 'Projects', legacy: false },
  FIN_REQ_DISTRIBUTION: { module: 'FIN', displayName: 'Requisition Distribution', legacy: false },
  FIN_REQ_HDR: { module: 'FIN', displayName: 'Requisition Header', legacy: false },
  FIN_REQ_LINE: { module: 'FIN', displayName: 'Requisition Line', legacy: false },
  // HCM (18)
  HCM_ASSIGNMENT_EIT_KRONOS: { module: 'HCM', displayName: 'Assignment EIT Kronos', legacy: false },
  HCM_CONTRACT_SUPERVISOR: { module: 'HCM', displayName: 'Contract Supervisor', legacy: false },
  HCM_COST_ALLOCATION: { module: 'HCM', displayName: 'Cost Allocation', legacy: false },
  HCM_DEPARTMENT: { module: 'HCM', displayName: 'Department', legacy: false },
  HCM_ELEMENT_ENTRY_COSTING: { module: 'HCM', displayName: 'Element Entry Costing', legacy: false },
  HCM_ELEMENT_ENTRY: { module: 'HCM', displayName: 'Element Entry', legacy: false },
  HCM_EXTERNAL_BANK_ACCOUNT: { module: 'HCM', displayName: 'External Bank Account', legacy: false },
  HCM_JOBS: { module: 'HCM', displayName: 'Jobs', legacy: false },
  HCM_LOCATION: { module: 'HCM', displayName: 'Location', legacy: false },
  HCM_PERSONAL_PAYMENT_METHOD: { module: 'HCM', displayName: 'Personal Payment Method', legacy: false },
  HCM_PERSON_ADDRESS: { module: 'HCM', displayName: 'Person Address', legacy: false },
  HCM_PERSON_ASSIGNMENT: { module: 'HCM', displayName: 'Person Assignment', legacy: false },
  HCM_PERSON_EMAIL: { module: 'HCM', displayName: 'Person Email', legacy: false },
  HCM_PERSON_NAME: { module: 'HCM', displayName: 'Person Name', legacy: false },
  HCM_PERSON_NID: { module: 'HCM', displayName: 'Person NID', legacy: false },
  HCM_PERSON_SUPERVISOR: { module: 'HCM', displayName: 'Person Supervisor', legacy: false },
  HCM_PERSON: { module: 'HCM', displayName: 'Person', legacy: false },
  HCM_SENIORITY: { module: 'HCM', displayName: 'Seniority', legacy: false },
  // SCM (19)
  SCM_BU_RECENT_BILLTO_SHIPTO_LOCATION: { module: 'SCM', displayName: 'BU Recent BillTo/ShipTo Location', legacy: false },
  SCM_CATALOG: { module: 'SCM', displayName: 'Catalog', legacy: false },
  SCM_CATEGORY: { module: 'SCM', displayName: 'Category', legacy: false },
  SCM_CONTRACTS_LINES: { module: 'SCM', displayName: 'Contracts Lines', legacy: false },
  SCM_CONTRACTS: { module: 'SCM', displayName: 'Contracts', legacy: false },
  SCM_CONTRACT_LINES: { module: 'SCM', displayName: 'Contract Lines', legacy: false },
  SCM_ITEMS: { module: 'SCM', displayName: 'Items', legacy: false },
  SCM_LOCATIONS: { module: 'SCM', displayName: 'Locations', legacy: false },
  SCM_PURCHASE_ORDER_COMMENTS: { module: 'SCM', displayName: 'Purchase Order Comments', legacy: false },
  SCM_PURCHASE_ORDER_LINE_DISTRIBUTION: { module: 'SCM', displayName: 'PO Line Distribution', legacy: false },
  SCM_PURCHASE_ORDER_LINE_LOCATIONS: { module: 'SCM', displayName: 'PO Line Locations', legacy: false },
  SCM_PURCHASE_ORDER_LINES: { module: 'SCM', displayName: 'Purchase Order Lines', legacy: false },
  SCM_PURCHASE_ORDER: { module: 'SCM', displayName: 'Purchase Order', legacy: false },
  SCM_SUPPLIER_ADDRESS: { module: 'SCM', displayName: 'Supplier Address', legacy: false },
  SCM_SUPPLIER_BANK_ACCOUNTS: { module: 'SCM', displayName: 'Supplier Bank Accounts', legacy: false },
  SCM_SUPPLIER_CONTACT: { module: 'SCM', displayName: 'Supplier Contact', legacy: false },
  SCM_SUPPLIER_SITE_ASSIG: { module: 'SCM', displayName: 'Supplier Site Assignment', legacy: false },
  SCM_SUPPLIER_SITE: { module: 'SCM', displayName: 'Supplier Site', legacy: false },
  SCM_SUPPLIER: { module: 'SCM', displayName: 'Supplier', legacy: false },
};

// Sorted longest-first for unambiguous matching (same as Python)
const SORTED_PREFIXES = Object.keys(ENTITY_REGISTRY).sort((a, b) => b.length - a.length);

const EXCLUDED_PREFIXES = ['FIN_ASSETS', 'SCM_INV'];

// ─── Constants ───────────────────────────────────────────────────────────────

const LAMBDA_URL = 'https://5ahxjcxhrcopng5hjgc2n6utxq0rwcmm.lambda-url.us-east-1.on.aws/';

const KNOWN_SOURCES = [
  'PRIFAS', 'HACIENDA', 'FIMAS', 'ASSMCA', 'SIFDE', 'SALUD', 'RETIRO',
  'RHUM', 'KRONOSPOL', 'KRONOSPOL_PHASE2', 'DOE', 'ADPPOLICIA', '911', 'SURI', 'ASG',
];

const S3_FOLDERS = {
  input: 'InputFilesForProcessing/',
  processed: 'ProcessedFiles/',
  failed: 'FailedInvoices/',
  unmatched: 'FailedUnmatchedFilenames/',
};

type TabId = 'all' | 'pending' | 'uploaded' | 'failed' | 'history';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseFilename(filename: string): ParsedFileInfo {
  const base: ParsedFileInfo = {
    filename,
    module: '',
    entityPrefix: '',
    entityDisplay: '',
    mockNumber: '',
    source: '',
    dateStr: '',
    timeStr: '',
    extension: '',
    isLegacy: false,
    valid: false,
  };

  // Remove path prefix, keep just the filename
  const name = filename.split('/').pop() || filename;
  base.filename = name;

  // Check extension
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith('.csv')) {
    base.extension = 'csv';
  } else if (lowerName.endsWith('.xlsx')) {
    base.extension = 'xlsx';
  } else {
    // Skip non-data files and hidden files
    if (name.startsWith('_') || name.startsWith('.')) {
      base.error = 'Hidden or system file';
    } else {
      base.error = 'Unsupported file type (expected .csv or .xlsx)';
    }
    return base;
  }

  // Check excluded entities
  const nameUpper = name.toUpperCase();
  for (const excl of EXCLUDED_PREFIXES) {
    if (nameUpper.includes(excl)) {
      base.error = `File belongs to an excluded entity: ${excl}`;
      return base;
    }
  }

  // Match entity prefix using longest-first matching
  let matchedPrefix = '';
  for (const prefix of SORTED_PREFIXES) {
    if (nameUpper.startsWith(prefix + '_MOCK')) {
      matchedPrefix = prefix;
      break;
    }
  }

  if (!matchedPrefix) {
    base.error = 'Filename does not match any known entity pattern';
    return base;
  }

  const entityInfo = ENTITY_REGISTRY[matchedPrefix];
  base.entityPrefix = matchedPrefix;
  base.module = entityInfo.module;
  base.entityDisplay = entityInfo.displayName;
  base.isLegacy = entityInfo.legacy;

  // Extract remainder: _MOCK{N}[PRE]_{SOURCE}_{DATE}_{TIME}.ext
  const remainder = name.substring(matchedPrefix.length);
  const ext = base.extension === 'csv' ? '.csv' : '.xlsx';
  const pattern = new RegExp(
    `^_(MOCK\\d+(?:PRE)?)_([A-Z0-9_]+)_(\\d{8})_(\\d{4})${ext.replace('.', '\\.')}$`,
    'i'
  );
  const m = remainder.match(pattern);

  if (!m) {
    base.error = `Invalid filename structure after entity prefix '${matchedPrefix}'`;
    return base;
  }

  base.mockNumber = m[1].toUpperCase();
  base.source = m[2].toUpperCase();
  base.dateStr = m[3];
  base.timeStr = m[4];
  base.valid = true;

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

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function formatHistoryDate(isoStr: string | null): string {
  if (!isoStr) return '-';
  const d = new Date(isoStr.includes('Z') || isoStr.includes('+') ? isoStr : isoStr + 'Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

// ─── Main Component ──────────────────────────────────────────────────────────

function DataFileDashboard() {
  const [files, setFiles] = useState<APFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [filterSource, setFilterSource] = useState('all');
  const [filterModule, setFilterModule] = useState('all');
  const [filterEntity, setFilterEntity] = useState('all');
  const [filterMock, setFilterMock] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [previewFile, setPreviewFile] = useState<{name: string; path: string; size?: number} | null>(null);
  const [historyRuns, setHistoryRuns] = useState<HistoryRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [expandedHistoryRuns, setExpandedHistoryRuns] = useState<Set<number>>(new Set());

  // ─── Derived filter options ──────────────────────────────────────────────

  const entityOptions = useMemo(() => {
    if (filterModule === 'all') return SORTED_PREFIXES;
    return SORTED_PREFIXES.filter(p => ENTITY_REGISTRY[p].module === filterModule);
  }, [filterModule]);

  const mockOptions = useMemo(() => {
    const mocks = new Set<string>();
    for (const f of files) {
      if (f.parsed.mockNumber) mocks.add(f.parsed.mockNumber);
    }
    return Array.from(mocks).sort();
  }, [files]);

  // Reset entity filter when module changes
  useEffect(() => {
    setFilterEntity('all');
  }, [filterModule]);

  // ─── Load files from S3 ──────────────────────────────────────────────────

  const loadFiles = useCallback(async () => {
    try {
      const allFiles: APFile[] = [];

      // Load from all folders in parallel
      const [inputResult, processedResult, failedResult, unmatchedResult] = await Promise.all([
        list({ path: S3_FOLDERS.input }).catch(() => ({ items: [] })),
        list({ path: S3_FOLDERS.processed }).catch(() => ({ items: [] })),
        list({ path: S3_FOLDERS.failed }).catch(() => ({ items: [] })),
        list({ path: S3_FOLDERS.unmatched }).catch(() => ({ items: [] })),
      ]);

      const processItems = (items: any[], folder: APFile['folder'], status: APFile['status']) => {
        for (const item of items) {
          if (!item.path || item.path.endsWith('/') || item.path.includes('_processing_status.json') || item.path.includes('_processing_history/')) continue;
          const name = item.path.split('/').pop() || '';
          if (!name || name.startsWith('_') || name.startsWith('.') || name.endsWith('_error.txt')) continue;

          const parsed = parseFilename(name);

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
      processItems(processedResult.items || [], 'processed', 'success');
      processItems(failedResult.items || [], 'failed', 'failed');
      processItems(unmatchedResult.items || [], 'unmatched', 'failed');

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

  // ─── Load processing history ──────────────────────────────────────────────

  const loadHistory = useCallback(async () => {
    if (historyLoaded) return;
    setHistoryLoading(true);
    try {
      const response = await fetch(`${LAMBDA_URL}?action=history`);
      if (response.ok) {
        const data = await response.json();
        setHistoryRuns(data.runs || []);
        setHistoryLoaded(true);
      }
    } catch (err) {
      console.error('Error loading processing history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyLoaded]);

  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab, loadHistory]);

  // ─── Run Data File Processing ─────────────────────────────────────────────

  const handleRunProcessing = useCallback(async () => {
    if (isProcessing) return;

    const inputFiles = files.filter(f => f.folder === 'input');
    if (inputFiles.length === 0) {
      alert('No files in the InputFilesForProcessing folder to process.');
      return;
    }

    // Build filter description for confirmation
    const filterParts: string[] = [];
    if (filterModule !== 'all') filterParts.push(`Module: ${filterModule}`);
    if (filterEntity !== 'all') filterParts.push(`Entity: ${filterEntity}`);
    if (filterMock !== 'all') filterParts.push(`Mock: ${filterMock}`);
    const filterDesc = filterParts.length > 0
      ? `\n\nFilters applied:\n${filterParts.join('\n')}`
      : '';

    if (!confirm(`Process ${inputFiles.length} file(s) in InputFilesForProcessing?\n\nThis will:\n- Validate each file\n- Load data into Hacienda_ERP_Test database\n- Move files to ProcessedFiles or FailedInvoices folders\n\nTarget tables will be truncated before loading.${filterDesc}`)) {
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
        module: f.parsed.module,
        entity: f.parsed.entityPrefix,
        entityDisplay: f.parsed.entityDisplay,
        type: f.parsed.entityDisplay,
        mockNumber: f.parsed.mockNumber,
        status: 'pending',
        rowCount: 0,
        error: null,
        startedAt: null,
        completedAt: null,
      })),
    });

    try {
      // Build query params with filters
      const params = new URLSearchParams({ action: 'process' });
      if (filterModule !== 'all') params.set('module', filterModule);
      if (filterEntity !== 'all') params.set('entity', filterEntity);
      if (filterMock !== 'all') params.set('mock', filterMock);

      const response = await fetch(`${LAMBDA_URL}?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket: 'hacienda-erp-dev' }),
      });

      if (!response.ok) {
        throw new Error(`Lambda returned ${response.status}: ${response.statusText}`);
      }
    } catch (err: any) {
      console.error('Error invoking Lambda:', err);
      setProcessingStatus(prev => prev ? { ...prev, status: 'error' } : null);
      setIsProcessing(false);
      alert(`Error starting processing: ${err.message}`);
    }
  }, [isProcessing, files, filterModule, filterEntity, filterMock]);

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

  const toggleHistoryRun = useCallback((index: number) => {
    setExpandedHistoryRuns(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // ─── Filtered files ──────────────────────────────────────────────────────

  const filteredFiles = useMemo(() => {
    let result = [...files];

    // Tab filter
    if (activeTab === 'pending') result = result.filter(f => f.folder === 'input');
    else if (activeTab === 'uploaded') result = result.filter(f => f.folder === 'processed');
    else if (activeTab === 'failed') result = result.filter(f => f.folder === 'failed' || f.folder === 'unmatched');

    // Module filter
    if (filterModule !== 'all') {
      result = result.filter(f => f.parsed.module === filterModule);
    }

    // Entity filter
    if (filterEntity !== 'all') {
      result = result.filter(f => f.parsed.entityPrefix === filterEntity);
    }

    // Source filter
    if (filterSource !== 'all') {
      result = result.filter(f => f.parsed.source === filterSource);
    }

    // Mock filter
    if (filterMock !== 'all') {
      result = result.filter(f => f.parsed.mockNumber === filterMock);
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
  }, [files, activeTab, filterModule, filterEntity, filterSource, filterMock, filterStatus, searchQuery]);

  // ─── Stats ───────────────────────────────────────────────────────────────

  const stats = useMemo(() => ({
    total: files.length,
    pending: files.filter(f => f.folder === 'input').length,
    processed: files.filter(f => f.folder === 'processed').length,
    failed: files.filter(f => f.folder === 'failed' || f.folder === 'unmatched').length,
    processing: files.filter(f => f.status === 'processing').length,
  }), [files]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="ap-dashboard">
        <div className="ap-loading">
          <span className="ap-spinner"></span>
          Loading File Processing Dashboard...
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
            <h1>File Processing Dashboard</h1>
            <p className="ap-header-subtitle">
              Process FIN, HCM, and SCM data files into Hacienda ERP staging tables
            </p>
          </div>
        </div>
        <div className="ap-header-right">
          <button className="ap-refresh-btn" onClick={() => { loadFiles(); if (activeTab === 'history') { setHistoryLoaded(false); } }} title="Refresh">
            &#x21bb; Refresh
          </button>
          <button
            className={`ap-run-btn ${isProcessing ? 'processing' : ''}`}
            onClick={handleRunProcessing}
            disabled={isProcessing || stats.pending === 0}
          >
            {isProcessing ? (
              <>
                <span className="ap-spinner"></span>
                Processing...
              </>
            ) : (
              <>
                &#9654; Run File Processing
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
            <div className="ap-stat-icon processed">&#9989;</div>
            <div className="ap-stat-info">
              <h3>{stats.processed}</h3>
              <p>Processed</p>
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
                    {f.module && <span className={`ap-module-badge ${f.module.toLowerCase()}`}>{f.module}</span>}
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
        {activeTab !== 'history' && <div className="ap-filters">
          <select
            className="ap-filter-select"
            value={filterModule}
            onChange={e => setFilterModule(e.target.value)}
          >
            <option value="all">All Modules</option>
            <option value="FIN">FIN - Finance</option>
            <option value="HCM">HCM - Human Capital</option>
            <option value="SCM">SCM - Supply Chain</option>
          </select>

          <select
            className="ap-filter-select"
            value={filterEntity}
            onChange={e => setFilterEntity(e.target.value)}
          >
            <option value="all">All Entities</option>
            {entityOptions.map(prefix => (
              <option key={prefix} value={prefix}>
                {ENTITY_REGISTRY[prefix].displayName}
              </option>
            ))}
          </select>

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
            value={filterMock}
            onChange={e => setFilterMock(e.target.value)}
          >
            <option value="all">All Mocks</option>
            {mockOptions.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
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
        </div>}

        {/* Tabs + Table */}
        <div className="ap-tabs">
          <div className="ap-tab-list">
            {([
              { id: 'all' as TabId, label: 'All Files', count: stats.total },
              { id: 'pending' as TabId, label: 'Pending', count: stats.pending },
              { id: 'uploaded' as TabId, label: 'Processed', count: stats.processed },
              { id: 'failed' as TabId, label: 'Failed', count: stats.failed },
              { id: 'history' as TabId, label: 'History', count: historyRuns.length },
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

          {/* Tab Content */}
          {activeTab === 'history' ? (
            <div className="ap-history-content">
              {historyLoading ? (
                <div className="ap-loading" style={{ padding: '40px' }}>
                  <span className="ap-spinner"></span>
                  Loading processing history...
                </div>
              ) : historyRuns.length === 0 ? (
                <div className="ap-empty-state">
                  <div className="ap-empty-icon">&#128218;</div>
                  <h3>No processing history</h3>
                  <p>Processing runs will appear here after files are processed.</p>
                </div>
              ) : (
                <div className="ap-history-list">
                  {historyRuns.map((run, index) => (
                    <div key={index} className="ap-history-run">
                      <div
                        className="ap-history-run-header"
                        onClick={() => toggleHistoryRun(index)}
                      >
                        <div className="ap-history-run-toggle">
                          <span className={`ap-expand-btn ${expandedHistoryRuns.has(index) ? 'expanded' : ''}`}>
                            &#9654;
                          </span>
                        </div>
                        <div className="ap-history-run-date">
                          {formatHistoryDate(run.completedAt || run.startedAt)}
                        </div>
                        <div className="ap-history-run-stats">
                          <span className="ap-history-stat">
                            <strong>{run.totalFiles}</strong> files
                          </span>
                          <span className="ap-history-stat success">
                            <span className="ap-status-dot success"></span>
                            {run.successCount} succeeded
                          </span>
                          {run.failCount > 0 && (
                            <span className="ap-history-stat failed">
                              <span className="ap-status-dot failed"></span>
                              {run.failCount} failed
                            </span>
                          )}
                          {run.durationSeconds != null && (
                            <span className="ap-history-stat duration">
                              &#9201; {formatDuration(run.durationSeconds)}
                            </span>
                          )}
                        </div>
                        <div className="ap-history-run-badge">
                          <span className={`ap-status-badge ${run.failCount > 0 ? 'failed' : 'success'}`}>
                            <span className={`ap-status-dot ${run.failCount > 0 ? 'failed' : 'success'}`}></span>
                            {run.failCount > 0 ? 'Partial' : 'Success'}
                          </span>
                        </div>
                      </div>
                      {expandedHistoryRuns.has(index) && run.files && run.files.length > 0 && (
                        <div className="ap-history-run-details">
                          <table className="ap-file-table">
                            <thead>
                              <tr>
                                <th>File Name</th>
                                <th>Module</th>
                                <th>Entity</th>
                                <th>Source</th>
                                <th>Status</th>
                                <th>Rows</th>
                                <th>Error</th>
                              </tr>
                            </thead>
                            <tbody>
                              {run.files.map((f, fi) => (
                                <tr key={fi} className={f.status === 'failed' ? 'ap-history-file-failed' : ''}>
                                  <td><span className="ap-file-name">{f.filename}</span></td>
                                  <td>
                                    {f.module ? (
                                      <span className={`ap-module-badge ${f.module.toLowerCase()}`}>{f.module}</span>
                                    ) : <span style={{ color: '#999' }}>-</span>}
                                  </td>
                                  <td>
                                    <span className="ap-type-badge">{f.entityDisplay || f.entity || f.type || 'Unknown'}</span>
                                  </td>
                                  <td>
                                    {f.source ? (
                                      <span className={`ap-source-badge ${f.source.toLowerCase()}`}>{f.source}</span>
                                    ) : <span style={{ color: '#999' }}>-</span>}
                                  </td>
                                  <td>
                                    <span className={`ap-status-badge ${f.status}`}>
                                      <span className={`ap-status-dot ${f.status}`}></span>
                                      {f.status.charAt(0).toUpperCase() + f.status.slice(1)}
                                    </span>
                                  </td>
                                  <td>
                                    <span className="ap-row-count">{f.rowCount ? formatNumber(f.rowCount) : '-'}</span>
                                  </td>
                                  <td>
                                    {f.error ? (
                                      <span className="ap-history-error-text" title={f.error}>
                                        {f.error.length > 60 ? f.error.substring(0, 60) + '...' : f.error}
                                      </span>
                                    ) : <span style={{ color: '#999' }}>-</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="ap-empty-state">
              <div className="ap-empty-icon">&#128451;</div>
              <h3>No files found</h3>
              <p>
                {activeTab === 'pending'
                  ? 'Upload data files (CSV/XLSX) to the InputFilesForProcessing folder to get started.'
                  : 'No files match the current filters.'}
              </p>
            </div>
          ) : (
            <table className="ap-file-table">
              <thead>
                <tr>
                  <th style={{ width: '30px' }}></th>
                  <th>File Name</th>
                  <th>Module</th>
                  <th>Entity</th>
                  <th>Source</th>
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
                        {file.parsed.module ? (
                          <span className={`ap-module-badge ${file.parsed.module.toLowerCase()}`}>
                            {file.parsed.module}
                          </span>
                        ) : (
                          <span style={{ color: '#999' }}>-</span>
                        )}
                      </td>
                      <td>
                        <span className="ap-type-badge">
                          {file.parsed.entityDisplay || 'Unknown'}
                        </span>
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
                        <td colSpan={10}>
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

export default withAuthenticator(DataFileDashboard);
