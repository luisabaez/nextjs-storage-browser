'use client';
import React from 'react';

interface ToolbarProps {
  selectedCount: number;
  onUpload: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onMoveTo: () => void;
  onCopyTo: () => void;
  onRefresh: () => void;
  onCreateFolder: () => void;
  isProcessing?: boolean;
}

export function Toolbar({
  selectedCount,
  onUpload,
  onDownload,
  onDelete,
  onMoveTo,
  onCopyTo,
  onRefresh,
  onCreateFolder,
  isProcessing = false,
}: ToolbarProps) {
  const hasSelection = selectedCount > 0;

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {/* Always visible actions */}
        <button
          className="toolbar-btn primary"
          onClick={onUpload}
          disabled={isProcessing}
          title="Upload files"
        >
          <span className="toolbar-icon">📤</span>
          <span className="toolbar-label">Upload</span>
        </button>

        <button
          className="toolbar-btn"
          onClick={onCreateFolder}
          disabled={isProcessing}
          title="Create new folder"
        >
          <span className="toolbar-icon">📁</span>
          <span className="toolbar-label">New Folder</span>
        </button>

        <div className="toolbar-divider" />

        {/* Selection-dependent actions */}
        <button
          className="toolbar-btn"
          onClick={onDownload}
          disabled={!hasSelection || isProcessing}
          title={hasSelection ? `Download ${selectedCount} item(s)` : 'Select items to download'}
        >
          <span className="toolbar-icon">⬇️</span>
          <span className="toolbar-label">Download</span>
        </button>

        <button
          className="toolbar-btn"
          onClick={onMoveTo}
          disabled={!hasSelection || isProcessing}
          title={hasSelection ? `Move ${selectedCount} item(s)` : 'Select items to move'}
        >
          <span className="toolbar-icon">📁</span>
          <span className="toolbar-label">Move to</span>
        </button>

        <button
          className="toolbar-btn"
          onClick={onCopyTo}
          disabled={!hasSelection || isProcessing}
          title={hasSelection ? `Copy ${selectedCount} item(s)` : 'Select items to copy'}
        >
          <span className="toolbar-icon">📋</span>
          <span className="toolbar-label">Copy to</span>
        </button>

        <button
          className="toolbar-btn danger"
          onClick={onDelete}
          disabled={!hasSelection || isProcessing}
          title={hasSelection ? `Delete ${selectedCount} item(s)` : 'Select items to delete'}
        >
          <span className="toolbar-icon">🗑️</span>
          <span className="toolbar-label">Delete</span>
        </button>
      </div>

      <div className="toolbar-right">
        {hasSelection && (
          <span className="toolbar-selection-count">
            {selectedCount} item{selectedCount !== 1 ? 's' : ''} selected
          </span>
        )}

        <button
          className="toolbar-btn icon-only"
          onClick={onRefresh}
          disabled={isProcessing}
          title="Refresh"
        >
          <span className="toolbar-icon">🔄</span>
        </button>
      </div>
    </div>
  );
}
