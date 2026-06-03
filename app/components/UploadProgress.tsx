'use client';
import React from 'react';

/**
 * The operations panel tracks any long-running file action (upload, download,
 * move, copy, delete, rename) so the user can navigate freely while the work
 * finishes. The type discriminator drives the icon and the in-progress label.
 *
 * The interface is still called UploadItem (rather than OperationItem) to
 * keep churn down across the existing consumers — the file was originally
 * upload-only and the styling classes share the `upload-` prefix.
 */
export type OperationType = 'upload' | 'download' | 'move' | 'copy' | 'delete' | 'rename';

export interface UploadItem {
  id: string;
  /** Defaults to 'upload' for backward compatibility. */
  type?: OperationType;
  fileName: string;
  /** 0–100. For bulk operations, derive from current/total. */
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
  size: number;
  /** For bulk operations (e.g. folder move): how many items have finished. */
  current?: number;
  /** For bulk operations: total item count. */
  total?: number;
}

interface UploadProgressProps {
  uploads: UploadItem[];
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onDismissAll?: () => void;
}

const TYPE_ICON: Record<OperationType, string> = {
  upload: '⬆',
  download: '⬇',
  move: '↪',
  copy: '⎘',
  delete: '🗑',
  rename: '✎',
};

const IN_PROGRESS_LABEL: Record<OperationType, string> = {
  upload: 'Uploading',
  download: 'Downloading',
  move: 'Moving',
  copy: 'Copying',
  delete: 'Deleting',
  rename: 'Renaming',
};

const PLURAL_HEADER: Record<OperationType, string> = {
  upload: 'Uploads',
  download: 'Downloads',
  move: 'Moves',
  copy: 'Copies',
  delete: 'Deletions',
  rename: 'Renames',
};

export function UploadProgress({
  uploads,
  onCancel,
  onRetry,
  onDismiss,
  onDismissAll,
}: UploadProgressProps) {
  if (uploads.length === 0) return null;

  const formatSize = (bytes: number) => {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const completedCount = uploads.filter(u => u.status === 'completed').length;
  const inProgressCount = uploads.filter(u => u.status === 'uploading').length;

  // Pick a header label: if every operation in the panel is the same type,
  // use that type's name; otherwise fall back to a generic "Operations".
  const types = new Set(uploads.map(u => u.type || 'upload'));
  const headerLabel =
    types.size === 1 ? PLURAL_HEADER[Array.from(types)[0] as OperationType] : 'Operations';

  const getTypeIcon = (type?: OperationType) => TYPE_ICON[type || 'upload'];

  const getStatusIcon = (status: UploadItem['status']) => {
    switch (status) {
      case 'completed':
        return '✓';
      case 'error':
        return '✕';
      case 'uploading':
        return '⟳';
      default:
        return '○';
    }
  };

  return (
    <div className="upload-progress-panel">
      <div className="upload-progress-header">
        <h4>
          {headerLabel}
          {inProgressCount > 0 && (
            <span className="uploading-count"> ({inProgressCount} in progress)</span>
          )}
        </h4>
        <div className="upload-progress-actions">
          {completedCount === uploads.length && onDismissAll && (
            <button className="upload-dismiss-all" onClick={onDismissAll}>
              Dismiss All
            </button>
          )}
        </div>
      </div>
      <div className="upload-progress-list">
        {uploads.map(upload => {
          const type = upload.type || 'upload';
          const showBulkCount =
            upload.status === 'uploading' && upload.total !== undefined && upload.total > 1;
          return (
            <div key={upload.id} className={`upload-item upload-${upload.status}`}>
              <div className="upload-item-icon" title={IN_PROGRESS_LABEL[type]}>
                {getStatusIcon(upload.status)}
              </div>
              <div className="upload-item-details">
                <div className="upload-item-name">
                  <span style={{ marginRight: 6 }} aria-hidden>
                    {getTypeIcon(type)}
                  </span>
                  {upload.fileName}
                </div>
                <div className="upload-item-meta">
                  {upload.size > 0 && (
                    <span className="upload-item-size">{formatSize(upload.size)}</span>
                  )}
                  {showBulkCount && (
                    <span className="upload-item-percent">
                      {upload.current ?? 0} of {upload.total} ({upload.progress}%)
                    </span>
                  )}
                  {upload.status === 'uploading' && !showBulkCount && (
                    <span className="upload-item-percent">{upload.progress}%</span>
                  )}
                  {upload.status === 'error' && upload.error && (
                    <span className="upload-item-error">{upload.error}</span>
                  )}
                </div>
                {upload.status === 'uploading' && (
                  <div className="upload-item-progress">
                    <div
                      className="upload-item-progress-bar"
                      style={{ width: `${upload.progress}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="upload-item-actions">
                {upload.status === 'uploading' && onCancel && (
                  <button
                    className="upload-action-btn cancel"
                    onClick={() => onCancel(upload.id)}
                    title="Cancel"
                  >
                    ✕
                  </button>
                )}
                {upload.status === 'error' && onRetry && (
                  <button
                    className="upload-action-btn retry"
                    onClick={() => onRetry(upload.id)}
                    title="Retry"
                  >
                    ↻
                  </button>
                )}
                {(upload.status === 'completed' || upload.status === 'error') && onDismiss && (
                  <button
                    className="upload-action-btn dismiss"
                    onClick={() => onDismiss(upload.id)}
                    title="Dismiss"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
