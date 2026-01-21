'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { fetchUserAttributes } from 'aws-amplify/auth';
import { isAdminUser, CognitoUser, ApprovalAction, DashboardStats } from './types';

interface AdminContextType {
  isAdmin: boolean;
  adminEmail: string;
  isLoading: boolean;
  users: CognitoUser[];
  approvedEmails: string[];
  approvalHistory: ApprovalAction[];
  stats: DashboardStats;
  refreshData: () => Promise<void>;
  approveUser: (email: string, notes?: string) => Promise<boolean>;
  denyUser: (email: string, notes?: string) => Promise<boolean>;
}

const AdminContext = createContext<AdminContextType | null>(null);

// Lambda Function URLs
const APPROVAL_HANDLER_URL = 'https://w47wliqar3ka27qsezzckqpoza0kkmbt.lambda-url.us-east-1.on.aws/';
const APPROVAL_TOKEN = 'hacienda-erp-approval-2024';

interface AdminProviderProps {
  children: ReactNode;
}

export function AdminProvider({ children }: AdminProviderProps) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [users, setUsers] = useState<CognitoUser[]>([]);
  const [approvedEmails, setApprovedEmails] = useState<string[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<ApprovalAction[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalUsers: 0,
    approvedUsers: 0,
    pendingUsers: 0,
    deniedUsers: 0,
    recentSignups: 0,
    activeToday: 0,
  });

  // Check if current user is admin
  useEffect(() => {
    async function checkAdmin() {
      try {
        const attributes = await fetchUserAttributes();
        const email = attributes.email || '';
        setAdminEmail(email);
        setIsAdmin(isAdminUser(email));
      } catch (error) {
        console.error('Error checking admin status:', error);
        setIsAdmin(false);
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

  // Save approval history to localStorage
  const saveApprovalHistory = useCallback((history: ApprovalAction[]) => {
    localStorage.setItem('hacienda-approval-history', JSON.stringify(history));
    setApprovalHistory(history);
  }, []);

  // Fetch user and approval data
  const refreshData = useCallback(async () => {
    if (!isAdmin) return;

    try {
      // Fetch data via the admin API endpoint
      const response = await fetch(`${APPROVAL_HANDLER_URL}?action=list&token=${encodeURIComponent(APPROVAL_TOKEN)}`);

      if (response.ok) {
        const data = await response.json();
        if (data.users) {
          setUsers(data.users);
        }
        if (data.approvedEmails) {
          setApprovedEmails(data.approvedEmails);
        }
        if (data.stats) {
          setStats(data.stats);
        }
      }
    } catch (error) {
      console.error('Error fetching admin data:', error);
    }
  }, [isAdmin]);

  // Approve a user
  const approveUser = useCallback(async (email: string, notes?: string): Promise<boolean> => {
    try {
      const response = await fetch(
        `${APPROVAL_HANDLER_URL}?action=approve&email=${encodeURIComponent(email)}&token=${encodeURIComponent(APPROVAL_TOKEN)}`
      );

      if (response.ok) {
        // Add to approval history
        const newAction: ApprovalAction = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          userEmail: email,
          action: 'approve',
          adminEmail,
          timestamp: new Date().toISOString(),
          notes,
        };
        saveApprovalHistory([newAction, ...approvalHistory]);

        // Update approved emails list
        setApprovedEmails(prev => [...prev, email.toLowerCase()]);

        return true;
      }
      return false;
    } catch (error) {
      console.error('Error approving user:', error);
      return false;
    }
  }, [adminEmail, approvalHistory, saveApprovalHistory]);

  // Deny a user
  const denyUser = useCallback(async (email: string, notes?: string): Promise<boolean> => {
    try {
      const response = await fetch(
        `${APPROVAL_HANDLER_URL}?action=deny&email=${encodeURIComponent(email)}&token=${encodeURIComponent(APPROVAL_TOKEN)}`
      );

      if (response.ok) {
        // Add to approval history
        const newAction: ApprovalAction = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          userEmail: email,
          action: 'deny',
          adminEmail,
          timestamp: new Date().toISOString(),
          notes,
        };
        saveApprovalHistory([newAction, ...approvalHistory]);

        return true;
      }
      return false;
    } catch (error) {
      console.error('Error denying user:', error);
      return false;
    }
  }, [adminEmail, approvalHistory, saveApprovalHistory]);

  return (
    <AdminContext.Provider
      value={{
        isAdmin,
        adminEmail,
        isLoading,
        users,
        approvedEmails,
        approvalHistory,
        stats,
        refreshData,
        approveUser,
        denyUser,
      }}
    >
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error('useAdmin must be used within an AdminProvider');
  }
  return context;
}
