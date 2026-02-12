'use client';

import React, { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
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

/**
 * Shared Folder Page
 *
 * This page handles shareable folder links. When a user visits a shared link:
 * 1. They are authenticated (via withAuthenticator)
 * 2. Their permissions are checked
 * 3. If authorized, they are redirected to the main file browser at the folder's location
 */
function SharedFolderPage() {
  const params = useParams();
  const router = useRouter();
  const folderId = params.folderId as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [folderSource, setFolderSource] = useState<string | null>(null);

  useEffect(() => {
    async function checkUserAndRedirect() {
      try {
        // Get user info
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';

        // Decode folder ID to get path
        const sharedInfo = getSharedFolderInfo(folderId);
        if (!sharedInfo) {
          setError('Invalid or expired share link');
          setIsLoading(false);
          return;
        }

        const { path } = sharedInfo;
        const source = extractSourceFromPath(path);
        setFolderSource(source);

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

        if (!canAccess) {
          setError('access_denied');
          setIsLoading(false);
          return;
        }

        // Redirect to main file browser at the folder path
        router.replace(`/?path=${encodeURIComponent(path)}`);

      } catch (err) {
        console.error('Error processing shared folder link:', err);
        setError('Failed to process the shared folder link');
        setIsLoading(false);
      }
    }

    checkUserAndRedirect();
  }, [folderId, router]);

  if (isLoading) {
    return (
      <div className="shared-folder-loading">
        <div className="spinner"></div>
        <p>Loading folder...</p>
      </div>
    );
  }

  if (error === 'access_denied') {
    return (
      <div className="shared-folder-error">
        <div className="error-icon">🔒</div>
        <h1>Access Denied</h1>
        <p>You don't have permission to view this folder.</p>
        {folderSource && (
          <p className="error-detail">
            This folder requires access to the <strong>{folderSource}</strong> data source.
            Please contact an administrator to request access.
          </p>
        )}
        <div className="error-actions">
          <Link href="/" className="btn btn-primary">
            Go to File Browser
          </Link>
        </div>
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

  return null;
}

export default withAuthenticator(SharedFolderPage);
