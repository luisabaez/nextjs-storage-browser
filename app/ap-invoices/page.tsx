'use client';

import { Amplify } from 'aws-amplify';
import { list, getUrl, remove, copy, uploadData } from 'aws-amplify/storage';
import { withAuthenticator } from '@aws-amplify/ui-react';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
  timedOut?: boolean;
  continuing?: boolean;
  continuationRun?: number;
  pendingFiles?: number;
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
  triggeredBy?: string;
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
  // HCM (35)
  HCM_ACCRUAL_DETAIL: { module: 'HCM', displayName: 'Accrual Detail', legacy: false },
  HCM_ASSIGNMENT_EIT_KRONOS: { module: 'HCM', displayName: 'Assignment EIT Kronos', legacy: false },
  HCM_CONTRACT_SUPERVISOR: { module: 'HCM', displayName: 'Contract Supervisor', legacy: false },
  HCM_COST_ALLOCATION: { module: 'HCM', displayName: 'Cost Allocation', legacy: false },
  HCM_COURSES: { module: 'HCM', displayName: 'Courses', legacy: false },
  HCM_DEPARTMENT: { module: 'HCM', displayName: 'Department', legacy: false },
  HCM_ELEMENT_ENTRY_COSTING: { module: 'HCM', displayName: 'Element Entry Costing', legacy: false },
  HCM_ELEMENT_ENTRY: { module: 'HCM', displayName: 'Element Entry', legacy: false },
  HCM_EXTERNAL_BANK_ACCOUNT: { module: 'HCM', displayName: 'External Bank Account', legacy: false },
  HCM_FEDERAL_TAX: { module: 'HCM', displayName: 'Federal Tax', legacy: false },
  HCM_GRADE_RATE_VALUE: { module: 'HCM', displayName: 'Grade Rate Value', legacy: false },
  HCM_GRADE: { module: 'HCM', displayName: 'Grade', legacy: false },
  HCM_INVOLUNTARY_DEDUCTIONS: { module: 'HCM', displayName: 'Involuntary Deductions', legacy: false },
  HCM_JOB_GRADE: { module: 'HCM', displayName: 'Job Grade', legacy: false },
  HCM_JOBS: { module: 'HCM', displayName: 'Jobs', legacy: false },
  HCM_LEARNING_RECORD: { module: 'HCM', displayName: 'Learning Record', legacy: false },
  HCM_LOCATION: { module: 'HCM', displayName: 'Location', legacy: false },
  HCM_PAYROLL_RELATIONSHIP: { module: 'HCM', displayName: 'Payroll Relationship', legacy: false },
  HCM_PERSONAL_PAYMENT_METHOD: { module: 'HCM', displayName: 'Personal Payment Method', legacy: false },
  HCM_PERSON_ADDRESS: { module: 'HCM', displayName: 'Person Address', legacy: false },
  HCM_PERSON_ASSIGNMENT: { module: 'HCM', displayName: 'Person Assignment', legacy: false },
  HCM_PERSON_EMAIL: { module: 'HCM', displayName: 'Person Email', legacy: false },
  HCM_PERSON_LEGISLATIVE: { module: 'HCM', displayName: 'Person Legislative', legacy: false },
  HCM_PERSON_NAME: { module: 'HCM', displayName: 'Person Name', legacy: false },
  HCM_PERSON_NID: { module: 'HCM', displayName: 'Person NID', legacy: false },
  HCM_PERSON_PHONE: { module: 'HCM', displayName: 'Person Phone', legacy: false },
  HCM_PERSON_SUPERVISOR: { module: 'HCM', displayName: 'Person Supervisor', legacy: false },
  HCM_PERSON: { module: 'HCM', displayName: 'Person', legacy: false },
  HCM_POSITION_GRADE: { module: 'HCM', displayName: 'Position Grade', legacy: false },
  HCM_POSITION_HIERARCHY: { module: 'HCM', displayName: 'Position Hierarchy', legacy: false },
  HCM_POSITION: { module: 'HCM', displayName: 'Position', legacy: false },
  HCM_SALARY: { module: 'HCM', displayName: 'Salary', legacy: false },
  HCM_SENIORITY: { module: 'HCM', displayName: 'Seniority', legacy: false },
  HCM_STATE_TAX: { module: 'HCM', displayName: 'State Tax', legacy: false },
  HCM_WORK_SCHEDULE: { module: 'HCM', displayName: 'Work Schedule', legacy: false },
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
  '015', '034', '911', 'ADPPOLICIA', 'ASG', 'ASSMCA', 'DOE', 'FIMAS',
  'HACIENDA', 'KRONOSPOL', 'KRONOSPOL_PHASE2', 'PRIFAS', 'RETIRO', 'RHUM',
  'SALUD', 'SIFDE', 'SURI',
];

const S3_FOLDERS = {
  input: 'InputFilesForProcessing/',
  processed: 'ProcessedFiles/',
  failed: 'FailedInvoices/',
  unmatched: 'FailedUnmatchedFilenames/',
};

type TabId = 'all' | 'pending' | 'uploaded' | 'failed' | 'history' | 'gantt';

interface GanttEntityGroup {
  module: string;
  entityDisplay: string;
  entityPrefix: string;
  source: string;
  files: APFile[];
}

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

  // Extract remainder: _MOCK{N}[PRE]_{SOURCE}[_{DATE}[_{TIME}]].ext
  const remainder = name.substring(matchedPrefix.length);
  const extEsc = (base.extension === 'csv' ? '.csv' : '.xlsx').replace('.', '\\.');

  // Pattern 1: Standard — _MOCK{N}_{SOURCE}_{YYYYMMDD}_{HHMM}.ext
  let m = remainder.match(new RegExp(`^_(MOCK\\d+(?:PRE)?)_([A-Z0-9_]+)_(\\d{8})_(\\d{4})${extEsc}$`, 'i'));
  if (m) {
    base.mockNumber = m[1].toUpperCase();
    base.source = m[2].toUpperCase();
    base.dateStr = m[3];
    base.timeStr = m[4];
    base.valid = true;
    return base;
  }

  // Pattern 2: Dashed date — _MOCK{N}_{SOURCE}_{YYYY-MM-DD}.ext
  m = remainder.match(new RegExp(`^_(MOCK\\d+(?:PRE)?)_([A-Z0-9_]+)_(\\d{4}-\\d{2}-\\d{2})${extEsc}$`, 'i'));
  if (m) {
    base.mockNumber = m[1].toUpperCase();
    base.source = m[2].toUpperCase();
    base.dateStr = m[3].replace(/-/g, '');
    base.timeStr = '0000';
    base.valid = true;
    return base;
  }

  // Pattern 3: YYYYMMDD without time — _MOCK{N}_{SOURCE}_{YYYYMMDD}.ext
  m = remainder.match(new RegExp(`^_(MOCK\\d+(?:PRE)?)_([A-Z0-9_]+?)_(\\d{8})${extEsc}$`, 'i'));
  if (m) {
    base.mockNumber = m[1].toUpperCase();
    base.source = m[2].toUpperCase();
    base.dateStr = m[3];
    base.timeStr = '0000';
    base.valid = true;
    return base;
  }

  // Pattern 4: Underscored YYYY_MM_DD — _MOCK{N}_{SOURCE}_{YYYY}_{MM}_{DD}.ext
  m = remainder.match(new RegExp(`^_(MOCK\\d+(?:PRE)?)_(.+?)_(\\d{4})_(\\d{2})_(\\d{2})${extEsc}$`, 'i'));
  if (m) {
    base.mockNumber = m[1].toUpperCase();
    base.source = m[2].toUpperCase();
    base.dateStr = m[3] + m[4] + m[5];
    base.timeStr = '0000';
    base.valid = true;
    return base;
  }

  // Pattern 5: US date MM_DD_YYYY — _MOCK{N}_{SOURCE}_{MM}_{DD}_{YYYY}.ext
  m = remainder.match(new RegExp(`^_(MOCK\\d+(?:PRE)?)_(.+?)_(\\d{2})_(\\d{2})_(\\d{4})${extEsc}$`, 'i'));
  if (m) {
    base.mockNumber = m[1].toUpperCase();
    base.source = m[2].toUpperCase();
    base.dateStr = m[5] + m[3] + m[4]; // → YYYYMMDD
    base.timeStr = '0000';
    base.valid = true;
    return base;
  }

  // Pattern 6: No date — _MOCK{N}_{SOURCE}.ext
  m = remainder.match(new RegExp(`^_(MOCK\\d+(?:PRE)?)_([A-Z0-9_]+)${extEsc}$`, 'i'));
  if (m) {
    base.mockNumber = m[1].toUpperCase();
    base.source = m[2].toUpperCase();
    base.dateStr = '00000000';
    base.timeStr = '0000';
    base.valid = true;
    return base;
  }

  base.error = `Invalid filename structure after entity prefix '${matchedPrefix}'`;
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
  const [userEmail, setUserEmail] = useState<string>('');
  const [showUploadZone, setShowUploadZone] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<{id: string; name: string; size: number; progress: number; status: 'pending' | 'uploading' | 'completed' | 'error'}[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedGanttFile, setSelectedGanttFile] = useState<APFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch current user email for "triggered by" tracking
  useEffect(() => {
    fetchUserAttributes().then(attrs => {
      setUserEmail(attrs.email || '');
    }).catch(() => {});
  }, []);

  // Track when our current processing run started — used to detect stale S3 status
  // from a previous Lambda invocation that hasn't been overwritten yet.
  const processingStartRef = useRef<string | null>(null);

  // Hard grace period: ignore ALL S3 status reads until this timestamp.
  // Gives the Lambda time to overwrite the old status file with the new run.
  const statusGraceUntilRef = useRef<number>(0);

  // Prevent loadFiles from overwriting the file list during active processing.
  const processingLockedRef = useRef<boolean>(false);

  // ─── Derived filter options ──────────────────────────────────────────────

  const entityOptions = useMemo(() => {
    const prefixes = filterModule === 'all'
      ? Object.keys(ENTITY_REGISTRY)
      : Object.keys(ENTITY_REGISTRY).filter(p => ENTITY_REGISTRY[p].module === filterModule);
    return prefixes.sort((a, b) =>
      ENTITY_REGISTRY[a].displayName.localeCompare(ENTITY_REGISTRY[b].displayName)
    );
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

  const loadFiles = useCallback(async (inputOnly = false) => {
    // Don't overwrite the file list while processing is active — we've
    // intentionally trimmed it to just the current batch.
    if (processingLockedRef.current) {
      console.log('loadFiles skipped — processing is locked');
      return;
    }

    try {
      const allFiles: APFile[] = [];

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

      if (inputOnly) {
        // Refresh/Reset mode: only load input folder files
        const inputResult = await list({ path: S3_FOLDERS.input }).catch(() => ({ items: [] }));
        processItems(inputResult.items || [], 'input', 'pending');
      } else {
        // Full load: all folders in parallel
        const [inputResult, processedResult, failedResult, unmatchedResult] = await Promise.all([
          list({ path: S3_FOLDERS.input }).catch(() => ({ items: [] })),
          list({ path: S3_FOLDERS.processed }).catch(() => ({ items: [] })),
          list({ path: S3_FOLDERS.failed }).catch(() => ({ items: [] })),
          list({ path: S3_FOLDERS.unmatched }).catch(() => ({ items: [] })),
        ]);
        processItems(inputResult.items || [], 'input', 'pending');
        processItems(processedResult.items || [], 'processed', 'success');
        processItems(failedResult.items || [], 'failed', 'failed');
        processItems(unmatchedResult.items || [], 'unmatched', 'failed');
      }

      // Load last processing status to get row counts (only when not input-only)
      if (!inputOnly) {
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
      }

      setFiles(allFiles);
      // Clear any stale processing status on refresh
      if (inputOnly) {
        setProcessingStatus(null);
      }
    } catch (err) {
      console.error('Error loading files:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles(true);  // Initial load: input folder only for fast startup
  }, [loadFiles]);

  // ─── Check for active processing status ──────────────────────────────────

  const LAMBDA_MAX_RUNTIME_MS = 16 * 60 * 1000; // 16 min (Lambda max is 15 min + buffer)

  const checkProcessingStatus = useCallback(async () => {
    try {
      const statusUrl = await getUrl({ path: S3_FOLDERS.input + '_processing_status.json' });
      if (statusUrl?.url) {
        const resp = await fetch(statusUrl.url.toString());
        if (resp.ok) {
          const status: ProcessingStatus = await resp.json();

          // Detect stale "processing" status — Lambda hard-timed-out without cleanup
          if (status.status === 'processing' && status.startedAt) {
            const elapsed = Date.now() - new Date(status.startedAt).getTime();
            if (elapsed > LAMBDA_MAX_RUNTIME_MS) {
              console.warn(
                `Processing status stale (${Math.round(elapsed / 60000)}min old). ` +
                `Lambda likely timed out. Marking as complete.`
              );
              // Mark any "processing" files as failed (they were mid-flight)
              status.files = status.files.map(f => {
                if (f.status === 'processing') {
                  return { ...f, status: 'failed', error: 'Lambda timed out mid-processing' };
                }
                return f;
              });
              status.status = 'complete';
              status.completedAt = new Date().toISOString();
              status.timedOut = true;
              status.pendingFiles = status.files.filter(f => f.status === 'pending').length;
            }
          }

          // ── Grace period: ignore ALL S3 status during the first N seconds ──
          // When the user clicks "Run Processing", we set an optimistic local
          // status.  The Lambda takes a few seconds to overwrite the old S3
          // status file.  During this window, S3 still has the OLD status
          // from a previous run.  We hard-skip all reads until the grace
          // period expires.
          if (Date.now() < statusGraceUntilRef.current) {
            console.log('Skipping S3 status — grace period active');
            return null;
          }

          // ── Stale timestamp check ──
          if (processingStartRef.current && status.startedAt) {
            const ourStart = new Date(processingStartRef.current).getTime();
            const s3Start = new Date(status.startedAt).getTime();
            if (s3Start < ourStart - 10000) {
              console.log(
                `Skipping stale S3 status (startedAt=${status.startedAt}) — ` +
                `our run started at ${processingStartRef.current}`
              );
              return null;
            }
          }

          // ── Premature completion check ──
          // Don't accept "complete" or "error" within the first 2 min of our
          // run — the Lambda can't finish 100+ files that fast, so any such
          // status is leftover from a previous run.
          if (processingStartRef.current) {
            const elapsedSinceWeStarted = Date.now() - new Date(processingStartRef.current).getTime();
            if ((status.status === 'complete' || status.status === 'error') && elapsedSinceWeStarted < 120000) {
              console.log(
                `Skipping premature complete/error status (${Math.round(elapsedSinceWeStarted / 1000)}s since we started)`
              );
              return null;
            }
          }

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
            processingStartRef.current = null;  // Clear stale-check ref
            processingLockedRef.current = false; // Unlock file list
            // Reload input folder files only (not all 4 folders)
            setTimeout(() => loadFiles(true), 2000);
            // Reset history so next visit to History tab fetches the new run
            setHistoryLoaded(false);
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
      // Read history files directly from S3 via Amplify — bypasses the
      // Lambda URL entirely, avoiding VPC cold-start timeouts.
      // List the _processing_history/ subfolder directly.
      const historyPath = S3_FOLDERS.input + '_processing_history/';
      const historyItems = await list({ path: historyPath });
      const jsonFiles = (historyItems.items || [])
        .filter(item => item.path && item.path.endsWith('.json'))
        .sort((a, b) => b.path.localeCompare(a.path))  // Most recent first
        .slice(0, 50);

      console.log(`[History] Found ${jsonFiles.length} history files`);

      if (jsonFiles.length === 0) {
        setHistoryRuns([]);
        setHistoryLoaded(true);
        return;
      }

      // Fetch all history JSON files in parallel via presigned URLs
      const results = await Promise.allSettled(
        jsonFiles.map(async (item) => {
          const urlResult = await getUrl({ path: item.path });
          const resp = await fetch(urlResult.url.toString());
          if (resp.ok) return resp.json();
          throw new Error(`HTTP ${resp.status}`);
        })
      );

      const runs: HistoryRun[] = results
        .filter((r): r is PromiseFulfilledResult<HistoryRun> => r.status === 'fulfilled')
        .map(r => r.value);

      // Sort by completedAt or startedAt descending
      runs.sort((a, b) => {
        const dateA = a.completedAt || a.startedAt || '';
        const dateB = b.completedAt || b.startedAt || '';
        return dateB.localeCompare(dateA);
      });

      console.log(`[History] Loaded ${runs.length} history runs`);
      setHistoryRuns(runs);
      setHistoryLoaded(true);
    } catch (err) {
      console.warn('[History] Error loading history from S3:', err);
      // Will retry on next tab switch
    } finally {
      setHistoryLoading(false);
    }
  }, [historyLoaded]);

  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab, loadHistory]);

  // ─── Upload Files ────────────────────────────────────────────────────────

  const handleUploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const filesArray = Array.from(fileList);
    if (filesArray.length === 0) return;

    const newUploads = filesArray.map((file, idx) => ({
      id: `upload-${Date.now()}-${idx}`,
      name: file.name,
      size: file.size,
      progress: 0,
      status: 'pending' as const,
    }));

    setUploadFiles(prev => [...prev, ...newUploads]);
    setShowUploadZone(true);

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < filesArray.length; i++) {
      const file = filesArray[i];
      const uploadId = newUploads[i].id;
      const path = S3_FOLDERS.input + file.name;

      try {
        setUploadFiles(prev =>
          prev.map(u => u.id === uploadId ? { ...u, status: 'uploading' as const } : u)
        );

        await uploadData({
          path,
          data: file,
          options: {
            onProgress: ({ transferredBytes, totalBytes }) => {
              const progress = totalBytes ? Math.round((transferredBytes / totalBytes) * 100) : 0;
              setUploadFiles(prev =>
                prev.map(u => u.id === uploadId ? { ...u, progress } : u)
              );
            },
          },
        }).result;

        setUploadFiles(prev =>
          prev.map(u => u.id === uploadId ? { ...u, status: 'completed' as const, progress: 100 } : u)
        );
        successCount++;
      } catch (err) {
        console.error('Upload error:', err);
        setUploadFiles(prev =>
          prev.map(u => u.id === uploadId ? { ...u, status: 'error' as const } : u)
        );
        errorCount++;
      }
    }

    // Refresh file list after all uploads complete
    setTimeout(() => loadFiles(true), 1000);
  }, [loadFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleUploadFiles(e.dataTransfer.files);
    }
  }, [handleUploadFiles]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleUploadFiles(e.target.files);
      e.target.value = '';
    }
  }, [handleUploadFiles]);

  const uploadStats = useMemo(() => {
    const total = uploadFiles.length;
    const completed = uploadFiles.filter(u => u.status === 'completed').length;
    const errors = uploadFiles.filter(u => u.status === 'error').length;
    const uploading = uploadFiles.filter(u => u.status === 'uploading' || u.status === 'pending').length;
    const totalBytes = uploadFiles.reduce((sum, u) => sum + u.size, 0);
    return { total, completed, errors, uploading, totalBytes, allDone: uploading === 0 && total > 0 };
  }, [uploadFiles]);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // ─── Run Data File Processing ─────────────────────────────────────────────

  const handleRunProcessing = useCallback(async () => {
    if (isProcessing) return;

    // Apply active filters to determine which input files to process
    const hasFilters = filterModule !== 'all' || filterEntity !== 'all' || filterSource !== 'all' || filterMock !== 'all';
    let inputFiles = files.filter(f => f.folder === 'input');
    if (hasFilters) {
      if (filterModule !== 'all') inputFiles = inputFiles.filter(f => f.parsed.module === filterModule);
      if (filterEntity !== 'all') inputFiles = inputFiles.filter(f => f.parsed.entityPrefix === filterEntity);
      if (filterSource !== 'all') inputFiles = inputFiles.filter(f => f.parsed.source === filterSource);
      if (filterMock !== 'all') inputFiles = inputFiles.filter(f => f.parsed.mockNumber === filterMock);
    }

    if (inputFiles.length === 0) {
      alert('No files match the current filters to process.');
      return;
    }

    // Build filter description for confirmation
    const filterParts: string[] = [];
    if (filterModule !== 'all') filterParts.push(`Module: ${filterModule}`);
    if (filterEntity !== 'all') filterParts.push(`Entity: ${filterEntity}`);
    if (filterSource !== 'all') filterParts.push(`Source: ${filterSource}`);
    if (filterMock !== 'all') filterParts.push(`Mock: ${filterMock}`);
    const filterDesc = filterParts.length > 0
      ? `\n\nFilters applied:\n${filterParts.join('\n')}`
      : '\n\nNo filters — processing ALL input files.';

    if (!confirm(`Process ${inputFiles.length} file(s) in InputFilesForProcessing?\n\nThis will:\n- Validate each file\n- Load data into Hacienda_ERP_Test database\n- Move files to ProcessedFiles or FailedInvoices folders\n\nTarget tables will be truncated before loading.${filterDesc}`)) {
      return;
    }

    try {
      setIsProcessing(true);
      const startTime = new Date().toISOString();
      processingStartRef.current = startTime;

      // Hard grace period: ignore S3 status reads for 15 seconds so the
      // Lambda has time to overwrite the old status with the new run.
      statusGraceUntilRef.current = Date.now() + 15000;

      // Lock file list so loadFiles() can't overwrite during processing.
      processingLockedRef.current = true;

      // Clear the file list to only show current batch during processing
      setFiles(inputFiles);

      setProcessingStatus({
        status: 'processing',
        startedAt: startTime,
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

      // Fire-and-forget: invoke the Lambda but don't await the full response.
      // The Lambda may run for up to 15 minutes.  We rely on S3 status polling
      // (not the HTTP response) to track progress, so a network timeout here
      // should NOT stop polling or mark the run as errored.
      const params = new URLSearchParams({ action: 'process' });
      if (filterModule !== 'all') params.set('module', filterModule);
      if (filterEntity !== 'all') params.set('entity', filterEntity);
      if (filterSource !== 'all') params.set('source', filterSource);
      if (filterMock !== 'all') params.set('mock', filterMock);

      // Abort the fetch after 30s — we don't need the HTTP response since we
      // track progress via S3 status polling.  This prevents the browser from
      // holding the connection open for 15 min and showing "Failed to fetch".
      const controller = new AbortController();
      const abortTimeout = setTimeout(() => controller.abort(), 30000);

      fetch(`${LAMBDA_URL}?${params.toString()}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket: 'hacienda-erp-dev', triggeredBy: userEmail || 'unknown' }),
      }).then(response => {
        clearTimeout(abortTimeout);
        if (!response.ok) {
          console.warn(`Lambda returned ${response.status} — polling will continue via S3 status`);
        }
      }).catch(() => {
        clearTimeout(abortTimeout);
        // AbortError or network error — expected. Polling continues via S3.
      });
    } catch (err) {
      // Silently log — processing may still be running in Lambda.
      // S3 status polling will pick up progress regardless.
      console.warn('Error starting processing (suppressed):', err);
    }
  }, [isProcessing, files, filterModule, filterEntity, filterSource, filterMock, userEmail]);

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

  // ─── Gantt grouping ─────────────────────────────────────────────────────

  const ganttGroups = useMemo((): GanttEntityGroup[] => {
    // Apply same filters as filteredFiles but skip tab filter
    let result = [...files];
    if (filterModule !== 'all') result = result.filter(f => f.parsed.module === filterModule);
    if (filterEntity !== 'all') result = result.filter(f => f.parsed.entityPrefix === filterEntity);
    if (filterSource !== 'all') result = result.filter(f => f.parsed.source === filterSource);
    if (filterMock !== 'all') result = result.filter(f => f.parsed.mockNumber === filterMock);
    if (filterStatus !== 'all') result = result.filter(f => f.status === filterStatus);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(f => f.name.toLowerCase().includes(q));
    }

    // Group by entity + source
    const groupMap = new Map<string, GanttEntityGroup>();
    for (const file of result) {
      const key = `${file.parsed.entityPrefix}|${file.parsed.source}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          module: file.parsed.module,
          entityDisplay: file.parsed.entityDisplay || file.parsed.entityPrefix,
          entityPrefix: file.parsed.entityPrefix,
          source: file.parsed.source,
          files: [],
        });
      }
      groupMap.get(key)!.files.push(file);
    }

    // Sort files within each group by date, oldest first
    const groups = Array.from(groupMap.values());
    groups.forEach(group => {
      group.files.sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime());
    });

    // Sort groups by module then entity
    return groups.sort((a, b) => {
      if (a.module !== b.module) return a.module.localeCompare(b.module);
      return a.entityDisplay.localeCompare(b.entityDisplay);
    });
  }, [files, filterModule, filterEntity, filterSource, filterMock, filterStatus, searchQuery]);

  // Helper: get pillar name from module
  const getPillarName = (module: string) => {
    const map: Record<string, string> = { FIN: 'Finance', SCM: 'Supply Chain', HCM: 'Human Capital' };
    return map[module] || module;
  };

  // Helper: get lifecycle stage status for a file
  const getLifecycleStage = (file: APFile) => {
    // Initial Load: always present once we have the file
    const stages = {
      initialLoad: {
        status: file.status === 'failed' ? 'fail' : file.status === 'processing' ? 'processing' : 'pass',
        filename: file.name,
        timestamp: file.lastModified,
      },
      prevalidation: {
        // If file was successfully loaded, prevalidation passed
        status: file.status === 'success' ? 'pass' : file.status === 'processing' ? 'processing' : file.status === 'failed' ? 'fail' : 'pending',
        filename: file.name,
        timestamp: file.lastModified,
      },
      conversion: {
        // If file was loaded to DB, conversion is done
        status: file.folder === 'processed' ? 'pass' : file.status === 'processing' ? 'processing' : file.status === 'failed' ? 'fail' : 'pending',
        filename: file.name,
        timestamp: file.lastModified,
      },
      validation: {
        // Final validation — only pass if fully processed
        status: file.folder === 'processed' ? 'pass' : file.status === 'failed' ? 'fail' : 'pending',
        filename: file.name,
        timestamp: file.lastModified,
      },
    };
    return stages;
  };

  // Helper: format date for gantt cells
  const formatGanttDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      month: '2-digit', day: '2-digit', year: 'numeric',
    }) + ', ' + date.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  };

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
          <button className="ap-refresh-btn" onClick={() => { loadFiles(true); setActiveTab('all'); }} title="Reset dashboard to show only current input files">
            &#x21bb; Refresh
          </button>
          <button className="ap-refresh-btn ap-load-all-btn" onClick={() => { loadFiles(false); if (activeTab === 'history') { setHistoryLoaded(false); } }} title="Load all files from all folders">
            &#128193; Load All
          </button>
          <button className="ap-refresh-btn ap-upload-btn" onClick={() => setShowUploadZone(!showUploadZone)} title="Upload files to InputFilesForProcessing">
            &#128228; Upload
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

      {/* ── Upload Zone ── */}
      {showUploadZone && (
        <div className="ap-upload-zone-wrapper">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,.xlsx,.xls,.txt"
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
          <div
            className={`ap-upload-dropzone ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="ap-upload-dropzone-content">
              <span className="ap-upload-icon">&#128449;</span>
              <p><strong>Drag &amp; drop files here</strong> or click to browse</p>
              <p className="ap-upload-hint">CSV, XLSX, TXT files for InputFilesForProcessing</p>
            </div>
          </div>

          {/* ── Upload Progress Panel ── */}
          {uploadFiles.length > 0 && (
            <div className="ap-upload-progress">
              <div className="ap-upload-progress-header">
                <span className="ap-upload-progress-title">
                  {uploadStats.allDone ? (
                    <>Upload Complete: {uploadStats.completed} of {uploadStats.total} files{uploadStats.errors > 0 && `, ${uploadStats.errors} failed`}</>
                  ) : (
                    <>Uploading {uploadStats.completed + uploadStats.errors} of {uploadStats.total} files...</>
                  )}
                </span>
                <span className="ap-upload-progress-size">{formatFileSize(uploadStats.totalBytes)}</span>
                {uploadStats.allDone && (
                  <button className="ap-upload-dismiss-btn" onClick={() => { setUploadFiles([]); setShowUploadZone(false); }}>
                    Dismiss
                  </button>
                )}
              </div>
              <div className="ap-upload-progress-bar-wrapper">
                <div
                  className={`ap-upload-progress-bar ${uploadStats.allDone ? (uploadStats.errors > 0 ? 'has-errors' : 'complete') : 'active'}`}
                  style={{ width: `${uploadStats.total > 0 ? Math.round(((uploadStats.completed + uploadStats.errors) / uploadStats.total) * 100) : 0}%` }}
                ></div>
              </div>
              <div className="ap-upload-file-list">
                {uploadFiles.map(uf => (
                  <div key={uf.id} className={`ap-upload-file-item ${uf.status}`}>
                    <span className={`ap-status-dot ${uf.status === 'completed' ? 'success' : uf.status === 'error' ? 'failed' : uf.status === 'uploading' ? 'processing' : 'pending'}`}></span>
                    <span className="ap-upload-file-name">{uf.name}</span>
                    <span className="ap-upload-file-size">{formatFileSize(uf.size)}</span>
                    {uf.status === 'uploading' && <span className="ap-upload-file-pct">{uf.progress}%</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
        {processingStatus && processingStatus.status !== 'idle' && (() => {
          const pFiles = processingStatus.files || [];
          const currentFile = pFiles.find(f => f.status === 'processing');
          const successFiles = pFiles.filter(f => f.status === 'success');
          const failedFiles = pFiles.filter(f => f.status === 'failed');
          const pendingFiles = pFiles.filter(f => f.status === 'pending');
          const completedCount = successFiles.length + failedFiles.length;
          const total = processingStatus.totalFiles || pFiles.length;

          // Progress: completed files + half-credit for currently-processing file
          const progressPct = total > 0
            ? Math.min(100, ((completedCount + (currentFile ? 0.5 : 0)) / total) * 100)
            : 0;

          // Elapsed time
          let elapsedStr = '';
          if (processingStatus.startedAt) {
            const startMs = new Date(processingStatus.startedAt).getTime();
            const endMs = processingStatus.completedAt
              ? new Date(processingStatus.completedAt).getTime()
              : Date.now();
            const elapsedSec = Math.floor((endMs - startMs) / 1000);
            const mins = Math.floor(elapsedSec / 60);
            const secs = elapsedSec % 60;
            elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          }

          // Bar class
          const barClass = processingStatus.timedOut ? 'timed-out'
            : processingStatus.status === 'complete' && failedFiles.length > 0 ? 'has-errors'
            : processingStatus.status === 'processing' ? 'active' : '';

          return (
          <div className="ap-processing-panel">
            {/* ── Header ── */}
            <div className="ap-processing-header">
              <h3>
                {processingStatus.status === 'processing' && (
                  <><span className="ap-spinner"></span> Processing Files{processingStatus.continuationRun ? ` (run ${processingStatus.continuationRun + 1})` : ''}</>
                )}
                {processingStatus.status === 'complete' && (() => {
                  if (processingStatus.timedOut || pendingFiles.length > 0) {
                    return `Processing Timed Out \u2014 ${pendingFiles.length} file${pendingFiles.length !== 1 ? 's' : ''} not processed`;
                  }
                  if (failedFiles.length > 0 && successFiles.length > 0) {
                    return 'Processing Complete (with errors)';
                  }
                  if (failedFiles.length > 0 && successFiles.length === 0) {
                    return 'Processing Complete \u2014 All files failed';
                  }
                  return 'Processing Complete';
                })()}
                {processingStatus.status === 'error' && 'Processing Error'}
              </h3>
              <span className="ap-progress-text">
                {completedCount} of {total} files
                {successFiles.length > 0 && <span className="ap-stat success"><span className="ap-status-dot success"></span> {successFiles.length}</span>}
                {failedFiles.length > 0 && <span className="ap-stat failed"><span className="ap-status-dot failed"></span> {failedFiles.length}</span>}
                {pendingFiles.length > 0 && <span className="ap-stat pending"><span className="ap-status-dot pending"></span> {pendingFiles.length}</span>}
                {elapsedStr && <span className="ap-stat elapsed">{elapsedStr}</span>}
              </span>
            </div>

            {/* ── Progress bar ── */}
            <div className="ap-progress-bar-wrapper">
              <div className={`ap-progress-bar ${barClass}`} style={{ width: `${progressPct}%` }}></div>
            </div>

            {/* ── Currently processing callout ── */}
            {currentFile && (
              <div className="ap-current-file">
                <span className="ap-spinner"></span>
                <span className="ap-current-label">Now processing:</span>
                <strong>{currentFile.entityDisplay || currentFile.entity || currentFile.filename}</strong>
                {currentFile.source && <span className="ap-current-meta">{currentFile.source}</span>}
                <span className="ap-current-filename">{currentFile.filename}</span>
              </div>
            )}

            {/* ── Failed files (shown first if any) ── */}
            {failedFiles.length > 0 && (
              <div className="ap-file-section">
                <div className="ap-file-section-header error">
                  <span><span className="ap-status-dot failed"></span> Failed ({failedFiles.length})</span>
                </div>
                <ul className="ap-processing-files">
                  {failedFiles.map((f, i) => (
                    <li key={`fail-${i}`} className="ap-processing-file error">
                      <span className="ap-status-dot failed"></span>
                      {f.module && <span className={`ap-module-badge ${f.module.toLowerCase()}`}>{f.module}</span>}
                      <span className="ap-file-name">{f.filename}</span>
                      {f.error && (
                        <span className="ap-file-error" title={f.error}>
                          {f.error.length > 80 ? f.error.substring(0, 80) + '...' : f.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── Successful files ── */}
            {successFiles.length > 0 && (
              <div className="ap-file-section">
                <div className="ap-file-section-header success">
                  <span><span className="ap-status-dot success"></span> Succeeded ({successFiles.length})</span>
                </div>
                <ul className="ap-processing-files">
                  {successFiles.map((f, i) => (
                    <li key={`ok-${i}`} className="ap-processing-file done">
                      <span className="ap-status-dot success"></span>
                      {f.module && <span className={`ap-module-badge ${f.module.toLowerCase()}`}>{f.module}</span>}
                      <span className="ap-file-name">{f.filename}</span>
                      {f.rowCount > 0 && <span className="ap-row-count">{formatNumber(f.rowCount)} rows</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── Pending files ── */}
            {pendingFiles.length > 0 && (
              <div className="ap-file-section">
                <div className="ap-file-section-header pending">
                  <span><span className="ap-status-dot pending"></span> Pending ({pendingFiles.length})</span>
                </div>
                <ul className="ap-processing-files">
                  {pendingFiles.map((f, i) => (
                    <li key={`pend-${i}`} className="ap-processing-file">
                      <span className="ap-status-dot pending"></span>
                      {f.module && <span className={`ap-module-badge ${f.module.toLowerCase()}`}>{f.module}</span>}
                      <span className="ap-file-name">{f.filename}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          );
        })()}

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
              { id: 'gantt' as TabId, label: 'Gantt View', count: null },
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
                {tab.count !== null && <span className="ap-tab-count">{tab.count}</span>}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {activeTab === 'gantt' ? (
            <div className="ap-gantt-content">
              {ganttGroups.length === 0 ? (
                <div className="ap-empty-state">
                  <div className="ap-empty-icon">&#128202;</div>
                  <h3>No files to display</h3>
                  <p>Upload and process files to see the lifecycle Gantt view.</p>
                </div>
              ) : (
                <div className="ap-gantt-table-wrapper">
                  <table className="ap-gantt-table">
                    <thead>
                      <tr>
                        <th className="ap-gantt-entity-col">Pillar / Data Entity / Source / Sub-Entity</th>
                        <th className="ap-gantt-stage-col">Initial Load</th>
                        <th className="ap-gantt-stage-col">Prevalidation</th>
                        <th className="ap-gantt-stage-col">Conversion</th>
                        <th className="ap-gantt-stage-col">Validation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ganttGroups.map((group) => {
                        const stages = group.files.map(f => getLifecycleStage(f));
                        return (
                          <tr key={`${group.entityPrefix}|${group.source}`} className="ap-gantt-row">
                            <td className="ap-gantt-entity-cell">
                              <div className="ap-gantt-entity-info">
                                <div className="ap-gantt-entity-breadcrumb">
                                  <span className={`ap-module-badge ${group.module.toLowerCase()}`}>{group.module}</span>
                                  <span className="ap-gantt-separator">&rsaquo;</span>
                                  <span className="ap-gantt-entity-name">{group.entityDisplay}</span>
                                </div>
                                <div className="ap-gantt-entity-meta">
                                  Source: {group.source}
                                </div>
                                <div className="ap-gantt-entity-meta">
                                  {group.files.length} file(s)
                                </div>
                              </div>
                            </td>
                            {/* Initial Load */}
                            <td className="ap-gantt-stage-cell">
                              {group.files.map((file, idx) => {
                                const stage = stages[idx].initialLoad;
                                return (
                                  <div key={file.key} className="ap-gantt-file-card">
                                    <span className={`ap-gantt-status-badge ${stage.status}`}>
                                      <span className={`ap-gantt-status-icon ${stage.status}`}></span>
                                      {stage.status === 'pass' ? 'Pass' : stage.status === 'fail' ? 'Fail' : stage.status === 'processing' ? 'Processing' : 'Pending'}
                                    </span>
                                    <div className="ap-gantt-file-name" title={file.name}>{file.name}</div>
                                    <div className="ap-gantt-file-date">{formatGanttDate(file.lastModified)}</div>
                                    <button className="ap-gantt-view-link" onClick={() => setSelectedGanttFile(file)}>
                                      View &#8599;
                                    </button>
                                  </div>
                                );
                              })}
                            </td>
                            {/* Prevalidation */}
                            <td className="ap-gantt-stage-cell">
                              {group.files.map((file, idx) => {
                                const stage = stages[idx].prevalidation;
                                return (
                                  <div key={file.key} className="ap-gantt-file-card">
                                    <span className={`ap-gantt-status-badge ${stage.status}`}>
                                      <span className={`ap-gantt-status-icon ${stage.status}`}></span>
                                      {stage.status === 'pass' ? 'Pass' : stage.status === 'fail' ? 'Fail' : stage.status === 'processing' ? 'Processing' : 'Pending'}
                                    </span>
                                    <div className="ap-gantt-file-name" title={file.name}>{file.name}</div>
                                    <div className="ap-gantt-file-date">{formatGanttDate(file.lastModified)}</div>
                                    <button className="ap-gantt-view-link" onClick={() => setSelectedGanttFile(file)}>
                                      View &#8599;
                                    </button>
                                  </div>
                                );
                              })}
                            </td>
                            {/* Conversion */}
                            <td className="ap-gantt-stage-cell">
                              {group.files.map((file, idx) => {
                                const stage = stages[idx].conversion;
                                return (
                                  <div key={file.key} className="ap-gantt-file-card">
                                    <span className={`ap-gantt-status-badge ${stage.status}`}>
                                      <span className={`ap-gantt-status-icon ${stage.status}`}></span>
                                      {stage.status === 'pass' ? 'Pass' : stage.status === 'fail' ? 'Fail' : stage.status === 'processing' ? 'Processing' : 'Pending'}
                                    </span>
                                    <div className="ap-gantt-file-name" title={file.name}>{file.name}</div>
                                    <div className="ap-gantt-file-date">{formatGanttDate(file.lastModified)}</div>
                                    <button className="ap-gantt-view-link" onClick={() => setSelectedGanttFile(file)}>
                                      View &#8599;
                                    </button>
                                  </div>
                                );
                              })}
                            </td>
                            {/* Validation */}
                            <td className="ap-gantt-stage-cell">
                              {group.files.map((file, idx) => {
                                const stage = stages[idx].validation;
                                return (
                                  <div key={file.key} className={`ap-gantt-file-card ${stage.status === 'fail' ? 'has-error' : ''}`}>
                                    <span className={`ap-gantt-status-badge ${stage.status}`}>
                                      <span className={`ap-gantt-status-icon ${stage.status}`}></span>
                                      {stage.status === 'pass' ? 'Pass' : stage.status === 'fail' ? 'Fail' : stage.status === 'processing' ? 'Processing' : 'Pending'}
                                    </span>
                                    <div className="ap-gantt-file-name" title={file.name}>{file.name}</div>
                                    <div className="ap-gantt-file-date">{formatGanttDate(file.lastModified)}</div>
                                    {file.status === 'failed' && file.errorMessage && (
                                      <div className="ap-gantt-error-msg">{file.errorMessage}</div>
                                    )}
                                    <button className="ap-gantt-view-link" onClick={() => setSelectedGanttFile(file)}>
                                      View &#8599;
                                    </button>
                                  </div>
                                );
                              })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : activeTab === 'history' ? (
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
                          {run.triggeredBy && (
                            <span className="ap-history-run-user">by {run.triggeredBy}</span>
                          )}
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

      {/* File Detail Overlay (Gantt View drill-down) */}
      {selectedGanttFile && (() => {
        const file = selectedGanttFile;
        const lifecycle = getLifecycleStage(file);
        const stageEntries = [
          { key: 'upload', label: 'Upload', sub: 'File received', status: lifecycle.initialLoad.status },
          { key: 'validation', label: 'Validation', sub: 'Format & header checks', status: lifecycle.prevalidation.status },
          { key: 'database', label: 'Database Upload', sub: 'Data insertion', status: lifecycle.conversion.status },
          { key: 'complete', label: 'Complete', sub: 'Successfully processed', status: lifecycle.validation.status },
        ];
        const folderLabel = file.folder === 'processed' ? 'Success' : file.folder === 'input' ? 'Pending' : 'Failed';
        const stageLabel = file.folder === 'processed' ? '4-Completed' : file.status === 'processing' ? '2-Processing' : file.folder === 'input' ? '1-Uploaded' : '3-Failed';
        const s3Path = `s3://hacienda-erp-dev/${file.key}`;

        return (
          <div className="ap-file-detail-overlay" onClick={() => setSelectedGanttFile(null)}>
            <div className="ap-file-detail-panel" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="ap-file-detail-header">
                <button className="ap-file-detail-back" onClick={() => setSelectedGanttFile(null)}>
                  &larr; Back to Dashboard
                </button>
                <div className="ap-file-detail-title-row">
                  <span className="ap-file-detail-icon">&#128196;</span>
                  <h2 className="ap-file-detail-title">{file.name}</h2>
                  <span className={`ap-gantt-status-badge ${file.status === 'success' ? 'pass' : file.status}`}>
                    {file.status === 'success' ? 'Uploaded' : file.status.charAt(0).toUpperCase() + file.status.slice(1)}
                  </span>
                </div>
                <div className="ap-file-detail-subtitle">
                  Uploaded {formatDate(file.lastModified)}
                  {file.size ? ` \u2022 ${(file.size / (1024 * 1024)).toFixed(2)} MB` : ''}
                </div>
              </div>

              {/* Metadata + Location cards */}
              <div className="ap-file-detail-cards">
                <div className="ap-file-detail-card">
                  <h3 className="ap-file-detail-card-title">
                    <span className="ap-file-detail-card-icon">&#128200;</span>
                    File Metadata
                  </h3>
                  <div className="ap-file-detail-field">
                    <span className="ap-file-detail-label">Pillar</span>
                    <span className={`ap-module-badge ${file.parsed.module.toLowerCase()}`}>{file.parsed.module}</span>
                  </div>
                  <div className="ap-file-detail-field">
                    <span className="ap-file-detail-label">Mock Number</span>
                    <strong>{file.parsed.mockNumber}</strong>
                  </div>
                  <div className="ap-file-detail-field">
                    <span className="ap-file-detail-label">Data Entity</span>
                    <strong>{file.parsed.entityDisplay || file.parsed.entityPrefix}</strong>
                  </div>
                  <div className="ap-file-detail-field">
                    <span className="ap-file-detail-label">Source</span>
                    <strong>{file.parsed.source}</strong>
                  </div>
                  {file.rowCount ? (
                    <div className="ap-file-detail-field">
                      <span className="ap-file-detail-label">Row Count</span>
                      <strong>{formatNumber(file.rowCount)}</strong>
                    </div>
                  ) : null}
                </div>

                <div className="ap-file-detail-card">
                  <h3 className="ap-file-detail-card-title">
                    <span className="ap-file-detail-card-icon">&#128193;</span>
                    Current Location
                  </h3>
                  <div className="ap-file-detail-field">
                    <span className="ap-file-detail-label">Folder Type</span>
                    <strong>{folderLabel}</strong>
                  </div>
                  <div className="ap-file-detail-field">
                    <span className="ap-file-detail-label">Stage</span>
                    <strong>{stageLabel}</strong>
                  </div>
                  <div className="ap-file-detail-field">
                    <span className="ap-file-detail-label">Full Path</span>
                    <code className="ap-file-detail-path">{s3Path}</code>
                  </div>
                </div>
              </div>

              {/* Process Flow */}
              <div className="ap-file-detail-card" style={{ marginTop: '16px' }}>
                <h3 className="ap-file-detail-card-title">Process Flow</h3>
                <div className="ap-process-flow">
                  {stageEntries.map((stage, idx) => (
                    <div key={stage.key} className="ap-process-flow-item">
                      {idx > 0 && <span className="ap-process-flow-arrow">&rarr;</span>}
                      <div className={`ap-process-flow-step ${stage.status}`}>
                        <div className={`ap-process-flow-circle ${stage.status}`}>
                          {stage.status === 'pass' ? '\u2713' : stage.status === 'fail' ? '\u2717' : stage.status === 'processing' ? '\u23F3' : '\u2022'}
                        </div>
                        <div className="ap-process-flow-label">{stage.label}</div>
                        <div className="ap-process-flow-sub">{stage.sub}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Event Timeline */}
              <div className="ap-file-detail-card" style={{ marginTop: '16px' }}>
                <h3 className="ap-file-detail-card-title">
                  <span className="ap-file-detail-card-icon">&#128336;</span>
                  Event Timeline
                </h3>
                <div className="ap-event-timeline">
                  <div className="ap-timeline-item">
                    <div className={`ap-timeline-dot ${lifecycle.initialLoad.status}`}></div>
                    <div className="ap-timeline-content">
                      <strong>{lifecycle.initialLoad.status === 'pass' ? 'File uploaded successfully' : lifecycle.initialLoad.status === 'fail' ? 'File upload failed' : 'File uploading...'}</strong>
                      <div className="ap-timeline-detail">{file.parsed.entityDisplay} file received</div>
                      <code className="ap-timeline-path">s3://hacienda-erp-dev/InputFilesForProcessing/</code>
                    </div>
                    <div className="ap-timeline-time">{formatDate(file.lastModified)}</div>
                  </div>

                  {lifecycle.prevalidation.status !== 'pending' && (
                    <div className="ap-timeline-item">
                      <div className={`ap-timeline-dot ${lifecycle.prevalidation.status}`}></div>
                      <div className="ap-timeline-content">
                        <strong>{lifecycle.prevalidation.status === 'pass' ? 'Prevalidation passed' : lifecycle.prevalidation.status === 'fail' ? 'Prevalidation failed' : 'Validating...'}</strong>
                        <div className="ap-timeline-detail">{file.parsed.entityDisplay} data validated</div>
                      </div>
                      <div className="ap-timeline-time">{formatDate(file.lastModified)}</div>
                    </div>
                  )}

                  {lifecycle.conversion.status !== 'pending' && (
                    <div className="ap-timeline-item">
                      <div className={`ap-timeline-dot ${lifecycle.conversion.status}`}></div>
                      <div className="ap-timeline-content">
                        <strong>{lifecycle.conversion.status === 'pass' ? 'Database upload complete' : lifecycle.conversion.status === 'fail' ? 'Database upload failed' : 'Converting...'}</strong>
                        <div className="ap-timeline-detail">Converting {file.parsed.entityDisplay} records</div>
                        {file.rowCount ? <div className="ap-timeline-detail">{formatNumber(file.rowCount)} rows inserted</div> : null}
                      </div>
                      <div className="ap-timeline-time">{formatDate(file.lastModified)}</div>
                    </div>
                  )}

                  {lifecycle.validation.status !== 'pending' && (
                    <div className="ap-timeline-item">
                      <div className={`ap-timeline-dot ${lifecycle.validation.status}`}></div>
                      <div className="ap-timeline-content">
                        <strong>{lifecycle.validation.status === 'pass' ? 'Validation completed' : 'Validation failed'}</strong>
                        <div className="ap-timeline-detail">
                          {lifecycle.validation.status === 'pass'
                            ? `${file.rowCount ? formatNumber(file.rowCount) + ' ' : ''}records validated successfully`
                            : file.errorMessage || 'Validation errors detected'}
                        </div>
                        {file.folder === 'processed' && (
                          <code className="ap-timeline-path">s3://hacienda-erp-dev/{file.key}</code>
                        )}
                      </div>
                      <div className="ap-timeline-time">{formatDate(file.lastModified)}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Error details if failed */}
              {file.status === 'failed' && file.errorMessage && (
                <div className="ap-file-detail-card ap-file-detail-error-card" style={{ marginTop: '16px' }}>
                  <h3 className="ap-file-detail-card-title">Error Details</h3>
                  <div className="ap-file-detail-error-msg">{file.errorMessage}</div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default withAuthenticator(DataFileDashboard);
