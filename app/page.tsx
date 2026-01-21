'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { signOut, fetchUserAttributes } from 'aws-amplify/auth';
import { Button, withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import './components/enhanced-file-browser.css';
import config from '../amplify_outputs.json';
import Link from 'next/link';
import { isAdminUser } from './admin/types';

// Components
import { CustomFileBrowser, FileItem } from './components/CustomFileBrowser';
import { Toolbar, SortOption, SearchScope } from './components/Toolbar';
import { RenameModal } from './components/RenameModal';
import { MoveToModal } from './components/MoveToModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { CreateFolderModal } from './components/CreateFolderModal';
import { ToastContainer, useToast } from './components/Toast';
import { NotificationCenter, useNotifications } from './components/NotificationCenter';
import { UploadProgress, UploadItem } from './components/UploadProgress';
import { FilePreviewModal } from './components/FilePreviewModal';

// Amplify Storage imports
import { uploadData, remove, copy, list, getUrl } from 'aws-amplify/storage';

Amplify.configure(config);

// Determine environment from bucket name
const getEnvironmentName = () => {
  const bucketName = config.storage?.bucket_name || '';
  if (bucketName.includes('-prd') || bucketName.includes('-prod')) {
    return 'Production';
  } else if (bucketName.includes('-dev')) {
    return 'Development';
  }
  return '';
};

// Type for quick links
interface QuickLink {
  id: string;
  path: string;
  name: string;
}

// Folder configuration with icons and colors
const folders = [
  { path: 'ConversionFiles/', name: 'Conversion Files', icon: '📄', type: 'conversion' },
  { path: 'ConversionFileErrors/', name: 'Conversion Errors', icon: '⚠️', type: 'error' },
  { path: 'InitialUpload/', name: 'Initial Upload', icon: '📤', type: 'upload' },
  { path: 'InitialUploadErrors/', name: 'Upload Errors', icon: '❌', type: 'error' },
  { path: 'TSQLFiles/', name: 'TSQL Files', icon: '🗃️', type: 'sql' },
  { path: 'DataValidation/', name: 'Data Validation', icon: '✅', type: 'validation' },
];

// Default quick links
const defaultQuickLinks: QuickLink[] = [
  { id: 'default-1', path: 'ConversionFileErrors/Mock8/', name: 'Mock8 Errors' },
];

function FileBrowser() {
  const [userEmail, setUserEmail] = useState<string>('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const environmentName = getEnvironmentName();

  // Quick Links state
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>(defaultQuickLinks);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newLinkPath, setNewLinkPath] = useState('');
  const [newLinkName, setNewLinkName] = useState('');
  const [showContextMenu, setShowContextMenu] = useState(false);

  // File selection and actions state
  const [selectedItems, setSelectedItems] = useState<FileItem[]>([]);
  const [renameItem, setRenameItem] = useState<FileItem | null>(null);
  const [moveItem, setMoveItem] = useState<{ item: FileItem; mode: 'move' | 'copy' } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<FileItem | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkMoveMode, setBulkMoveMode] = useState<'move' | 'copy' | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [availableFolders, setAvailableFolders] = useState<{ path: string; name: string; level: number }[]>([]);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  // Search and sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('name-asc');
  const [searchScope, setSearchScope] = useState<SearchScope>('current');

  // Hooks
  const { toasts, removeToast, success, error: showError, info } = useToast();
  const {
    notifications,
    addNotification,
    markAsRead,
    markAllAsRead,
    clearAll,
    unreadCount,
  } = useNotifications();

  // Load quick links from localStorage on mount
  useEffect(() => {
    const savedLinks = localStorage.getItem('hacienda-quick-links');
    if (savedLinks) {
      try {
        setQuickLinks(JSON.parse(savedLinks));
      } catch (e) {
        console.error('Error loading quick links:', e);
      }
    }
  }, []);

  // Save quick links to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('hacienda-quick-links', JSON.stringify(quickLinks));
  }, [quickLinks]);

  useEffect(() => {
    // Fetch user attributes and check admin status
    async function getAttributes() {
      try {
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';
        setUserEmail(email);
        setIsAdmin(isAdminUser(email));
      } catch (error) {
        console.error('Error fetching user attributes', error);
      }
    }
    getAttributes();
  }, []);

  // Fetch available folders for move/copy modal
  useEffect(() => {
    async function fetchFolders() {
      const folderList: { path: string; name: string; level: number }[] = [];

      for (const folder of folders) {
        folderList.push({ path: folder.path, name: folder.name, level: 0 });

        try {
          const result = await list({
            path: folder.path,
            options: { listAll: true },
          });

          const subfolders = new Set<string>();
          for (const item of result.items) {
            const relativePath = item.path.replace(folder.path, '');
            const parts = relativePath.split('/').filter(Boolean);

            if (parts.length > 1) {
              let currentFolderPath = folder.path;
              for (let i = 0; i < parts.length - 1; i++) {
                currentFolderPath += parts[i] + '/';
                if (!subfolders.has(currentFolderPath)) {
                  subfolders.add(currentFolderPath);
                  folderList.push({
                    path: currentFolderPath,
                    name: parts[i],
                    level: i + 1,
                  });
                }
              }
            }
          }
        } catch (err) {
          console.error('Error fetching subfolders:', err);
        }
      }

      setAvailableFolders(folderList);
    }

    fetchFolders();
  }, [refreshKey]);

  // Handle folder navigation
  const handleFolderClick = useCallback((path: string) => {
    setCurrentPath(path);
    setSelectedItems([]);
    setRefreshKey(prev => prev + 1);
    setSidebarOpen(false);
    setShowContextMenu(false);
  }, []);

  // Handle navigation from custom browser
  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path);
    setSelectedItems([]);
  }, []);

  // Get user initials for avatar
  const getUserInitials = (email: string) => {
    if (!email) return 'U';
    const parts = email.split('@')[0].split(/[._-]/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return email.substring(0, 2).toUpperCase();
  };

  // Get current folder name for breadcrumb
  const getCurrentFolderName = () => {
    if (!currentPath) return 'All Folders';
    const folder = folders.find(f => f.path === currentPath);
    if (folder) return folder.name;
    const quickLink = quickLinks.find(ql => ql.path === currentPath);
    if (quickLink) return quickLink.name;
    return currentPath.replace(/\/$/, '').split('/').pop() || currentPath;
  };

  // Build breadcrumb path
  const getBreadcrumbPath = () => {
    if (!currentPath) return [];
    const parts = currentPath.split('/').filter(Boolean);
    const breadcrumbs: { name: string; path: string }[] = [];
    let path = '';
    for (const part of parts) {
      path += part + '/';
      const folder = folders.find(f => f.path === path);
      breadcrumbs.push({
        name: folder?.name || part,
        path: path,
      });
    }
    return breadcrumbs;
  };

  // Add a new quick link
  const handleAddQuickLink = () => {
    if (!newLinkPath.trim()) return;

    const path = newLinkPath.trim().endsWith('/') ? newLinkPath.trim() : newLinkPath.trim() + '/';
    const name = newLinkName.trim() || path.replace(/\/$/, '').split('/').pop() || path;

    const newLink: QuickLink = {
      id: `custom-${Date.now()}`,
      path,
      name,
    };

    setQuickLinks(prev => [...prev, newLink]);
    setNewLinkPath('');
    setNewLinkName('');
    setShowAddModal(false);
    success('Quick link added');
  };

  // Add current folder as quick link
  const handleAddCurrentAsQuickLink = () => {
    if (!currentPath) return;

    const existingLink = quickLinks.find(ql => ql.path === currentPath);
    if (existingLink) {
      info('This folder is already in your quick links.');
      setShowContextMenu(false);
      return;
    }

    const name = getCurrentFolderName();
    const newLink: QuickLink = {
      id: `custom-${Date.now()}`,
      path: currentPath,
      name,
    };

    setQuickLinks(prev => [...prev, newLink]);
    setShowContextMenu(false);
    success('Added to Quick Links');
  };

  // Delete a quick link
  const handleDeleteQuickLink = (id: string) => {
    setQuickLinks(prev => prev.filter(ql => ql.id !== id));
  };

  // Handle selection change from custom browser
  const handleSelectionChange = useCallback((items: FileItem[]) => {
    setSelectedItems(items);
  }, []);

  // Toast helper for custom browser
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    if (type === 'success') success(message);
    else if (type === 'error') showError(message);
    else info(message);
  }, [success, showError, info]);

  // Rename handler
  const handleRename = async (newName: string) => {
    if (!renameItem) return;
    setIsProcessing(true);
    try {
      const oldPath = renameItem.path;
      const parentPath = renameItem.type === 'folder'
        ? oldPath.substring(0, oldPath.slice(0, -1).lastIndexOf('/') + 1)
        : oldPath.substring(0, oldPath.lastIndexOf('/') + 1);
      const newPath = parentPath + newName + (renameItem.type === 'folder' ? '/' : '');

      if (renameItem.type === 'folder') {
        const contents = await list({ path: oldPath, options: { listAll: true } });
        for (const item of contents.items) {
          const newItemPath = item.path.replace(oldPath, newPath);
          await copy({
            source: { path: item.path },
            destination: { path: newItemPath },
          });
          await remove({ path: item.path });
        }
      } else {
        await copy({
          source: { path: oldPath },
          destination: { path: newPath },
        });
        await remove({ path: oldPath });
      }

      success(`Renamed to ${newName}`);
      addNotification('Item Renamed', `${renameItem.name} renamed to ${newName}`, 'info', newPath);
      setRenameItem(null);
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      console.error('Rename error:', err);
      showError('Failed to rename');
    } finally {
      setIsProcessing(false);
    }
  };

  // Move/Copy handler for single item
  const handleMoveOrCopy = async (destinationPath: string) => {
    if (!moveItem) return;
    setIsProcessing(true);
    try {
      const { item, mode } = moveItem;
      const newPath = destinationPath + item.name + (item.type === 'folder' ? '/' : '');

      if (item.type === 'folder') {
        const contents = await list({ path: item.path, options: { listAll: true } });
        for (const file of contents.items) {
          const newItemPath = file.path.replace(item.path, newPath);
          await copy({
            source: { path: file.path },
            destination: { path: newItemPath },
          });
          if (mode === 'move') {
            await remove({ path: file.path });
          }
        }
      } else {
        await copy({
          source: { path: item.path },
          destination: { path: newPath },
        });
        if (mode === 'move') {
          await remove({ path: item.path });
        }
      }

      success(`${mode === 'move' ? 'Moved' : 'Copied'} ${item.name}`);
      addNotification(
        mode === 'move' ? 'Item Moved' : 'Item Copied',
        `${item.name} ${mode === 'move' ? 'moved' : 'copied'} to ${destinationPath || 'root'}`,
        mode,
        newPath
      );
      setMoveItem(null);
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      console.error('Move/Copy error:', err);
      showError(`Failed to ${moveItem.mode}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Bulk Move/Copy handler
  const handleBulkMoveOrCopy = async (destinationPath: string) => {
    if (!bulkMoveMode || selectedItems.length === 0) return;
    setIsProcessing(true);
    try {
      for (const item of selectedItems) {
        const newPath = destinationPath + item.name + (item.type === 'folder' ? '/' : '');

        if (item.type === 'folder') {
          const contents = await list({ path: item.path, options: { listAll: true } });
          for (const file of contents.items) {
            const newItemPath = file.path.replace(item.path, newPath);
            await copy({
              source: { path: file.path },
              destination: { path: newItemPath },
            });
            if (bulkMoveMode === 'move') {
              await remove({ path: file.path });
            }
          }
        } else {
          await copy({
            source: { path: item.path },
            destination: { path: newPath },
          });
          if (bulkMoveMode === 'move') {
            await remove({ path: item.path });
          }
        }
      }

      success(`${bulkMoveMode === 'move' ? 'Moved' : 'Copied'} ${selectedItems.length} items`);
      addNotification(
        bulkMoveMode === 'move' ? 'Items Moved' : 'Items Copied',
        `${selectedItems.length} items ${bulkMoveMode === 'move' ? 'moved' : 'copied'} to ${destinationPath || 'root'}`,
        bulkMoveMode
      );
      setBulkMoveMode(null);
      setSelectedItems([]);
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      console.error('Bulk Move/Copy error:', err);
      showError(`Failed to ${bulkMoveMode}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Delete handler for single item
  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setIsProcessing(true);
    try {
      if (deleteConfirm.type === 'folder') {
        const contents = await list({ path: deleteConfirm.path, options: { listAll: true } });
        for (const item of contents.items) {
          await remove({ path: item.path });
        }
      } else {
        await remove({ path: deleteConfirm.path });
      }

      success(`Deleted ${deleteConfirm.name}`);
      addNotification('Item Deleted', `${deleteConfirm.name} has been deleted`, 'delete');
      setDeleteConfirm(null);
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      console.error('Delete error:', err);
      showError('Failed to delete');
    } finally {
      setIsProcessing(false);
    }
  };

  // Bulk delete handler
  const handleBulkDelete = async () => {
    if (selectedItems.length === 0) return;
    setIsProcessing(true);
    try {
      for (const item of selectedItems) {
        if (item.type === 'folder') {
          const contents = await list({ path: item.path, options: { listAll: true } });
          for (const file of contents.items) {
            await remove({ path: file.path });
          }
        } else {
          await remove({ path: item.path });
        }
      }

      success(`Deleted ${selectedItems.length} items`);
      addNotification('Items Deleted', `${selectedItems.length} items have been deleted`, 'delete');
      setBulkDeleteConfirm(false);
      setSelectedItems([]);
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      console.error('Bulk delete error:', err);
      showError('Failed to delete some items');
    } finally {
      setIsProcessing(false);
    }
  };

  // Create folder handler
  const handleCreateFolder = async (folderName: string) => {
    setIsProcessing(true);
    try {
      const basePath = currentPath || folders[0].path;
      const newFolderPath = basePath + folderName + '/.keep';

      // Create a placeholder file to create the folder
      await uploadData({
        path: newFolderPath,
        data: new Blob([''], { type: 'text/plain' }),
      }).result;

      success(`Created folder: ${folderName}`);
      addNotification('Folder Created', `${folderName} has been created`, 'info', basePath + folderName + '/');
      setShowCreateFolder(false);
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      console.error('Create folder error:', err);
      showError('Failed to create folder');
    } finally {
      setIsProcessing(false);
    }
  };

  // Download handler for selected items
  const handleDownloadSelected = async () => {
    if (selectedItems.length === 0) return;

    for (const item of selectedItems) {
      if (item.type === 'folder') {
        info(`Cannot download folder "${item.name}" directly`);
        continue;
      }

      try {
        const result = await getUrl({
          path: item.path,
          options: { expiresIn: 3600 },
        });

        const link = document.createElement('a');
        link.href = result.url.toString();
        link.download = item.name;
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        success(`Downloading ${item.name}`);
        addNotification('File Downloaded', `${item.name} downloaded`, 'download', item.path);
      } catch (err) {
        console.error('Download error:', err);
        showError(`Failed to download ${item.name}`);
      }
    }
  };

  // Upload handler
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const uploadPath = currentPath || folders[0].path;

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
      const path = uploadPath + file.name;

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
        success(`Uploaded ${file.name}`);
      } catch (err) {
        console.error('Upload error:', err);
        setUploads(prev =>
          prev.map(u =>
            u.id === uploadId
              ? { ...u, status: 'error' as const, error: 'Upload failed' }
              : u
          )
        );
        showError(`Failed to upload ${file.name}`);
      }
    }

    setRefreshKey(prev => prev + 1);
    e.target.value = '';
  };

  // File input ref
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Dismiss upload
  const handleDismissUpload = (id: string) => {
    setUploads(prev => prev.filter(u => u.id !== id));
  };

  // Dismiss all uploads
  const handleDismissAllUploads = () => {
    setUploads([]);
  };

  // Refresh
  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1);
  };

  // Preview file handler
  const handlePreview = useCallback((item: FileItem) => {
    if (item.type === 'folder') {
      info('Cannot preview folders');
      return;
    }
    setPreviewFile(item);
  }, [info]);

  // Download preview file handler
  const handleDownloadPreviewFile = async () => {
    if (!previewFile) return;

    try {
      const result = await getUrl({
        path: previewFile.path,
        options: { expiresIn: 3600 },
      });

      const link = document.createElement('a');
      link.href = result.url.toString();
      link.download = previewFile.name;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      success(`Downloading ${previewFile.name}`);
      addNotification('File Downloaded', `${previewFile.name} downloaded`, 'download', previewFile.path);
    } catch (err) {
      console.error('Download error:', err);
      showError(`Failed to download ${previewFile.name}`);
    }
  };

  const breadcrumbs = getBreadcrumbPath();

  return (
    <div className="app-container">
      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleUpload}
      />

      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <button
            className="menu-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle menu"
          >
            <span>☰</span>
          </button>

          <div className="header-logo">H</div>
          <h1 className="header-title">
            Hacienda ERP File Browser
            {environmentName && <span className={`env-badge env-${environmentName.toLowerCase()}`}>{environmentName}</span>}
          </h1>
        </div>

        <div className="header-right">
          {isAdmin && (
            <Link href="/admin" className="admin-link" title="Admin Dashboard">
              <span className="admin-icon">🛡️</span>
              <span className="admin-text">Admin</span>
            </Link>
          )}

          <button
            className="notification-btn"
            onClick={() => setIsNotificationOpen(true)}
            title="Notifications"
          >
            🔔
            {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
          </button>

          {userEmail && (
            <div className="user-info">
              <div className="user-avatar">{getUserInitials(userEmail)}</div>
              <span className="user-email">{userEmail}</span>
            </div>
          )}
          <Button
            className="sign-out-btn"
            size="small"
            onClick={() => signOut()}
          >
            Sign Out
          </Button>
        </div>
      </header>

      <div className="app-body">
        {/* Mobile overlay */}
        <div
          className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />

        {/* Sidebar */}
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>

          <h2 className="sidebar-title">Folders</h2>
          <nav>
            <ul className="sidebar-nav">
              <li className="sidebar-item">
                <button
                  className={`sidebar-link ${!currentPath ? 'active' : ''}`}
                  onClick={() => handleFolderClick('')}
                  data-folder="default"
                >
                  <span className="sidebar-icon">🏠</span>
                  <span>All Folders</span>
                </button>
              </li>
              {folders.map((folder) => (
                <li key={folder.path} className="sidebar-item">
                  <button
                    className={`sidebar-link ${currentPath.startsWith(folder.path) ? 'active' : ''}`}
                    onClick={() => handleFolderClick(folder.path)}
                    data-folder={folder.type}
                  >
                    <span className="sidebar-icon">{folder.icon}</span>
                    <span>{folder.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <h2 className="sidebar-title quick-links-title">Quick Links</h2>
          <nav>
            <ul className="sidebar-nav">
              {quickLinks.map((link) => (
                <li key={link.id} className="sidebar-item quick-link-item">
                  <button
                    className={`sidebar-link ${currentPath === link.path ? 'active' : ''}`}
                    onClick={() => handleFolderClick(link.path)}
                    data-folder="quicklink"
                  >
                    <span className="sidebar-icon">⭐</span>
                    <span>{link.name}</span>
                  </button>
                  <button
                    className="quick-link-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteQuickLink(link.id);
                    }}
                    title="Remove quick link"
                  >
                    ×
                  </button>
                </li>
              ))}
              <li className="sidebar-item">
                <button
                  className="sidebar-link add-quick-link"
                  onClick={() => setShowAddModal(true)}
                >
                  <span className="sidebar-icon">➕</span>
                  <span>Add Quick Link</span>
                </button>
              </li>
            </ul>
          </nav>
        </aside>

        {/* Main Content */}
        <main className={`main-content ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          {/* Breadcrumb */}
          <div className="breadcrumb">
            <span className="breadcrumb-item">
              <button
                className="breadcrumb-link"
                onClick={() => handleFolderClick('')}
              >
                Home
              </button>
            </span>
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={crumb.path}>
                <span className="breadcrumb-separator">/</span>
                {index === breadcrumbs.length - 1 ? (
                  <span className="breadcrumb-current">{crumb.name}</span>
                ) : (
                  <button
                    className="breadcrumb-link"
                    onClick={() => handleFolderClick(crumb.path)}
                  >
                    {crumb.name}
                  </button>
                )}
              </React.Fragment>
            ))}
            {currentPath && (
              <>
                <button
                  className="breadcrumb-menu-btn"
                  onClick={() => setShowContextMenu(!showContextMenu)}
                  title="More options"
                >
                  ⋮
                </button>
                {showContextMenu && (
                  <div className="context-menu">
                    <button
                      className="context-menu-item"
                      onClick={handleAddCurrentAsQuickLink}
                    >
                      <span>⭐</span>
                      <span>Add to Quick Links</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Toolbar */}
          <Toolbar
            selectedCount={selectedItems.length}
            onUpload={() => fileInputRef.current?.click()}
            onDownload={handleDownloadSelected}
            onDelete={() => setBulkDeleteConfirm(true)}
            onMoveTo={() => setBulkMoveMode('move')}
            onCopyTo={() => setBulkMoveMode('copy')}
            onRefresh={handleRefresh}
            onCreateFolder={() => setShowCreateFolder(true)}
            isProcessing={isProcessing}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortOption={sortOption}
            onSortChange={setSortOption}
            searchScope={searchScope}
            onSearchScopeChange={setSearchScope}
            currentFolderName={getCurrentFolderName()}
          />

          {/* Custom File Browser */}
          <div className="storage-browser-wrapper">
            <CustomFileBrowser
              currentPath={currentPath || ''}
              onNavigate={handleNavigate}
              onRename={(item) => setRenameItem(item)}
              onMove={(item, mode) => setMoveItem({ item, mode })}
              onDelete={(item) => setDeleteConfirm(item)}
              onPreview={handlePreview}
              onUpload={() => fileInputRef.current?.click()}
              onSelectionChange={handleSelectionChange}
              refreshKey={refreshKey}
              showToast={showToast}
              addNotification={addNotification}
              searchQuery={searchQuery}
              sortOption={sortOption}
              searchScope={searchScope}
            />
          </div>
        </main>
      </div>

      {/* Add Quick Link Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add Quick Link</h3>
              <button
                className="modal-close"
                onClick={() => setShowAddModal(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="linkPath">Folder Path</label>
                <input
                  id="linkPath"
                  type="text"
                  placeholder="e.g., ConversionFiles/Reports/"
                  value={newLinkPath}
                  onChange={(e) => setNewLinkPath(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddQuickLink()}
                />
              </div>
              <div className="form-group">
                <label htmlFor="linkName">Display Name (optional)</label>
                <input
                  id="linkName"
                  type="text"
                  placeholder="e.g., Reports"
                  value={newLinkName}
                  onChange={(e) => setNewLinkName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddQuickLink()}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowAddModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleAddQuickLink}
                disabled={!newLinkPath.trim()}
              >
                Add Quick Link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Click outside to close context menu */}
      {showContextMenu && (
        <div
          className="context-menu-overlay"
          onClick={() => setShowContextMenu(false)}
        />
      )}

      {/* Create Folder Modal */}
      <CreateFolderModal
        isOpen={showCreateFolder}
        onClose={() => setShowCreateFolder(false)}
        onCreate={handleCreateFolder}
        isLoading={isProcessing}
      />

      {/* Rename Modal */}
      <RenameModal
        isOpen={!!renameItem}
        onClose={() => setRenameItem(null)}
        onRename={handleRename}
        currentName={renameItem?.name || ''}
        itemType={renameItem?.type || 'file'}
        isLoading={isProcessing}
      />

      {/* Move/Copy Modal for single item */}
      {moveItem && (
        <MoveToModal
          isOpen={!!moveItem}
          onClose={() => setMoveItem(null)}
          onMove={handleMoveOrCopy}
          itemName={moveItem.item.name}
          itemType={moveItem.item.type}
          currentPath={currentPath}
          availableFolders={availableFolders}
          mode={moveItem.mode}
          isLoading={isProcessing}
        />
      )}

      {/* Move/Copy Modal for bulk selection */}
      {bulkMoveMode && (
        <MoveToModal
          isOpen={!!bulkMoveMode}
          onClose={() => setBulkMoveMode(null)}
          onMove={handleBulkMoveOrCopy}
          itemName={`${selectedItems.length} items`}
          itemType="file"
          currentPath={currentPath}
          availableFolders={availableFolders}
          mode={bulkMoveMode}
          isLoading={isProcessing}
        />
      )}

      {/* Delete Confirmation for single item */}
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

      {/* Delete Confirmation for bulk selection */}
      <ConfirmDialog
        isOpen={bulkDeleteConfirm}
        onClose={() => setBulkDeleteConfirm(false)}
        onConfirm={handleBulkDelete}
        title="Delete Items"
        message={`Are you sure you want to delete ${selectedItems.length} items? This action cannot be undone.`}
        confirmText="Delete All"
        isDangerous
        isLoading={isProcessing}
      />

      {/* File Preview Modal */}
      <FilePreviewModal
        isOpen={!!previewFile}
        onClose={() => setPreviewFile(null)}
        file={previewFile}
        onDownload={handleDownloadPreviewFile}
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
          handleFolderClick(parentPath);
        }}
      />

      {/* Toasts */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

export default withAuthenticator(FileBrowser);
