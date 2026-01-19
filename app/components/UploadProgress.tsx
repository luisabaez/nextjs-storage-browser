'use client';
import React from 'react';

export interface UploadItem {
  id: string;
  fileName: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
  size: number;
}

interface UploadProgressProps {
  uploads: UploadItem[];
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onDismissAll?: () => void;
}

export function UploadProgress({
  uploads,
  onCancel,
  onRetry,
  onDismiss,
  onDismissAll,
}: UploadProgressProps) {
  if (uploads.length === 0) return null;

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const completedCount = uploads.filter(u => u.status === 'completed').length;
  const uploadingCount = uploads.filter(u => u.status === 'uploading').length;
  const errorCount = uploads.filter(u => u.status === 'error').length;

  const getStatusIcon = (status: UploadItem['status']) => {
    switch (status) {
      case 'completed': return '✓';
      case 'error': return '✕';
      case 'uploading': return '⟳';
      default: return '○';
    }
  };

  return (
    <div className="upload-progress-panel">
      <div className="upload-progress-header">
        <h4>
          Uploads
          {uploadingCount > 0 && <span className="uploading-count"> ({uploadingCount} in progress)</span>}
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
        {uploads.map(upload => (
          <div key={upload.id} className={`upload-item upload-${upload.status}`}>
            <div className="upload-item-icon">{getStatusIcon(upload.status)}</div>
            <div className="upload-item-details">
              <div className="upload-item-name">{upload.fileName}</div>
              <div className="upload-item-meta">
                <span className="upload-item-size">{formatSize(upload.size)}</span>
                {upload.status === 'uploading' && (
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
        ))}
      </div>
    </div>
  );
}
