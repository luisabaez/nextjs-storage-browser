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
  MOCK_TAGS,
  getAllEntityTags,
  addDynamicEntityTag,
  getAllBusinessUnitTags,
  addDynamicBusinessUnitTag,
  getUserPermissions,
  saveUserFullPermissions,
  pushPermissionsToBackend,
  fetchPermissionsFromBackend,
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
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isApproved, setIsApproved] = useState(false);

  // Permission states
  const [selectedIsAdmin, setSelectedIsAdmin] = useState(false);
  const [selectedSources, setSelectedSources] = useState<SourceTag[]>([]);
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [selectedMocks, setSelectedMocks] = useState<string[]>([]);
  const [selectedBusinessUnits, setSelectedBusinessUnits] = useState<string[]>([]);

  // Entity tags (can be dynamic)
  const [entityTags, setEntityTags] = useState<string[]>([]);
  const [newEntityTag, setNewEntityTag] = useState('');
  const [showAddEntity, setShowAddEntity] = useState(false);

  // Business Unit tags (can be dynamic)
  const [businessUnitTags, setBusinessUnitTags] = useState<string[]>([]);
  const [newBUTag, setNewBUTag] = useState('');
  const [showAddBU, setShowAddBU] = useState(false);

  // Active tab for permissions
  const [activeTab, setActiveTab] = useState<'source' | 'entity' | 'mock' | 'businessUnit'>('source');

  // Load entity and business unit tags
  useEffect(() => {
    setEntityTags(getAllEntityTags());
    setBusinessUnitTags(getAllBusinessUnitTags());
  }, []);

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

          // Load existing permissions — prefer the backend (source of truth),
          // fall back to the local cache if the backend has no record yet.
          const permissions =
            (await fetchPermissionsFromBackend(foundUser.email)) || getUserPermissions(foundUser.email);
          if (permissions) {
            setSelectedIsAdmin(!!permissions.isAdmin);
            setSelectedSources(permissions.allowedSources || []);
            setSelectedEntities(permissions.allowedEntities || []);
            setSelectedMocks(permissions.allowedMocks || []);
            setSelectedBusinessUnits(permissions.allowedBusinessUnits || []);
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
      setIsLoading(false);
    }
  }, [isAdmin, adminEmail, fetchUserData, isLoading]);

  // Toggle handlers
  const handleSourceToggle = (source: SourceTag) => {
    setSelectedSources(prev =>
      prev.includes(source) ? prev.filter(s => s !== source) : [...prev, source]
    );
    setSaveMessage(null);
  };

  const handleEntityToggle = (entity: string) => {
    setSelectedEntities(prev =>
      prev.includes(entity) ? prev.filter(e => e !== entity) : [...prev, entity]
    );
    setSaveMessage(null);
  };

  const handleMockToggle = (mock: string) => {
    setSelectedMocks(prev =>
      prev.includes(mock) ? prev.filter(m => m !== mock) : [...prev, mock]
    );
    setSaveMessage(null);
  };

  const handleBusinessUnitToggle = (unit: string) => {
    setSelectedBusinessUnits(prev =>
      prev.includes(unit) ? prev.filter(u => u !== unit) : [...prev, unit]
    );
    setSaveMessage(null);
  };

  // Select/Clear all handlers
  const handleSelectAllSources = () => {
    setSelectedSources([...SOURCE_TAGS]);
    setSaveMessage(null);
  };

  const handleClearAllSources = () => {
    setSelectedSources([]);
    setSaveMessage(null);
  };

  const handleSelectAllEntities = () => {
    setSelectedEntities([...entityTags]);
    setSaveMessage(null);
  };

  const handleClearAllEntities = () => {
    setSelectedEntities([]);
    setSaveMessage(null);
  };

  const handleSelectAllMocks = () => {
    setSelectedMocks([...MOCK_TAGS]);
    setSaveMessage(null);
  };

  const handleClearAllMocks = () => {
    setSelectedMocks([]);
    setSaveMessage(null);
  };

  const handleSelectAllBusinessUnits = () => {
    setSelectedBusinessUnits([...businessUnitTags]);
    setSaveMessage(null);
  };

  const handleClearAllBusinessUnits = () => {
    setSelectedBusinessUnits([]);
    setSaveMessage(null);
  };

  // Add new entity tag
  const handleAddEntityTag = () => {
    if (!newEntityTag.trim()) return;
    addDynamicEntityTag(newEntityTag.trim());
    setEntityTags(getAllEntityTags());
    setNewEntityTag('');
    setShowAddEntity(false);
  };

  // Add new business unit tag
  const handleAddBUTag = () => {
    if (!newBUTag.trim()) return;
    addDynamicBusinessUnitTag(newBUTag.trim());
    setBusinessUnitTags(getAllBusinessUnitTags());
    setNewBUTag('');
    setShowAddBU(false);
  };

  // Save permissions
  const handleSave = async () => {
    if (!user) return;

    setIsSaving(true);
    setSaveMessage(null);

    try {
      const perms = {
        isAdmin: selectedIsAdmin,
        allowedSources: selectedSources,
        allowedEntities: selectedEntities,
        allowedMocks: selectedMocks,
        allowedBusinessUnits: selectedBusinessUnits,
      };
      // Write to the backend (source of truth, cross-device) first, then cache locally.
      const ok = await pushPermissionsToBackend(user.email, perms, adminEmail);
      if (!ok) throw new Error('backend write failed');
      saveUserFullPermissions(user.email, perms, adminEmail);
      setSaveMessage({
        type: 'success',
        text: selectedIsAdmin
          ? 'User saved as admin — they now have full access on any device the next time they sign in.'
          : 'Permissions saved. They apply on the user’s next sign-in, on any device.',
      });
    } catch (error) {
      console.error('Error saving permissions:', error);
      setSaveMessage({ type: 'error', text: 'Failed to save permissions to the server. Please try again.' });
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

  const isUserAdmin = isAdminUser(user.email);

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
                {isUserAdmin && (
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

        {/* Permissions Card */}
        <div className="user-detail-card">
          <div className="permissions-header">
            <h3>Access Permissions</h3>
            <p className="permissions-description">
              Configure which data sources, entities, mock numbers, and business units this user can access.
              Users will only see files matching their permitted tags.
            </p>
            {isUserAdmin && (
              <div className="admin-notice">
                <span className="notice-icon">ℹ️</span>
                <span>Admin users automatically have access to all permissions.</span>
              </div>
            )}
          </div>

          {/* Admin Toggle — grants full access, bypasses all other checks */}
          <div className="admin-toggle-section">
            <label className={`admin-toggle ${selectedIsAdmin ? 'is-admin' : ''}`}>
              <input
                type="checkbox"
                checked={selectedIsAdmin || isUserAdmin}
                disabled={isUserAdmin}
                onChange={(e) => {
                  setSelectedIsAdmin(e.target.checked);
                  setSaveMessage(null);
                }}
              />
              <div className="admin-toggle-content">
                <div className="admin-toggle-title">
                  <span className="admin-toggle-icon">🛡️</span>
                  Grant Admin Access
                </div>
                <div className="admin-toggle-description">
                  {isUserAdmin
                    ? 'This user is a built-in admin and cannot be revoked here.'
                    : selectedIsAdmin
                      ? 'User will have full access to all data and the admin dashboard. All other permission settings below are bypassed.'
                      : 'Check this box to give the user full access to everything in the application (all sources, entities, mocks, business units, and admin dashboard).'}
                </div>
              </div>
            </label>
          </div>

          {/* Permission Tabs */}
          <div className="permission-tabs">
            <button
              className={`permission-tab ${activeTab === 'source' ? 'active' : ''}`}
              onClick={() => setActiveTab('source')}
            >
              Sources
              <span className="tab-count">{selectedSources.length}/{SOURCE_TAGS.length}</span>
            </button>
            <button
              className={`permission-tab ${activeTab === 'entity' ? 'active' : ''}`}
              onClick={() => setActiveTab('entity')}
            >
              Data Entities
              <span className="tab-count">{selectedEntities.length}/{entityTags.length}</span>
            </button>
            <button
              className={`permission-tab ${activeTab === 'mock' ? 'active' : ''}`}
              onClick={() => setActiveTab('mock')}
            >
              Mock Numbers
              <span className="tab-count">{selectedMocks.length}/{MOCK_TAGS.length}</span>
            </button>
            <button
              className={`permission-tab ${activeTab === 'businessUnit' ? 'active' : ''}`}
              onClick={() => setActiveTab('businessUnit')}
            >
              Business Units
              <span className="tab-count">{selectedBusinessUnits.length}/{businessUnitTags.length}</span>
            </button>
          </div>

          {/* Source Permissions Tab */}
          {activeTab === 'source' && (
            <div className="permission-tab-content">
              <div className="permissions-actions">
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleSelectAllSources}>
                  Select All
                </button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleClearAllSources}>
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
                      disabled={isUserAdmin}
                    />
                    <span className="permission-label">
                      <span className="tag-name">{source}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Entity Permissions Tab */}
          {activeTab === 'entity' && (
            <div className="permission-tab-content">
              <div className="permissions-actions">
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleSelectAllEntities}>
                  Select All
                </button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleClearAllEntities}>
                  Clear All
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => setShowAddEntity(!showAddEntity)}
                >
                  + Add Entity
                </button>
                <span className="selected-count">
                  {selectedEntities.length} of {entityTags.length} selected
                </span>
              </div>

              {showAddEntity && (
                <div className="add-entity-form">
                  <input
                    type="text"
                    placeholder="Enter new entity tag (e.g., Person_Phone)"
                    value={newEntityTag}
                    onChange={(e) => setNewEntityTag(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddEntityTag()}
                  />
                  <button type="button" className="btn btn-sm btn-primary" onClick={handleAddEntityTag}>
                    Add
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => { setShowAddEntity(false); setNewEntityTag(''); }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="permissions-grid">
                {entityTags.map(entity => (
                  <label key={entity} className="permission-item">
                    <input
                      type="checkbox"
                      checked={selectedEntities.includes(entity)}
                      onChange={() => handleEntityToggle(entity)}
                      disabled={isUserAdmin}
                    />
                    <span className="permission-label">
                      <span className="tag-name">{entity}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Mock Permissions Tab */}
          {activeTab === 'mock' && (
            <div className="permission-tab-content">
              <div className="permissions-actions">
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleSelectAllMocks}>
                  Select All
                </button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleClearAllMocks}>
                  Clear All
                </button>
                <span className="selected-count">
                  {selectedMocks.length} of {MOCK_TAGS.length} selected
                </span>
              </div>
              <p className="permission-note">
                PRE versions are for files that arrive before the main MOCK cycle.
              </p>
              <div className="permissions-grid mock-grid">
                {MOCK_TAGS.map(mock => (
                  <label key={mock} className={`permission-item ${mock.includes('PRE') ? 'pre-mock' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selectedMocks.includes(mock)}
                      onChange={() => handleMockToggle(mock)}
                      disabled={isUserAdmin}
                    />
                    <span className="permission-label">
                      <span className="tag-name">{mock}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Business Unit Permissions Tab */}
          {activeTab === 'businessUnit' && (
            <div className="permission-tab-content">
              <div className="permissions-actions">
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleSelectAllBusinessUnits}>
                  Select All
                </button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleClearAllBusinessUnits}>
                  Clear All
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => setShowAddBU(!showAddBU)}
                >
                  + Add BU
                </button>
                <span className="selected-count">
                  {selectedBusinessUnits.length} of {businessUnitTags.length} selected
                </span>
              </div>

              {showAddBU && (
                <div className="add-entity-form">
                  <input
                    type="text"
                    placeholder="Enter BU number (e.g., 00026)"
                    value={newBUTag}
                    onChange={(e) => setNewBUTag(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddBUTag()}
                  />
                  <button type="button" className="btn btn-sm btn-primary" onClick={handleAddBUTag}>
                    Add
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => { setShowAddBU(false); setNewBUTag(''); }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <p className="permission-note">
                Business Unit numbers as they appear in file paths (e.g., 00014, 00015).
              </p>
              <div className="permissions-grid">
                {businessUnitTags.map(unit => (
                  <label key={unit} className="permission-item">
                    <input
                      type="checkbox"
                      checked={selectedBusinessUnits.includes(unit)}
                      onChange={() => handleBusinessUnitToggle(unit)}
                      disabled={isUserAdmin}
                    />
                    <span className="permission-label">
                      <span className="tag-name">{unit}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

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
              disabled={isSaving || isUserAdmin}
            >
              {isSaving ? 'Saving...' : 'Save All Permissions'}
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
