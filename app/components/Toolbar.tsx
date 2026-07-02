'use client';
import React, { useState, useEffect, useRef } from 'react';

export type SortOption = 'name-asc' | 'name-desc' | 'date-newest' | 'date-oldest';
export type SearchScope = 'current' | 'all';

// Human-readable byte size, e.g. 500 B, 1.5 KB, 5 MB, 2.1 GB.
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const rounded = i === 0 || n >= 100 || Number.isInteger(n) ? Math.round(n) : Number(n.toFixed(1));
  return `${rounded} ${units[i]}`;
}

interface ToolbarProps {
  selectedCount: number;
  selectedBytes?: number;       // total size of selected files (folders excluded)
  selectedFolderCount?: number; // how many of the selection are folders
  onUpload: () => void;
  onDownload: () => void;
  // Phase 7: explicit "always zip" option from the dropdown next to Download
  onDownloadAsZip?: () => void;
  onDelete: () => void;
  onMoveTo: () => void;
  onCopyTo: () => void;
  onRefresh: () => void;
  onCreateFolder: () => void;
  isProcessing?: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortOption: SortOption;
  onSortChange: (option: SortOption) => void;
  searchScope: SearchScope;
  onSearchScopeChange: (scope: SearchScope) => void;
  currentFolderName: string;
}

export function Toolbar({
  selectedCount,
  selectedBytes = 0,
  selectedFolderCount = 0,
  onUpload,
  onDownload,
  onDownloadAsZip,
  onDelete,
  onMoveTo,
  onCopyTo,
  onRefresh,
  onCreateFolder,
  isProcessing = false,
  searchQuery,
  onSearchChange,
  sortOption,
  onSortChange,
  searchScope,
  onSearchScopeChange,
  currentFolderName,
}: ToolbarProps) {
  const hasSelection = selectedCount > 0;

  // Phase 7: split-button menu state. Caret next to Download opens the
  // "Download as Zip" alternative. Click-outside closes the menu so the
  // user can dismiss without picking.
  const [showDlMenu, setShowDlMenu] = useState(false);
  const dlMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showDlMenu) return;
    const handler = (e: MouseEvent) => {
      if (dlMenuRef.current && !dlMenuRef.current.contains(e.target as Node)) {
        setShowDlMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDlMenu]);

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
        {/* Phase 7: split button — main click smart-routes; caret opens
            "Download as Zip" explicit option. */}
        <div ref={dlMenuRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            className="toolbar-btn"
            onClick={onDownload}
            disabled={!hasSelection || isProcessing}
            title={hasSelection
              ? `Download ${selectedCount} item(s) — uses ZIP for folders or large selections`
              : 'Select items to download'}
            style={onDownloadAsZip ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : undefined}
          >
            <span className="toolbar-icon">⬇️</span>
            <span className="toolbar-label">Download</span>
          </button>
          {onDownloadAsZip && (
            <>
              <button
                className="toolbar-btn"
                onClick={() => setShowDlMenu(v => !v)}
                disabled={!hasSelection || isProcessing}
                title="More download options"
                style={{
                  borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                  padding: '0 8px', marginLeft: -1,
                }}
              >
                <span style={{ fontSize: 10 }}>▾</span>
              </button>
              {showDlMenu && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0,
                  background: '#fff', border: '1px solid #d1d5db',
                  borderRadius: 6, boxShadow: '0 8px 20px rgba(0,0,0,0.12)',
                  padding: 4, zIndex: 100, minWidth: 220, marginTop: 4,
                }}>
                  <button
                    onClick={() => { setShowDlMenu(false); onDownloadAsZip(); }}
                    disabled={!hasSelection || isProcessing}
                    style={{
                      width: '100%', textAlign: 'left',
                      padding: '8px 10px', background: 'none',
                      border: 'none', cursor: 'pointer', borderRadius: 4,
                      fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>📦</span>
                    <span>Download as ZIP</span>
                  </button>
                  <div style={{ fontSize: 11, color: '#6b7280', padding: '4px 10px' }}>
                    Forces a single zip archive regardless of size.
                  </div>
                </div>
              )}
            </>
          )}
        </div>

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
            {(selectedBytes > 0 || selectedFolderCount > 0) && (
              <span className="toolbar-selection-size">
                {' · '}
                {selectedBytes > 0 ? formatBytes(selectedBytes) : ''}
                {selectedFolderCount > 0
                  ? `${selectedBytes > 0 ? ' + ' : ''}${selectedFolderCount} folder${selectedFolderCount !== 1 ? 's' : ''}`
                  : ''}
              </span>
            )}
          </span>
        )}

        {/* Search Input with Scope */}
        <div className="toolbar-search-container">
          <div className="toolbar-search">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              className="search-input"
              placeholder={searchScope === 'current' ? `Search in ${currentFolderName}...` : 'Search all files...'}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            {searchQuery && (
              <button
                className="search-clear"
                onClick={() => onSearchChange('')}
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <select
            className="toolbar-search-scope"
            value={searchScope}
            onChange={(e) => onSearchScopeChange(e.target.value as SearchScope)}
            title="Search scope"
          >
            <option value="current">Current Folder</option>
            <option value="all">All Files</option>
          </select>
        </div>

        {/* Sort Dropdown */}
        <select
          className="toolbar-sort"
          value={sortOption}
          onChange={(e) => onSortChange(e.target.value as SortOption)}
          title="Sort by"
        >
          <option value="name-asc">Name (A-Z)</option>
          <option value="name-desc">Name (Z-A)</option>
          <option value="date-newest">Newest First</option>
          <option value="date-oldest">Oldest First</option>
        </select>

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
