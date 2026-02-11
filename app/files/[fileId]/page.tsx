'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { signOut, fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import { getUrl } from 'aws-amplify/storage';
import '@aws-amplify/ui-react/styles.css';
import '../../components/enhanced-file-browser.css';
import './shared-file.css';
import config from '../../../amplify_outputs.json';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  isAdminUser,
  extractSourceFromPath,
  getUserPermissions,
  SourceTag,
} from '../../admin/types';
import { decodeShareableFileId, getSharedFileInfo } from '../../lib/shareableLinks';

Amplify.configure(config);

interface FileInfo {
  path: string;
  name: string;
  source?: string;
}

function SharedFilePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileId = params.fileId as string;

  const [userEmail, setUserEmail] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  // Check user and fetch file
  useEffect(() => {
    async function checkUserAndLoadFile() {
      try {
        // Get user info
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';
        setUserEmail(email);

        // Decode file ID to get path
        const sharedInfo = getSharedFileInfo(fileId);
        if (!sharedInfo) {
          setError('Invalid or expired share link');
          setIsLoading(false);
          return;
        }

        const { path, name } = sharedInfo;
        const source = extractSourceFromPath(path);

        setFileInfo({ path, name, source: source || undefined });

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
          // Get signed URL for the file
          const urlResult = await getUrl({
            path: path,
            options: { expiresIn: 3600 }, // 1 hour
          });
          setFileUrl(urlResult.url.toString());
        }
      } catch (err) {
        console.error('Error loading shared file:', err);
        setError('Failed to load the shared file');
      } finally {
        setIsLoading(false);
      }
    }

    checkUserAndLoadFile();
  }, [fileId]);

  // Handle download
  const handleDownload = async () => {
    if (!fileUrl || !fileInfo) return;

    try {
      const response = await fetch(fileUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileInfo.name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download error:', err);
    }
  };

  // Get file type for preview
  const getFileType = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    if (['mp4', 'webm', 'ogg', 'mov'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'ogg', 'aac', 'm4a'].includes(ext)) return 'audio';
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'office';
    if (['txt', 'md', 'json', 'xml', 'csv'].includes(ext)) return 'text';
    return 'other';
  };

  if (isLoading) {
    return (
      <div className="shared-file-loading">
        <div className="spinner"></div>
        <p>Loading file...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="shared-file-error">
        <div className="error-icon">⚠️</div>
        <h1>Unable to Load File</h1>
        <p>{error}</p>
        <Link href="/" className="btn btn-primary">
          Go to File Browser
        </Link>
      </div>
    );
  }

  if (!hasPermission) {
    return (
      <div className="shared-file-error">
        <div className="error-icon">🔒</div>
        <h1>Access Denied</h1>
        <p>You don't have permission to view this file.</p>
        {fileInfo?.source && (
          <p className="error-detail">
            This file requires access to the <strong>{fileInfo.source}</strong> data source.
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

  const fileType = fileInfo ? getFileType(fileInfo.name) : 'other';

  return (
    <div className="shared-file-container">
      <header className="shared-file-header">
        <Link href="/" className="back-link">
          <span>←</span> Back to Files
        </Link>
        <div className="header-info">
          <h1>{fileInfo?.name}</h1>
          {fileInfo?.source && (
            <span className="source-badge">{fileInfo.source}</span>
          )}
        </div>
        <div className="header-actions">
          <span className="user-email">{userEmail}</span>
          <button onClick={() => signOut()} className="btn btn-ghost">
            Sign Out
          </button>
        </div>
      </header>

      <main className="shared-file-main">
        <div className="file-preview-container">
          {fileType === 'image' && fileUrl && (
            <img src={fileUrl} alt={fileInfo?.name} className="preview-image" />
          )}

          {fileType === 'pdf' && fileUrl && (
            <iframe
              src={fileUrl}
              className="preview-pdf"
              title={fileInfo?.name}
            />
          )}

          {fileType === 'video' && fileUrl && (
            <video controls className="preview-video">
              <source src={fileUrl} />
              Your browser does not support the video tag.
            </video>
          )}

          {fileType === 'audio' && fileUrl && (
            <div className="preview-audio-container">
              <div className="audio-icon">🎵</div>
              <p>{fileInfo?.name}</p>
              <audio controls className="preview-audio">
                <source src={fileUrl} />
                Your browser does not support the audio tag.
              </audio>
            </div>
          )}

          {fileType === 'office' && fileUrl && (
            <div className="preview-office">
              <iframe
                src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`}
                className="office-iframe"
                title={fileInfo?.name}
              />
            </div>
          )}

          {(fileType === 'text' || fileType === 'other') && (
            <div className="preview-unsupported">
              <div className="file-icon">📄</div>
              <p>{fileInfo?.name}</p>
              <p className="preview-note">
                Preview not available for this file type.
              </p>
            </div>
          )}
        </div>

        <div className="file-actions">
          <button onClick={handleDownload} className="btn btn-primary btn-lg">
            <span>⬇️</span> Download File
          </button>
          <Link href="/" className="btn btn-secondary btn-lg">
            Browse All Files
          </Link>
        </div>
      </main>
    </div>
  );
}

export default withAuthenticator(SharedFilePage);
