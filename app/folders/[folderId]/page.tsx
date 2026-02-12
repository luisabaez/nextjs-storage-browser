'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { signOut, fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import { list, getUrl } from 'aws-amplify/storage';
import '@aws-amplify/ui-react/styles.css';
import '../../components/enhanced-file-browser.css';
import './shared-folder.css';
import config from '../../../amplify_outputs.json';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  isAdminUser,
  extractSourceFromPath,
  getUserPermissions,
  SourceTag,
} from '../../admin/types';
import { getSharedFolderInfo } from '../../lib/shareableLinks';

Amplify.configure(config);

interface FolderInfo {
  path: string;
  name: string;
  source?: string;
}

interface FileItem {
  key: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  lastModified?: Date;
  path: string;
}

function SharedFolderPage() {
  const params = useParams();
  const router = useRouter();
  const folderId = params.folderId as string;

  const [userEmail, setUserEmail] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [folderInfo, setFolderInfo] = useState<FolderInfo | null>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  // Check user and fetch folder contents
  useEffect(() => {
    async function checkUserAndLoadFolder() {
      try {
        // Get user info
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';
        setUserEmail(email);

        // Decode folder ID to get path
        const sharedInfo = getSharedFolderInfo(folderId);
        if (!sharedInfo) {
          setError('Invalid or expired share link');
          setIsLoading(false);
          return;
        }

        const { path, name } = sharedInfo;
        const source = extractSourceFromPath(path);

        setFolderInfo({ path, name, source: source || undefined });

        // Check permissions
        const isAdmin = isAdminUser(email);
        let canAccess = isAdmin;

        if (!isAdmin && source) {
          const permissions = getUserPermissions(email);
          canAccess = permissions?.allowedSources.includes(source as SourceTag) || false;
        } else if (!source) {
          // No source tag means accessible to all authenticated users
          canAccess = true;
        }

        setHasPermission(canAccess);

        if (canAccess) {
          // Fetch folder contents
          const result = await list({
            path: path,
            options: { listAll: true },
          });

          const fileItems: FileItem[] = [];
          const seenFolders = new Set<string>();

          for (const item of result.items) {
            const relativePath = item.path.replace(path, '');
            const parts = relativePath.split('/').filter(Boolean);

            if (parts.length === 0) continue;

            if (parts.length === 1) {
              // Direct file in folder
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
              const folderPath = path + folderName + '/';
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

          // Sort: folders first, then by name
          fileItems.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name);
          });

          setItems(fileItems);
        }
      } catch (err) {
        console.error('Error loading shared folder:', err);
        setError('Failed to load the shared folder');
      } finally {
        setIsLoading(false);
      }
    }

    checkUserAndLoadFolder();
  }, [folderId]);

  // Handle file download
  const handleDownload = async (item: FileItem) => {
    if (item.type === 'folder') return;

    try {
      const urlResult = await getUrl({
        path: item.path,
        options: { expiresIn: 3600 },
      });

      const response = await fetch(urlResult.url.toString());
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download error:', err);
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
      default: return '📄';
    }
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
    });
  };

  if (isLoading) {
    return (
      <div className="shared-folder-loading">
        <div className="spinner"></div>
        <p>Loading folder...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="shared-folder-error">
        <div className="error-icon">⚠️</div>
        <h1>Unable to Load Folder</h1>
        <p>{error}</p>
        <Link href="/" className="btn btn-primary">
          Go to File Browser
        </Link>
      </div>
    );
  }

  if (!hasPermission) {
    return (
      <div className="shared-folder-error">
        <div className="error-icon">🔒</div>
        <h1>Access Denied</h1>
        <p>You don't have permission to view this folder.</p>
        {folderInfo?.source && (
          <p className="error-detail">
            This folder requires access to the <strong>{folderInfo.source}</strong> data source.
            Please contact an administrator to request access.
          </p>
        )}
        <div className="error-actions">
          <Link href="/" className="btn btn-primary">
            Go to File Browser
          </Link>
          <button onClick={() => signOut()} className="btn btn-secondary">
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shared-folder-container">
      <header className="shared-folder-header">
        <Link href="/" className="back-link">
          <span>←</span> Back to Files
        </Link>
        <div className="header-info">
          <h1>📁 {folderInfo?.name}</h1>
          {folderInfo?.source && (
            <span className="source-badge">{folderInfo.source}</span>
          )}
        </div>
        <div className="header-actions">
          <span className="user-email">{userEmail}</span>
          <button onClick={() => signOut()} className="btn btn-ghost">
            Sign Out
          </button>
        </div>
      </header>

      <main className="shared-folder-main">
        <div className="folder-info-bar">
          <span className="folder-path">{folderInfo?.path}</span>
          <span className="item-count">{items.length} items</span>
        </div>

        {items.length === 0 ? (
          <div className="empty-folder">
            <div className="empty-icon">📂</div>
            <p>This folder is empty</p>
          </div>
        ) : (
          <div className="folder-contents">
            <table className="file-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Modified</th>
                  <th>Size</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key} className={`file-row ${item.type}`}>
                    <td className="name-cell">
                      <span className="file-icon">{getFileIcon(item)}</span>
                      <span className="file-name">{item.name}</span>
                    </td>
                    <td className="date-cell">{formatDate(item.lastModified)}</td>
                    <td className="size-cell">
                      {item.type === 'folder' ? '-' : formatSize(item.size)}
                    </td>
                    <td className="actions-cell">
                      {item.type === 'file' && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => handleDownload(item)}
                        >
                          ⬇️ Download
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="folder-actions">
          <Link href="/" className="btn btn-primary btn-lg">
            Browse All Files
          </Link>
        </div>
      </main>
    </div>
  );
}

export default withAuthenticator(SharedFolderPage);
