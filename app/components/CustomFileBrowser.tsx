'use client';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { list, getUrl } from 'aws-amplify/storage';
import { FileContextMenu, ContextMenuAction } from './FileContextMenu';
import { SortOption, SearchScope } from './Toolbar';
import {
  isAdminUser,
  extractSourceFromPath,
  getUserPermissions,
  SourceTag
} from '../admin/types';
import {
  generateShareableLink,
  generateShareableFolderLink,
  copyToClipboard
} from '../lib/shareableLinks';

export interface FileItem {
  key: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  lastModified?: Date;
  path: string;
  sourceTag?: string; // Source tag extracted from path
}

type NotificationType = 'upload' | 'download' | 'delete' | 'move' | 'copy' | 'info' | 'error';

interface CustomFileBrowserProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onRename: (item: FileItem) => void;
  onMove: (item: FileItem, mode: 'move' | 'copy') => void;
  onDelete: (item: FileItem) => void;
  onPreview: (item: FileItem) => void;
  onUpload: () => void;
  onSelectionChange: (items: FileItem[]) => void;
  refreshKey: number;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  addNotification: (title: string, message: string, type: NotificationType, path?: string) => void;
  searchQuery: string;
  sortOption: SortOption;
  searchScope: SearchScope;
  userEmail?: string; // Current user email for permission filtering
}

// Helper function to check if user can access a file based on source permissions
function canUserAccessFile(userEmail: string | undefined, filePath: string): boolean {
  if (!userEmail) return true; // If no user email, allow access (will be filtered at auth level)

  // Admins can access everything
  if (isAdminUser(userEmail)) return true;

  // Extract source from path
  const source = extractSourceFromPath(filePath);

  // If no source tag in path, allow access (file not in source-protected area)
  if (!source) return true;

  // Check user permissions
  const permissions = getUserPermissions(userEmail);
  if (!permissions || permissions.allowedSources.length === 0) {
    // No permissions set means no access to source-protected files
    return false;
  }

  return permissions.allowedSources.includes(source as SourceTag);
}

export function CustomFileBrowser({
  currentPath,
  onNavigate,
  onRename,
  onMove,
  onDelete,
  onPreview,
  onUpload,
  onSelectionChange,
  refreshKey,
  showToast,
  addNotification,
  searchQuery,
  sortOption,
  searchScope,
  userEmail,
}: CustomFileBrowserProps) {
  const [items, setItems] = useState<FileItem[]>([]);
  const [allItems, setAllItems] = useState<FileItem[]>([]); // For global search
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ item: FileItem; x: number; y: number } | null>(null);

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

        // Check source permission for the full path
        if (!canUserAccessFile(userEmail, item.path)) {
          continue; // Skip files/folders user doesn't have permission to access
        }

        if (parts.length === 1) {
          // Direct file in current folder
          const sourceTag = extractSourceFromPath(item.path);
          fileItems.push({
            key: item.path,
            name: parts[0],
            type: 'file',
            size: item.size,
            lastModified: item.lastModified,
            path: item.path,
            sourceTag: sourceTag || undefined,
          });
        } else {
          // Subfolder
          const folderName = parts[0];
          const folderPath = currentPath + folderName + '/';
          if (!seenFolders.has(folderPath)) {
            seenFolders.add(folderPath);
            const sourceTag = extractSourceFromPath(folderPath);
            fileItems.push({
              key: folderPath,
              name: folderName,
              type: 'folder',
              path: folderPath,
              sourceTag: sourceTag || undefined,
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
  }, [currentPath, showToast, userEmail]);

  // Fetch all items for global search
  const fetchAllItems = useCallback(async () => {
    setSearchLoading(true);
    try {
      const result = await list({
        path: '', // Search from root
        options: { listAll: true },
      });

      const fileItems: FileItem[] = [];

      for (const item of result.items) {
        // Skip placeholder files like .keep
        if (item.path.endsWith('.keep')) continue;

        // Check source permission for the full path
        if (!canUserAccessFile(userEmail, item.path)) {
          continue; // Skip files user doesn't have permission to access
        }

        const parts = item.path.split('/').filter(Boolean);
        if (parts.length === 0) continue;

        const fileName = parts[parts.length - 1];
        const sourceTag = extractSourceFromPath(item.path);

        fileItems.push({
          key: item.path,
          name: fileName,
          type: 'file',
          size: item.size,
          lastModified: item.lastModified,
          path: item.path,
          sourceTag: sourceTag || undefined,
        });
      }

      setAllItems(fileItems);
    } catch (error) {
      console.error('Error fetching all items:', error);
    } finally {
      setSearchLoading(false);
    }
  }, [userEmail]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems, refreshKey]);

  // Fetch all items when scope changes to 'all' and there's a search query
  useEffect(() => {
    if (searchScope === 'all' && searchQuery.trim() && allItems.length === 0) {
      fetchAllItems();
    }
  }, [searchScope, searchQuery, allItems.length, fetchAllItems]);

  // Refetch all items when refresh key changes (if we're in global search mode)
  useEffect(() => {
    if (searchScope === 'all' && searchQuery.trim()) {
      fetchAllItems();
    }
  }, [refreshKey, searchScope, searchQuery, fetchAllItems]);

  // Clear selection when path changes
  useEffect(() => {
    setSelectedItems(new Set());
    onSelectionChange([]);
  }, [currentPath, onSelectionChange]);

  // Filter items based on search query and scope
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;

    const query = searchQuery.toLowerCase();

    if (searchScope === 'all') {
      // Search all items
      return allItems.filter(item =>
        item.name.toLowerCase().includes(query)
      );
    } else {
      // Search current folder only
      return items.filter(item =>
        item.name.toLowerCase().includes(query)
      );
    }
  }, [items, allItems, searchQuery, searchScope]);

  // Sort items based on sortOption from toolbar
  const sortedItems = useMemo(() => {
    const sorted = [...filteredItems].sort((a, b) => {
      // Folders always come first
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;

      switch (sortOption) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'date-newest':
          return (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0);
        case 'date-oldest':
          return (a.lastModified?.getTime() || 0) - (b.lastModified?.getTime() || 0);
        default:
          return a.name.localeCompare(b.name);
      }
    });
    return sorted;
  }, [filteredItems, sortOption]);

  // Handle selection
  const handleSelect = (item: FileItem, checked: boolean) => {
    const newSelection = new Set(selectedItems);
    if (checked) {
      newSelection.add(item.key);
    } else {
      newSelection.delete(item.key);
    }
    setSelectedItems(newSelection);
    onSelectionChange(filteredItems.filter(i => newSelection.has(i.key)));
  };

  // Handle select all (only selects filtered/visible items)
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allKeys = new Set(filteredItems.map(i => i.key));
      setSelectedItems(allKeys);
      onSelectionChange(filteredItems);
    } else {
      setSelectedItems(new Set());
      onSelectionChange([]);
    }
  };

  // Handle item double-click - folders open, files preview
  const handleItemDoubleClick = (item: FileItem) => {
    if (item.type === 'folder') {
      onNavigate(item.path);
    } else {
      onPreview(item);
    }
  };

  // Handle share - generate shareable link and copy to clipboard
  const handleShare = async (item: FileItem) => {
    try {
      let url: string;
      if (item.type === 'folder') {
        const result = generateShareableFolderLink(item.path, item.name, userEmail || 'unknown');
        url = result.url;
      } else {
        const result = generateShareableLink(item.path, item.name, userEmail || 'unknown');
        url = result.url;
      }
      const copied = await copyToClipboard(url);
      if (copied) {
        showToast(`Link copied to clipboard!`, 'success');
        const itemType = item.type === 'folder' ? 'Folder' : 'File';
        addNotification(`${itemType} Link Shared`, `Shareable link created for ${item.name}`, 'info', item.path);
      } else {
        showToast('Failed to copy link', 'error');
      }
    } catch (error) {
      console.error('Share error:', error);
      showToast('Failed to create shareable link', 'error');
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
    const actions: ContextMenuAction[] = [];

    if (item.type === 'folder') {
      actions.push({
        id: 'open',
        label: 'Open',
        icon: <span>📂</span>,
        onClick: () => onNavigate(item.path),
      });
      actions.push({
        id: 'share',
        label: 'Share Link',
        icon: <span>🔗</span>,
        onClick: () => handleShare(item),
      });
    } else {
      actions.push({
        id: 'preview',
        label: 'Preview',
        icon: <span>👁️</span>,
        onClick: () => onPreview(item),
      });
      actions.push({
        id: 'download',
        label: 'Download',
        icon: <span>⬇️</span>,
        onClick: () => handleDownload(item),
      });
      actions.push({
        id: 'share',
        label: 'Share Link',
        icon: <span>🔗</span>,
        onClick: () => handleShare(item),
      });
    }

    actions.push(
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
      }
    );

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

  // Get sort label for header display
  const getSortLabel = () => {
    switch (sortOption) {
      case 'name-asc': return 'Name ↑';
      case 'name-desc': return 'Name ↓';
      case 'date-newest': return 'Date ↓';
      case 'date-oldest': return 'Date ↑';
      default: return 'Name ↑';
    }
  };

  const isAllSelected = filteredItems.length > 0 && selectedItems.size === filteredItems.length;
  const isPartiallySelected = selectedItems.size > 0 && selectedItems.size < filteredItems.length;

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
        <div className="file-table-cell name-cell">
          Name
        </div>
        <div className="file-table-cell date-cell">
          Modified
        </div>
        <div className="file-table-cell size-cell">
          Size
        </div>
        <div className="file-table-cell actions-cell">Actions</div>
      </div>

      {/* Loading State */}
      {(loading || searchLoading) && (
        <div className="file-table-loading">
          <div className="loading-spinner"></div>
          <span>{searchLoading ? 'Searching all files...' : 'Loading files...'}</span>
        </div>
      )}

      {/* Empty State - No items at all */}
      {!loading && items.length === 0 && (
        <div className="file-table-empty">
          <span className="empty-icon">📂</span>
          <p>This folder is empty</p>
          <button className="btn btn-primary" onClick={onUpload}>
            Upload Files
          </button>
        </div>
      )}

      {/* No results from search */}
      {!loading && items.length > 0 && filteredItems.length === 0 && (
        <div className="file-table-empty">
          <span className="empty-icon">🔍</span>
          <p>No files match "{searchQuery}"</p>
          <button className="btn btn-secondary" onClick={() => {}}>
            Clear Search
          </button>
        </div>
      )}

      {/* File List */}
      {!loading && filteredItems.length > 0 && (
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
                <div className="file-name-container">
                  <span
                    className={`file-name ${item.type === 'folder' ? 'folder-name' : ''}`}
                    onClick={() => item.type === 'folder' && onNavigate(item.path)}
                  >
                    {item.name}
                  </span>
                  {searchScope === 'all' && searchQuery.trim() && (
                    <span
                      className="file-location"
                      onClick={() => {
                        const parentPath = item.path.substring(0, item.path.lastIndexOf('/') + 1);
                        onNavigate(parentPath);
                      }}
                      title="Go to folder"
                    >
                      📁 {item.path.substring(0, item.path.lastIndexOf('/')) || 'Root'}
                    </span>
                  )}
                </div>
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

      {/* Search results count */}
      {!loading && !searchLoading && searchQuery && filteredItems.length > 0 && (
        <div className="search-results-count">
          Found {filteredItems.length} item{filteredItems.length !== 1 ? 's' : ''} matching "{searchQuery}"
          {searchScope === 'all' && <span className="search-scope-indicator"> (searching all files)</span>}
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
