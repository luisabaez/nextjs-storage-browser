'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { list, downloadData, remove, copy, getUrl } from 'aws-amplify/storage';
import { FileContextMenu, ContextMenuAction } from './FileContextMenu';

export interface FileItem {
  key: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  lastModified?: Date;
  path: string;
}

type NotificationType = 'upload' | 'download' | 'delete' | 'move' | 'copy' | 'info' | 'error';

interface CustomFileBrowserProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onRename: (item: FileItem) => void;
  onMove: (item: FileItem, mode: 'move' | 'copy') => void;
  onDelete: (item: FileItem) => void;
  onUpload: () => void;
  onSelectionChange: (items: FileItem[]) => void;
  refreshKey: number;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  addNotification: (title: string, message: string, type: NotificationType, path?: string) => void;
}

export function CustomFileBrowser({
  currentPath,
  onNavigate,
  onRename,
  onMove,
  onDelete,
  onUpload,
  onSelectionChange,
  refreshKey,
  showToast,
  addNotification,
}: CustomFileBrowserProps) {
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ item: FileItem; x: number; y: number } | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'size' | 'type'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Fetch files and folders
  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const result = await list({
        path: currentPath,
        options: { listAll: true },
      });

      const fileItems: FileItem[] = [];
      const seenFolders = new Set<string>();

      for (const item of result.items) {
        const relativePath = item.path.replace(currentPath, '');
        const parts = relativePath.split('/').filter(Boolean);

        if (parts.length === 0) continue;

        if (parts.length === 1) {
          // Direct file in current folder
          fileItems.push({
            key: item.path,
            name: parts[0],
            type: 'file',
            size: item.size,
            lastModified: item.lastModified,
            path: item.path,
          });
        } else {
          // Subfolder
          const folderName = parts[0];
          const folderPath = currentPath + folderName + '/';
          if (!seenFolders.has(folderPath)) {
            seenFolders.add(folderPath);
            fileItems.push({
              key: folderPath,
              name: folderName,
              type: 'folder',
              path: folderPath,
            });
          }
        }
      }

      setItems(fileItems);
    } catch (error) {
      console.error('Error fetching items:', error);
      showToast('Failed to load files', 'error');
    } finally {
      setLoading(false);
    }
  }, [currentPath, showToast]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems, refreshKey]);

  // Clear selection when path changes
  useEffect(() => {
    setSelectedItems(new Set());
    onSelectionChange([]);
  }, [currentPath, onSelectionChange]);

  // Sort items
  const sortedItems = React.useMemo(() => {
    const sorted = [...items].sort((a, b) => {
      // Folders always come first
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;

      let comparison = 0;
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'date':
          comparison = (a.lastModified?.getTime() || 0) - (b.lastModified?.getTime() || 0);
          break;
        case 'size':
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case 'type':
          comparison = a.name.split('.').pop()?.localeCompare(b.name.split('.').pop() || '') || 0;
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [items, sortBy, sortOrder]);

  // Handle selection
  const handleSelect = (item: FileItem, checked: boolean) => {
    const newSelection = new Set(selectedItems);
    if (checked) {
      newSelection.add(item.key);
    } else {
      newSelection.delete(item.key);
    }
    setSelectedItems(newSelection);
    onSelectionChange(items.filter(i => newSelection.has(i.key)));
  };

  // Handle select all
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allKeys = new Set(items.map(i => i.key));
      setSelectedItems(allKeys);
      onSelectionChange(items);
    } else {
      setSelectedItems(new Set());
      onSelectionChange([]);
    }
  };

  // Handle folder double-click
  const handleItemDoubleClick = (item: FileItem) => {
    if (item.type === 'folder') {
      onNavigate(item.path);
    }
  };

  // Handle download
  const handleDownload = async (item: FileItem) => {
    if (item.type === 'folder') {
      showToast('Cannot download folders directly', 'info');
      return;
    }
    try {
      const result = await getUrl({
        path: item.path,
        options: { expiresIn: 3600 },
      });

      // Open download in new tab
      const link = document.createElement('a');
      link.href = result.url.toString();
      link.download = item.name;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      showToast(`Downloading ${item.name}`, 'success');
      addNotification('File Downloaded', `${item.name} downloaded`, 'download', item.path);
    } catch (error) {
      console.error('Download error:', error);
      showToast('Failed to download file', 'error');
    }
  };

  // Context menu actions
  const getContextMenuActions = (item: FileItem): ContextMenuAction[] => {
    const actions: ContextMenuAction[] = [
      {
        id: 'open',
        label: item.type === 'folder' ? 'Open' : 'Download',
        icon: item.type === 'folder' ? <span>📂</span> : <span>⬇️</span>,
        onClick: () => {
          if (item.type === 'folder') {
            onNavigate(item.path);
          } else {
            handleDownload(item);
          }
        },
      },
      {
        id: 'rename',
        label: 'Rename',
        icon: <span>✏️</span>,
        onClick: () => onRename(item),
      },
      {
        id: 'move',
        label: 'Move to...',
        icon: <span>📁</span>,
        onClick: () => onMove(item, 'move'),
      },
      {
        id: 'copy',
        label: 'Copy to...',
        icon: <span>📋</span>,
        onClick: () => onMove(item, 'copy'),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <span>🗑️</span>,
        onClick: () => onDelete(item),
        divider: true,
        danger: true,
      },
    ];
    return actions;
  };

  // Handle right-click
  const handleContextMenu = (e: React.MouseEvent, item: FileItem) => {
    e.preventDefault();
    setContextMenu({ item, x: e.clientX, y: e.clientY });
  };

  // Format file size
  const formatSize = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  // Format date
  const formatDate = (date?: Date) => {
    if (!date) return '-';
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Handle sort
  const handleSort = (column: 'name' | 'date' | 'size' | 'type') => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
  };

  // Get file icon
  const getFileIcon = (item: FileItem) => {
    if (item.type === 'folder') return '📁';
    const ext = item.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf': return '📕';
      case 'doc': case 'docx': return '📘';
      case 'xls': case 'xlsx': case 'csv': return '📗';
      case 'ppt': case 'pptx': return '📙';
      case 'jpg': case 'jpeg': case 'png': case 'gif': case 'svg': return '🖼️';
      case 'mp4': case 'mov': case 'avi': return '🎬';
      case 'mp3': case 'wav': return '🎵';
      case 'zip': case 'rar': case '7z': return '📦';
      case 'txt': return '📝';
      case 'json': case 'xml': return '📋';
      case 'js': case 'ts': case 'py': case 'java': return '💻';
      default: return '📄';
    }
  };

  const isAllSelected = items.length > 0 && selectedItems.size === items.length;
  const isPartiallySelected = selectedItems.size > 0 && selectedItems.size < items.length;

  return (
    <div className="custom-file-browser">
      {/* Table Header */}
      <div className="file-table-header">
        <div className="file-table-cell checkbox-cell">
          <input
            type="checkbox"
            checked={isAllSelected}
            ref={(el) => {
              if (el) el.indeterminate = isPartiallySelected;
            }}
            onChange={(e) => handleSelectAll(e.target.checked)}
            title="Select all"
          />
        </div>
        <div
          className={`file-table-cell name-cell sortable ${sortBy === 'name' ? 'sorted' : ''}`}
          onClick={() => handleSort('name')}
        >
          Name {sortBy === 'name' && (sortOrder === 'asc' ? '↑' : '↓')}
        </div>
        <div
          className={`file-table-cell date-cell sortable ${sortBy === 'date' ? 'sorted' : ''}`}
          onClick={() => handleSort('date')}
        >
          Modified {sortBy === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
        </div>
        <div
          className={`file-table-cell size-cell sortable ${sortBy === 'size' ? 'sorted' : ''}`}
          onClick={() => handleSort('size')}
        >
          Size {sortBy === 'size' && (sortOrder === 'asc' ? '↑' : '↓')}
        </div>
        <div className="file-table-cell actions-cell">Actions</div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="file-table-loading">
          <div className="loading-spinner"></div>
          <span>Loading files...</span>
        </div>
      )}

      {/* Empty State */}
      {!loading && items.length === 0 && (
        <div className="file-table-empty">
          <span className="empty-icon">📂</span>
          <p>This folder is empty</p>
          <button className="btn btn-primary" onClick={onUpload}>
            Upload Files
          </button>
        </div>
      )}

      {/* File List */}
      {!loading && items.length > 0 && (
        <div className="file-table-body">
          {sortedItems.map((item) => (
            <div
              key={item.key}
              className={`file-table-row ${selectedItems.has(item.key) ? 'selected' : ''}`}
              onDoubleClick={() => handleItemDoubleClick(item)}
              onContextMenu={(e) => handleContextMenu(e, item)}
            >
              <div className="file-table-cell checkbox-cell">
                <input
                  type="checkbox"
                  checked={selectedItems.has(item.key)}
                  onChange={(e) => handleSelect(item, e.target.checked)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <div className="file-table-cell name-cell">
                <span className="file-icon">{getFileIcon(item)}</span>
                <span
                  className={`file-name ${item.type === 'folder' ? 'folder-name' : ''}`}
                  onClick={() => item.type === 'folder' && onNavigate(item.path)}
                >
                  {item.name}
                </span>
              </div>
              <div className="file-table-cell date-cell">
                {formatDate(item.lastModified)}
              </div>
              <div className="file-table-cell size-cell">
                {item.type === 'folder' ? '-' : formatSize(item.size)}
              </div>
              <div className="file-table-cell actions-cell">
                <FileContextMenu
                  actions={getContextMenuActions(item)}
                  trigger={
                    <button className="action-menu-btn" title="More actions">
                      ⋮
                    </button>
                  }
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <>
          <div
            className="context-menu-backdrop"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="context-menu-popup"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {getContextMenuActions(contextMenu.item).map((action) => (
              <React.Fragment key={action.id}>
                {action.divider && <div className="context-menu-divider" />}
                <button
                  className={`context-menu-popup-item ${action.danger ? 'danger' : ''}`}
                  onClick={() => {
                    action.onClick();
                    setContextMenu(null);
                  }}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
