'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import { signOut, fetchUserAttributes } from 'aws-amplify/auth';
import { withAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import '../components/enhanced-file-browser.css';
import './admin.css';
import config from '../../amplify_outputs.json';
import { isAdminUser, CognitoUser, ApprovalAction, ADMIN_EMAILS } from './types';
import Link from 'next/link';

Amplify.configure(config);

// Lambda Function URLs
const APPROVAL_HANDLER_URL = 'https://w47wliqar3ka27qsezzckqpoza0kkmbt.lambda-url.us-east-1.on.aws/';
const APPROVAL_TOKEN = 'hacienda-erp-approval-2024';

interface DashboardStats {
  totalUsers: number;
  approvedUsers: number;
  pendingUsers: number;
  recentSignups: CognitoUser[];
}

function AdminDashboard() {
  const [userEmail, setUserEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [users, setUsers] = useState<CognitoUser[]>([]);
  const [approvedEmails, setApprovedEmails] = useState<string[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<ApprovalAction[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalUsers: 0,
    approvedUsers: 0,
    pendingUsers: 0,
    recentSignups: [],
  });
  const [activeTab, setActiveTab] = useState<'dashboard' | 'approvals' | 'history'>('dashboard');
  const [processingUser, setProcessingUser] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [historyFilter, setHistoryFilter] = useState<'all' | 'approve' | 'deny'>('all');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week' | 'month'>('all');

  // Check admin status
  useEffect(() => {
    async function checkAdmin() {
      try {
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';
        setUserEmail(email);
        setIsAdmin(isAdminUser(email));
      } catch (error) {
        console.error('Error checking admin status:', error);
      } finally {
        setIsLoading(false);
      }
    }
    checkAdmin();
  }, []);

  // Load approval history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('hacienda-approval-history');
    if (savedHistory) {
      try {
        setApprovalHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error('Error loading approval history:', e);
      }
    }
  }, []);

  // Fetch users and approved emails
  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(
        `${APPROVAL_HANDLER_URL}?action=list&token=${encodeURIComponent(APPROVAL_TOKEN)}`
      );

      if (response.ok) {
        const data = await response.json();
        if (data.users) {
          setUsers(data.users);
        }
        if (data.approvedEmails) {
          setApprovedEmails(data.approvedEmails.map((e: string) => e.toLowerCase()));
        }
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    }
  }, []);

  // Calculate stats
  useEffect(() => {
    const approved = users.filter(u =>
      approvedEmails.includes(u.email.toLowerCase())
    );
    const pending = users.filter(u =>
      u.status === 'CONFIRMED' && !approvedEmails.includes(u.email.toLowerCase())
    );

    // Recent signups (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recent = users
      .filter(u => new Date(u.created) > sevenDaysAgo)
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
      .slice(0, 5);

    setStats({
      totalUsers: users.length,
      approvedUsers: approved.length,
      pendingUsers: pending.length,
      recentSignups: recent,
    });
  }, [users, approvedEmails]);

  // Fetch data on mount
  useEffect(() => {
    if (isAdmin) {
      fetchData();
    }
  }, [isAdmin, fetchData]);

  // Approve user
  const handleApprove = async (email: string) => {
    setProcessingUser(email);
    try {
      const response = await fetch(
        `${APPROVAL_HANDLER_URL}?action=approve&email=${encodeURIComponent(email)}&token=${encodeURIComponent(APPROVAL_TOKEN)}`
      );

      if (response.ok) {
        // Add to history
        const newAction: ApprovalAction = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          userEmail: email,
          action: 'approve',
          adminEmail: userEmail,
          timestamp: new Date().toISOString(),
        };
        const newHistory = [newAction, ...approvalHistory];
        setApprovalHistory(newHistory);
        localStorage.setItem('hacienda-approval-history', JSON.stringify(newHistory));

        // Update approved emails
        setApprovedEmails(prev => [...prev, email.toLowerCase()]);
      }
    } catch (error) {
      console.error('Error approving user:', error);
    } finally {
      setProcessingUser(null);
    }
  };

  // Deny user
  const handleDeny = async (email: string) => {
    setProcessingUser(email);
    try {
      const response = await fetch(
        `${APPROVAL_HANDLER_URL}?action=deny&email=${encodeURIComponent(email)}&token=${encodeURIComponent(APPROVAL_TOKEN)}`
      );

      if (response.ok) {
        // Add to history
        const newAction: ApprovalAction = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          userEmail: email,
          action: 'deny',
          adminEmail: userEmail,
          timestamp: new Date().toISOString(),
        };
        const newHistory = [newAction, ...approvalHistory];
        setApprovalHistory(newHistory);
        localStorage.setItem('hacienda-approval-history', JSON.stringify(newHistory));
      }
    } catch (error) {
      console.error('Error denying user:', error);
    } finally {
      setProcessingUser(null);
    }
  };

  // Filter users
  const filteredUsers = users.filter(user => {
    const isApproved = approvedEmails.includes(user.email.toLowerCase());
    const matchesSearch = user.email.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    if (filter === 'pending') {
      return user.status === 'CONFIRMED' && !isApproved;
    } else if (filter === 'approved') {
      return isApproved;
    }
    return true;
  });

  // Filter history
  const filteredHistory = approvalHistory.filter(action => {
    // Action type filter
    if (historyFilter !== 'all' && action.action !== historyFilter) {
      return false;
    }

    // Date filter
    if (dateFilter !== 'all') {
      const actionDate = new Date(action.timestamp);
      const now = new Date();

      if (dateFilter === 'today') {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (actionDate < today) return false;
      } else if (dateFilter === 'week') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (actionDate < weekAgo) return false;
      } else if (dateFilter === 'month') {
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        if (actionDate < monthAgo) return false;
      }
    }

    return true;
  });

  // Handle sign out
  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Error signing out:', error);
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
          <p>You do not have permission to access the admin dashboard.</p>
          <p className="email-info">Signed in as: {userEmail}</p>
          <div className="access-denied-actions">
            <Link href="/" className="btn btn-secondary">
              Back to Home
            </Link>
            <button onClick={handleSignOut} className="btn btn-primary">
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-container">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-header-left">
          <Link href="/" className="admin-back-link">
            <span className="back-icon">←</span>
            Back to Files
          </Link>
          <h1>Admin Dashboard</h1>
        </div>
        <div className="admin-header-right">
          <span className="admin-user-email">{userEmail}</span>
          <button onClick={handleSignOut} className="btn btn-ghost">
            Sign Out
          </button>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="admin-nav">
        <button
          className={`admin-nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <span className="tab-icon">📊</span>
          Dashboard
        </button>
        <button
          className={`admin-nav-tab ${activeTab === 'approvals' ? 'active' : ''}`}
          onClick={() => setActiveTab('approvals')}
        >
          <span className="tab-icon">👥</span>
          User Approvals
          {stats.pendingUsers > 0 && (
            <span className="tab-badge">{stats.pendingUsers}</span>
          )}
        </button>
        <button
          className={`admin-nav-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          <span className="tab-icon">📋</span>
          Activity Log
        </button>
        <Link href="/admin/promote-mock" className="admin-nav-tab" style={{ textDecoration: 'none' }}>
          <span className="tab-icon">⏭️</span>
          Promote Mock
        </Link>
        <Link href="/admin/reset-file-expected" className="admin-nav-tab" style={{ textDecoration: 'none' }}>
          <span className="tab-icon">🔄</span>
          Allow Re-upload
        </Link>
      </nav>

      {/* Main Content */}
      <main className="admin-main">
        {activeTab === 'dashboard' && (
          <div className="dashboard-content">
            {/* Stats Cards */}
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon users-icon">👥</div>
                <div className="stat-info">
                  <span className="stat-value">{stats.totalUsers}</span>
                  <span className="stat-label">Total Users</span>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon approved-icon">✅</div>
                <div className="stat-info">
                  <span className="stat-value">{stats.approvedUsers}</span>
                  <span className="stat-label">Approved Users</span>
                </div>
              </div>
              <div className="stat-card pending">
                <div className="stat-icon pending-icon">⏳</div>
                <div className="stat-info">
                  <span className="stat-value">{stats.pendingUsers}</span>
                  <span className="stat-label">Pending Approval</span>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon admins-icon">🛡️</div>
                <div className="stat-info">
                  <span className="stat-value">{ADMIN_EMAILS.length}</span>
                  <span className="stat-label">Administrators</span>
                </div>
              </div>
            </div>

            {/* Quick Actions & Recent Activity */}
            <div className="dashboard-grid">
              {/* Pending Approvals Widget */}
              <div className="dashboard-widget">
                <div className="widget-header">
                  <h3>Pending Approvals</h3>
                  {stats.pendingUsers > 0 && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => setActiveTab('approvals')}
                    >
                      View All
                    </button>
                  )}
                </div>
                <div className="widget-content">
                  {stats.pendingUsers === 0 ? (
                    <div className="widget-empty">
                      <span className="empty-icon">✨</span>
                      <p>No pending approvals</p>
                    </div>
                  ) : (
                    <ul className="pending-list">
                      {users
                        .filter(u =>
                          u.status === 'CONFIRMED' &&
                          !approvedEmails.includes(u.email.toLowerCase())
                        )
                        .slice(0, 5)
                        .map(user => (
                          <li key={user.email} className="pending-item">
                            <div className="pending-info">
                              <span className="pending-email">{user.email}</span>
                              <span className="pending-date">
                                {new Date(user.created).toLocaleDateString()}
                              </span>
                            </div>
                            <div className="pending-actions">
                              <button
                                className="btn btn-sm btn-success"
                                onClick={() => handleApprove(user.email)}
                                disabled={processingUser === user.email}
                              >
                                {processingUser === user.email ? '...' : 'Approve'}
                              </button>
                            </div>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Recent Signups Widget */}
              <div className="dashboard-widget">
                <div className="widget-header">
                  <h3>Recent Signups</h3>
                  <span className="widget-subtitle">Last 7 days</span>
                </div>
                <div className="widget-content">
                  {stats.recentSignups.length === 0 ? (
                    <div className="widget-empty">
                      <span className="empty-icon">📭</span>
                      <p>No recent signups</p>
                    </div>
                  ) : (
                    <ul className="recent-list">
                      {stats.recentSignups.map(user => (
                        <li key={user.email} className="recent-item">
                          <div className="recent-avatar">
                            {user.email.charAt(0).toUpperCase()}
                          </div>
                          <div className="recent-info">
                            <span className="recent-email">{user.email}</span>
                            <span className="recent-date">
                              {new Date(user.created).toLocaleDateString()} at{' '}
                              {new Date(user.created).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                          <span className={`status-badge ${
                            approvedEmails.includes(user.email.toLowerCase())
                              ? 'approved'
                              : 'pending'
                          }`}>
                            {approvedEmails.includes(user.email.toLowerCase())
                              ? 'Approved'
                              : 'Pending'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Recent Activity Widget */}
              <div className="dashboard-widget">
                <div className="widget-header">
                  <h3>Recent Activity</h3>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => setActiveTab('history')}
                  >
                    View All
                  </button>
                </div>
                <div className="widget-content">
                  {approvalHistory.length === 0 ? (
                    <div className="widget-empty">
                      <span className="empty-icon">📝</span>
                      <p>No activity yet</p>
                    </div>
                  ) : (
                    <ul className="activity-list">
                      {approvalHistory.slice(0, 5).map(action => (
                        <li key={action.id} className="activity-item">
                          <span className={`activity-icon ${action.action}`}>
                            {action.action === 'approve' ? '✅' : '❌'}
                          </span>
                          <div className="activity-info">
                            <span className="activity-text">
                              <strong>{action.adminEmail}</strong>{' '}
                              {action.action === 'approve' ? 'approved' : 'denied'}{' '}
                              <strong>{action.userEmail}</strong>
                            </span>
                            <span className="activity-date">
                              {new Date(action.timestamp).toLocaleString()}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* System Info Widget */}
              <div className="dashboard-widget">
                <div className="widget-header">
                  <h3>System Info</h3>
                </div>
                <div className="widget-content">
                  <div className="system-info">
                    <div className="info-row">
                      <span className="info-label">Environment</span>
                      <span className="info-value">Development</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">User Pool</span>
                      <span className="info-value">Hacienda-ERP-DEV-Users</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">Administrators</span>
                      <div className="admin-list">
                        {ADMIN_EMAILS.map(email => (
                          <span key={email} className="admin-email-tag">
                            {email}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'approvals' && (
          <div className="approvals-content">
            {/* Filters */}
            <div className="approvals-toolbar">
              <div className="filter-group">
                <button
                  className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  All Users ({users.length})
                </button>
                <button
                  className={`filter-btn ${filter === 'pending' ? 'active' : ''}`}
                  onClick={() => setFilter('pending')}
                >
                  Pending ({stats.pendingUsers})
                </button>
                <button
                  className={`filter-btn ${filter === 'approved' ? 'active' : ''}`}
                  onClick={() => setFilter('approved')}
                >
                  Approved ({stats.approvedUsers})
                </button>
              </div>
              <div className="search-box">
                <input
                  type="text"
                  placeholder="Search by email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                />
              </div>
              <button className="btn btn-secondary" onClick={fetchData}>
                <span className="refresh-icon">🔄</span>
                Refresh
              </button>
            </div>

            {/* Users Table */}
            <div className="users-table-container">
              <table className="users-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Approval Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="empty-row">
                        No users found
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map(user => {
                      const isApproved = approvedEmails.includes(user.email.toLowerCase());
                      const isUserAdmin = isAdminUser(user.email);
                      return (
                        <tr key={user.email}>
                          <td>
                            <div className="user-email-cell">
                              <Link
                                href={`/admin/users/${encodeURIComponent(user.username)}`}
                                className="user-email-link"
                              >
                                {user.email}
                              </Link>
                              {isUserAdmin && (
                                <span className="admin-badge">Admin</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span className={`status-tag ${user.status.toLowerCase()}`}>
                              {user.status}
                            </span>
                          </td>
                          <td>{new Date(user.created).toLocaleString()}</td>
                          <td>
                            <span className={`approval-tag ${isApproved ? 'approved' : 'pending'}`}>
                              {isApproved ? 'Approved' : 'Pending'}
                            </span>
                          </td>
                          <td>
                            <div className="action-buttons">
                              {!isApproved && user.status === 'CONFIRMED' && (
                                <>
                                  <button
                                    className="btn btn-sm btn-success"
                                    onClick={() => handleApprove(user.email)}
                                    disabled={processingUser === user.email}
                                  >
                                    {processingUser === user.email ? 'Processing...' : 'Approve'}
                                  </button>
                                  <button
                                    className="btn btn-sm btn-danger"
                                    onClick={() => handleDeny(user.email)}
                                    disabled={processingUser === user.email}
                                  >
                                    Deny
                                  </button>
                                </>
                              )}
                              <Link
                                href={`/admin/users/${encodeURIComponent(user.username)}`}
                                className="btn btn-sm btn-secondary"
                              >
                                Permissions
                              </Link>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="history-content">
            {/* History Filters */}
            <div className="history-toolbar">
              <div className="filter-group">
                <label>Action Type:</label>
                <select
                  value={historyFilter}
                  onChange={(e) => setHistoryFilter(e.target.value as 'all' | 'approve' | 'deny')}
                  className="filter-select"
                >
                  <option value="all">All Actions</option>
                  <option value="approve">Approvals Only</option>
                  <option value="deny">Denials Only</option>
                </select>
              </div>
              <div className="filter-group">
                <label>Time Period:</label>
                <select
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value as 'all' | 'today' | 'week' | 'month')}
                  className="filter-select"
                >
                  <option value="all">All Time</option>
                  <option value="today">Today</option>
                  <option value="week">Last 7 Days</option>
                  <option value="month">Last 30 Days</option>
                </select>
              </div>
              <div className="filter-stats">
                Showing {filteredHistory.length} of {approvalHistory.length} entries
              </div>
            </div>

            {/* History Table */}
            <div className="history-table-container">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Date & Time</th>
                    <th>Action</th>
                    <th>User Email</th>
                    <th>Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="empty-row">
                        No activity history found
                      </td>
                    </tr>
                  ) : (
                    filteredHistory.map(action => (
                      <tr key={action.id}>
                        <td>{new Date(action.timestamp).toLocaleString()}</td>
                        <td>
                          <span className={`action-tag ${action.action}`}>
                            {action.action === 'approve' ? '✅ Approved' : '❌ Denied'}
                          </span>
                        </td>
                        <td>{action.userEmail}</td>
                        <td>{action.adminEmail}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default withAuthenticator(AdminDashboard);
