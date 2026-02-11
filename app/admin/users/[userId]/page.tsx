'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../../admin.css';
import './user-detail.css';
import config from '../../../../amplify_outputs.json';
import {
  isAdminUser,
  CognitoUser,
  SOURCE_TAGS,
  SourceTag,
  getUserPermissions,
  saveUserPermissions,
} from '../../types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';

Amplify.configure(config);

// Lambda Function URLs
const APPROVAL_HANDLER_URL = 'https://w47wliqar3ka27qsezzckqpoza0kkmbt.lambda-url.us-east-1.on.aws/';
const APPROVAL_TOKEN = 'hacienda-erp-approval-2024';

function UserDetailPage() {
  const params = useParams();
  const router = useRouter();
  const userId = params.userId as string;

  const [adminEmail, setAdminEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<CognitoUser | null>(null);
  const [selectedSources, setSelectedSources] = useState<SourceTag[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isApproved, setIsApproved] = useState(false);

  // Check admin status
  useEffect(() => {
    async function checkAdmin() {
      try {
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';
        setAdminEmail(email);
        setIsAdmin(isAdminUser(email));
      } catch (error) {
        console.error('Error checking admin status:', error);
      }
    }
    checkAdmin();
  }, []);

  // Fetch user data
  const fetchUserData = useCallback(async () => {
    if (!userId) return;

    try {
      const response = await fetch(
        `${APPROVAL_HANDLER_URL}?action=list&token=${encodeURIComponent(APPROVAL_TOKEN)}`
      );

      if (response.ok) {
        const data = await response.json();
        const foundUser = data.users?.find(
          (u: CognitoUser) => u.username === userId || u.email === decodeURIComponent(userId)
        );

        if (foundUser) {
          setUser(foundUser);

          // Check if user is approved
          const approvedEmails = (data.approvedEmails || []).map((e: string) => e.toLowerCase());
          setIsApproved(approvedEmails.includes(foundUser.email.toLowerCase()));

          // Load existing permissions
          const permissions = getUserPermissions(foundUser.email);
          if (permissions) {
            setSelectedSources(permissions.allowedSources);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (isAdmin) {
      fetchUserData();
    } else if (!isLoading && !isAdmin && adminEmail) {
      // Not an admin, stop loading
      setIsLoading(false);
    }
  }, [isAdmin, adminEmail, fetchUserData, isLoading]);

  // Handle source toggle
  const handleSourceToggle = (source: SourceTag) => {
    setSelectedSources(prev =>
      prev.includes(source)
        ? prev.filter(s => s !== source)
        : [...prev, source]
    );
    setSaveMessage(null);
  };

  // Handle select all
  const handleSelectAll = () => {
    setSelectedSources([...SOURCE_TAGS]);
    setSaveMessage(null);
  };

  // Handle clear all
  const handleClearAll = () => {
    setSelectedSources([]);
    setSaveMessage(null);
  };

  // Save permissions
  const handleSave = async () => {
    if (!user) return;

    setIsSaving(true);
    setSaveMessage(null);

    try {
      saveUserPermissions(user.email, selectedSources, adminEmail);
      setSaveMessage({ type: 'success', text: 'Permissions saved successfully!' });
    } catch (error) {
      console.error('Error saving permissions:', error);
      setSaveMessage({ type: 'error', text: 'Failed to save permissions. Please try again.' });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="admin-loading">
        <div className="admin-spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="admin-access-denied">
        <div className="access-denied-card">
          <div className="access-denied-icon">🚫</div>
          <h1>Access Denied</h1>
          <p>You do not have permission to access user details.</p>
          <div className="access-denied-actions">
            <Link href="/" className="btn btn-secondary">
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="admin-container">
        <header className="admin-header">
          <div className="admin-header-left">
            <Link href="/admin" className="admin-back-link">
              <span className="back-icon">←</span>
              Back to Admin
            </Link>
            <h1>User Not Found</h1>
          </div>
        </header>
        <main className="admin-main">
          <div className="user-not-found">
            <p>The requested user could not be found.</p>
            <Link href="/admin" className="btn btn-primary">
              Return to Admin Dashboard
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="admin-container">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-header-left">
          <Link href="/admin" className="admin-back-link">
            <span className="back-icon">←</span>
            Back to Admin
          </Link>
          <h1>User Details</h1>
        </div>
        <div className="admin-header-right">
          <span className="admin-user-email">{adminEmail}</span>
        </div>
      </header>

      <main className="admin-main">
        {/* User Info Card */}
        <div className="user-detail-card">
          <div className="user-detail-header">
            <div className="user-avatar-large">
              {user.email.charAt(0).toUpperCase()}
            </div>
            <div className="user-detail-info">
              <h2>{user.email}</h2>
              <div className="user-meta">
                <span className={`status-badge ${isApproved ? 'approved' : 'pending'}`}>
                  {isApproved ? 'Approved' : 'Pending Approval'}
                </span>
                <span className={`status-tag ${user.status.toLowerCase()}`}>
                  {user.status}
                </span>
                {isAdminUser(user.email) && (
                  <span className="admin-badge">Admin</span>
                )}
              </div>
            </div>
          </div>

          <div className="user-detail-body">
            <div className="detail-section">
              <h3>Account Information</h3>
              <div className="detail-grid">
                <div className="detail-item">
                  <label>Username</label>
                  <span>{user.username}</span>
                </div>
                <div className="detail-item">
                  <label>Email</label>
                  <span>{user.email}</span>
                </div>
                <div className="detail-item">
                  <label>Email Verified</label>
                  <span>{user.emailVerified ? 'Yes' : 'No'}</span>
                </div>
                <div className="detail-item">
                  <label>Account Created</label>
                  <span>{new Date(user.created).toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <label>Last Modified</label>
                  <span>{new Date(user.lastModified).toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <label>Enabled</label>
                  <span>{user.enabled ? 'Yes' : 'No'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Source Permissions Card */}
        <div className="user-detail-card">
          <div className="permissions-header">
            <h3>Source Access Permissions</h3>
            <p className="permissions-description">
              Select which data sources this user can access. Files are organized by source tags
              (e.g., PRIFAS, HACIENDA). Users will only see files from their permitted sources.
            </p>
            {isAdminUser(user.email) && (
              <div className="admin-notice">
                <span className="notice-icon">ℹ️</span>
                <span>Admin users automatically have access to all sources.</span>
              </div>
            )}
          </div>

          <div className="permissions-actions">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={handleSelectAll}
            >
              Select All
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={handleClearAll}
            >
              Clear All
            </button>
            <span className="selected-count">
              {selectedSources.length} of {SOURCE_TAGS.length} selected
            </span>
          </div>

          <div className="permissions-grid">
            {SOURCE_TAGS.map(source => (
              <label key={source} className="permission-item">
                <input
                  type="checkbox"
                  checked={selectedSources.includes(source)}
                  onChange={() => handleSourceToggle(source)}
                  disabled={isAdminUser(user.email)}
                />
                <span className="permission-label">
                  <span className="source-name">{source}</span>
                  <span className="source-path">
                    e.g., Data Validation/MOCK 8/FIN/AP Invoices/{source}/
                  </span>
                </span>
              </label>
            ))}
          </div>

          {saveMessage && (
            <div className={`save-message ${saveMessage.type}`}>
              {saveMessage.type === 'success' ? '✓' : '✗'} {saveMessage.text}
            </div>
          )}

          <div className="permissions-footer">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={isSaving || isAdminUser(user.email)}
            >
              {isSaving ? 'Saving...' : 'Save Permissions'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => router.push('/admin')}
            >
              Cancel
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default withAuthenticator(UserDetailPage);
