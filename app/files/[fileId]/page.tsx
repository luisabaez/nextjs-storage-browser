'use client';

import React, { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../../components/enhanced-file-browser.css';
import './shared-file.css';
import config from '../../../amplify_outputs.json';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  isAdminUser,
  extractSourceFromPath,
  getUserPermissions,
  SourceTag,
} from '../../admin/types';
import { getSharedFileInfo } from '../../lib/shareableLinks';

Amplify.configure(config);

/**
 * Shared File Page
 *
 * This page handles shareable file links. When a user visits a shared link:
 * 1. They are authenticated (via withAuthenticator)
 * 2. Their permissions are checked
 * 3. If authorized, they are redirected to the main file browser at the file's location
 *    with a query parameter to trigger file preview
 */
function SharedFilePage() {
  const params = useParams();
  const router = useRouter();
  const fileId = params.fileId as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileSource, setFileSource] = useState<string | null>(null);

  useEffect(() => {
    async function checkUserAndRedirect() {
      try {
        // Get user info
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';

        // Decode file ID to get path
        const sharedInfo = getSharedFileInfo(fileId);
        if (!sharedInfo) {
          setError('Invalid or expired share link');
          setIsLoading(false);
          return;
        }

        const { path, name } = sharedInfo;
        const source = extractSourceFromPath(path);
        setFileSource(source);

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

        // Get the parent folder path for navigation
        const parentPath = path.substring(0, path.lastIndexOf('/') + 1);

        // Redirect to main file browser with the file path
        // The preview query param will trigger the file preview modal
        const encodedPath = encodeURIComponent(path);
        router.replace(`/?path=${encodeURIComponent(parentPath)}&preview=${encodedPath}`);

      } catch (err) {
        console.error('Error processing shared file link:', err);
        setError('Failed to process the shared file link');
        setIsLoading(false);
      }
    }

    checkUserAndRedirect();
  }, [fileId, router]);

  if (isLoading) {
    return (
      <div className="shared-file-loading">
        <div className="spinner"></div>
        <p>Loading file...</p>
      </div>
    );
  }

  if (error === 'access_denied') {
    return (
      <div className="shared-file-error">
        <div className="error-icon">🔒</div>
        <h1>Access Denied</h1>
        <p>You don't have permission to view this file.</p>
        {fileSource && (
          <p className="error-detail">
            This file requires access to the <strong>{fileSource}</strong> data source.
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

  return null;
}

export default withAuthenticator(SharedFilePage);
