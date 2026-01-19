'use client';
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { uploadData, downloadData, remove, copy, list } from 'aws-amplify/storage';
import { FileContextMenu, ContextMenuAction } from './FileContextMenu';
import { RenameModal } from './RenameModal';
import { MoveToModal } from './MoveToModal';
import { ConfirmDialog } from './ConfirmDialog';
import { ToastContainer, useToast } from './Toast';
import { NotificationCenter, useNotifications } from './NotificationCenter';
import { UploadProgress, UploadItem } from './UploadProgress';

export interface FileItem {
  key: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  lastModified?: Date;
  path: string;
}

interface EnhancedFileBrowserProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  availableFolders: { path: string; name: string }[];
  onRefresh: () => void;
}

export function EnhancedFileBrowser({
  currentPath,
  onNavigate,
  availableFolders,
  onRefresh,
}: EnhancedFileBrowserProps) {
  // State
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem } | null>(null);
  const [renameItem, setRenameItem] = useState<FileItem | null>(null);
  const [moveItem, setMoveItem] = useState<{ item: FileItem; mode: 'move' | 'copy' } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<FileItem | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [sortField, setSortField] = useState<'name' | 'size' | 'date'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toasts, removeToast, success, error: showError, info } = useToast();
  const {
    notifications,
    addNotification,
    markAsRead,
    markAllAsRead,
    clearAll,
    unreadCount,
  } = useNotifications();

  // Fetch files when path changes
  useEffect(() => {
    fetchFiles();
  }, [currentPath]);

  const fetchFiles = async () => {
    setIsLoading(true);
    try {
      const result = await list({
        path: currentPath || '',
        options: { listAll: true },
      });

      const items: FileItem[] = [];
      const seenFolders = new Set<string>();

      for (const item of result.items) {
        const relativePath = item.path.replace(currentPath, '');
        const parts = relativePath.split('/').filter(Boolean);

        if (parts.length === 0) continue;

        if (parts.length === 1) {
          // Direct file
          items.push({
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
            items.push({
              key: folderPath,
              name: folderName,
              type: 'folder',
              path: folderPath,
            });
          }
        }
      }

      setFiles(items);
    } catch (err) {
      console.error('Error fetching files:', err);
      showError('Failed to load files');
    } finally {
      setIsLoading(false);
    }
  };

  // Sort files
  const sortedFiles = useMemo(() => {
    const sorted = [...files].sort((a, b) => {
      // Folders first
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }

      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size':
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case 'date':
          comparison = (a.lastModified?.getTime() || 0) - (b.lastModified?.getTime() || 0);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [files, sortField, sortDirection]);

  // Format file size
  const formatSize = (bytes?: number) => {
    if (!bytes) return '-';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // Format date
  const formatDate = (date?: Date) => {
    if (!date) return '-';
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Get file icon
  const getFileIcon = (item: FileItem) => {
    if (item.type === 'folder') return '📁';
    const ext = item.name.split('.').pop()?.toLowerCase();
    const icons: Record<string, string> = {
      pdf: '📄',
      doc: '📝',
      docx: '📝',
      xls: '📊',
      xlsx: '📊',
      csv: '📊',
      txt: '📃',
      png: '🖼️',
      jpg: '🖼️',
      jpeg: '🖼️',
      gif: '🖼️',
      zip: '📦',
      json: '📋',
      sql: '🗃️',
    };
    return icons[ext || ''] || '📄';
  };

  // Handle item click
  const handleItemClick = (item: FileItem) => {
    if (item.type === 'folder') {
      onNavigate(item.path);
    }
  };

  // Handle checkbox
  const handleSelect = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Handle select all
  const handleSelectAll = () => {
    if (selectedItems.size === files.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(files.map(f => f.key)));
    }
  };

  // Context menu handler
  const handleContextMenu = (e: React.MouseEvent, item: FileItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  };

  // Three-dot menu handler
  const handleMenuClick = (e: React.MouseEvent, item: FileItem) => {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setContextMenu({ x: rect.right, y: rect.bottom, item });
  };

  // Get context menu actions
  const getContextMenuActions = useCallback((item: FileItem): ContextMenuAction[] => {
    const actions: ContextMenuAction[] = [
      {
        id: 'open',
        label: item.type === 'folder' ? 'Open' : 'Download',
        icon: item.type === 'folder' ? '📂' : '📥',
        onClick: () => item.type === 'folder' ? onNavigate(item.path) : handleDownload(item),
      },
      {
        id: 'rename',
        label: 'Rename',
        icon: '✏️',
        onClick: () => setRenameItem(item),
        divider: true,
      },
      {
        id: 'move',
        label: 'Move to',
        icon: '📦',
        onClick: () => setMoveItem({ item, mode: 'move' }),
      },
      {
        id: 'copy',
        label: 'Copy to',
        icon: '📋',
        onClick: () => setMoveItem({ item, mode: 'copy' }),
        divider: true,
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: '🗑️',
        onClick: () => setDeleteConfirm(item),
        danger: true,
      },
    ];
    return actions;
  }, [onNavigate]);

  // Download file
  const handleDownload = async (item: FileItem) => {
    try {
      info(`Downloading ${item.name}...`);
      const result = await downloadData({ path: item.path }).result;
      const blob = await result.body.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      success(`Downloaded ${item.name}`);
      addNotification('File Downloaded', `${item.name} has been downloaded`, 'download', item.path);
    } catch (err) {
      console.error('Download error:', err);
      showError(`Failed to download ${item.name}`);
    }
  };

  // Rename handler
  const handleRename = async (newName: string) => {
    if (!renameItem) return;
    setIsProcessing(true);
    try {
      const oldPath = renameItem.path;
      const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1);
      const newPath = parentPath + newName + (renameItem.type === 'folder' ? '/' : '');

      // Copy to new location
      await copy({
        source: { path: oldPath },
        destination: { path: newPath },
      });

      // Delete old
      await remove({ path: oldPath });

      success(`Renamed to ${newName}`);
      addNotification('File Renamed', `${renameItem.name} renamed to ${newName}`, 'info', newPath);
      setRenameItem(null);
      fetchFiles();
      onRefresh();
    } catch (err) {
      console.error('Rename error:', err);
      showError('Failed to rename');
    } finally {
      setIsProcessing(false);
    }
  };

  // Move/Copy handler
  const handleMoveOrCopy = async (destinationPath: string) => {
    if (!moveItem) return;
    setIsProcessing(true);
    try {
      const { item, mode } = moveItem;
      const newPath = destinationPath + item.name + (item.type === 'folder' ? '/' : '');

      await copy({
        source: { path: item.path },
        destination: { path: newPath },
      });

      if (mode === 'move') {
        await remove({ path: item.path });
      }

      success(`${mode === 'move' ? 'Moved' : 'Copied'} ${item.name}`);
      addNotification(
        mode === 'move' ? 'File Moved' : 'File Copied',
        `${item.name} ${mode === 'move' ? 'moved' : 'copied'} to ${destinationPath || 'root'}`,
        mode,
        newPath
      );
      setMoveItem(null);
      fetchFiles();
      onRefresh();
    } catch (err) {
      console.error('Move/Copy error:', err);
      showError(`Failed to ${moveItem.mode}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Delete handler
  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setIsProcessing(true);
    try {
      await remove({ path: deleteConfirm.path });
      success(`Deleted ${deleteConfirm.name}`);
      addNotification('File Deleted', `${deleteConfirm.name} has been deleted`, 'delete');
      setDeleteConfirm(null);
      fetchFiles();
      onRefresh();
    } catch (err) {
      console.error('Delete error:', err);
      showError('Failed to delete');
    } finally {
      setIsProcessing(false);
    }
  };

  // Upload handler
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const newUploads: UploadItem[] = Array.from(fileList).map(file => ({
      id: `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      fileName: file.name,
      progress: 0,
      status: 'pending' as const,
      size: file.size,
    }));

    setUploads(prev => [...prev, ...newUploads]);

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const uploadId = newUploads[i].id;
      const path = currentPath + file.name;

      try {
        setUploads(prev =>
          prev.map(u => (u.id === uploadId ? { ...u, status: 'uploading' as const } : u))
        );

        await uploadData({
          path,
          data: file,
          options: {
            onProgress: ({ transferredBytes, totalBytes }) => {
              const progress = totalBytes ? Math.round((transferredBytes / totalBytes) * 100) : 0;
              setUploads(prev =>
                prev.map(u => (u.id === uploadId ? { ...u, progress } : u))
              );
            },
          },
        }).result;

        setUploads(prev =>
          prev.map(u => (u.id === uploadId ? { ...u, status: 'completed' as const, progress: 100 } : u))
        );

        addNotification('File Uploaded', `${file.name} has been uploaded`, 'upload', path);
      } catch (err) {
        console.error('Upload error:', err);
        setUploads(prev =>
          prev.map(u =>
            u.id === uploadId
              ? { ...u, status: 'error' as const, error: 'Upload failed' }
              : u
          )
        );
      }
    }

    fetchFiles();
    onRefresh();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Dismiss upload
  const handleDismissUpload = (id: string) => {
    setUploads(prev => prev.filter(u => u.id !== id));
  };

  // Dismiss all uploads
  const handleDismissAllUploads = () => {
    setUploads([]);
  };

  // Build folder tree for move modal
  const folderTree = useMemo(() => {
    return availableFolders.map(f => ({
      path: f.path,
      name: f.name,
      level: (f.path.match(/\//g) || []).length - 1,
    }));
  }, [availableFolders]);

  return (
    <div className="enhanced-file-browser">
      {/* Toolbar */}
      <div className="file-browser-toolbar">
        <div className="toolbar-left">
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            📤 Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleUpload}
          />
          <button className="btn btn-secondary" onClick={fetchFiles}>
            🔄 Refresh
          </button>
          {selectedItems.size > 0 && (
            <span className="selected-count">{selectedItems.size} selected</span>
          )}
        </div>
        <div className="toolbar-right">
          <button
            className="notification-btn"
            onClick={() => setIsNotificationOpen(true)}
          >
            🔔
            {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
          </button>
          <select
            className="sort-select"
            value={`${sortField}-${sortDirection}`}
            onChange={(e) => {
              const [field, dir] = e.target.value.split('-');
              setSortField(field as 'name' | 'size' | 'date');
              setSortDirection(dir as 'asc' | 'desc');
            }}
          >
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
            <option value="date-desc">Date (Newest)</option>
            <option value="date-asc">Date (Oldest)</option>
            <option value="size-desc">Size (Largest)</option>
            <option value="size-asc">Size (Smallest)</option>
          </select>
        </div>
      </div>

      {/* File list header */}
      <div className="file-list-header">
        <div className="file-col checkbox-col">
          <input
            type="checkbox"
            checked={selectedItems.size === files.length && files.length > 0}
            onChange={handleSelectAll}
          />
        </div>
        <div className="file-col icon-col" />
        <div className="file-col name-col">Name</div>
        <div className="file-col size-col">Size</div>
        <div className="file-col date-col">Modified</div>
        <div className="file-col actions-col" />
      </div>

      {/* File list */}
      <div className="file-list">
        {isLoading ? (
          <div className="loading-state">
            <span className="spinner" />
            Loading files...
          </div>
        ) : sortedFiles.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">📂</span>
            <p>This folder is empty</p>
            <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
              Upload Files
            </button>
          </div>
        ) : (
          sortedFiles.map(item => (
            <div
              key={item.key}
              className={`file-row ${selectedItems.has(item.key) ? 'selected' : ''}`}
              onClick={() => handleItemClick(item)}
              onContextMenu={(e) => handleContextMenu(e, item)}
            >
              <div className="file-col checkbox-col" onClick={(e) => handleSelect(item.key, e)}>
                <input
                  type="checkbox"
                  checked={selectedItems.has(item.key)}
                  readOnly
                />
              </div>
              <div className="file-col icon-col">
                <span className="file-icon">{getFileIcon(item)}</span>
              </div>
              <div className="file-col name-col">
                <span className="file-name">{item.name}</span>
              </div>
              <div className="file-col size-col">{formatSize(item.size)}</div>
              <div className="file-col date-col">{formatDate(item.lastModified)}</div>
              <div className="file-col actions-col">
                <button
                  className="menu-btn"
                  onClick={(e) => handleMenuClick(e, item)}
                  title="More actions"
                >
                  ⋮
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <FileContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          actions={getContextMenuActions(contextMenu.item)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Rename Modal */}
      <RenameModal
        isOpen={!!renameItem}
        onClose={() => setRenameItem(null)}
        onRename={handleRename}
        currentName={renameItem?.name || ''}
        itemType={renameItem?.type || 'file'}
        isLoading={isProcessing}
      />

      {/* Move/Copy Modal */}
      {moveItem && (
        <MoveToModal
          isOpen={!!moveItem}
          onClose={() => setMoveItem(null)}
          onMove={handleMoveOrCopy}
          itemName={moveItem.item.name}
          itemType={moveItem.item.type}
          currentPath={currentPath}
          availableFolders={folderTree}
          mode={moveItem.mode}
          isLoading={isProcessing}
        />
      )}

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
        title="Delete Item"
        message={`Are you sure you want to delete "${deleteConfirm?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        isDangerous
        isLoading={isProcessing}
      />

      {/* Upload Progress */}
      <UploadProgress
        uploads={uploads}
        onDismiss={handleDismissUpload}
        onDismissAll={handleDismissAllUploads}
      />

      {/* Notification Center */}
      <NotificationCenter
        isOpen={isNotificationOpen}
        onClose={() => setIsNotificationOpen(false)}
        notifications={notifications}
        onMarkAsRead={markAsRead}
        onMarkAllAsRead={markAllAsRead}
        onClearAll={clearAll}
        onNavigateToFile={(path) => {
          const parentPath = path.substring(0, path.lastIndexOf('/') + 1);
          onNavigate(parentPath);
        }}
      />

      {/* Toasts */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
