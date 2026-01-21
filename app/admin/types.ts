// Admin Dashboard Types

export interface AdminUser {
  email: string;
  isAdmin: boolean;
}

export interface CognitoUser {
  username: string;
  email: string;
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'FORCE_CHANGE_PASSWORD' | 'RESET_REQUIRED';
  enabled: boolean;
  created: string;
  lastModified: string;
  emailVerified: boolean;
}

export interface ApprovalAction {
  id: string;
  userEmail: string;
  action: 'approve' | 'deny';
  adminEmail: string;
  timestamp: string;
  notes?: string;
}

export interface DashboardStats {
  totalUsers: number;
  approvedUsers: number;
  pendingUsers: number;
  deniedUsers: number;
  recentSignups: number;
  activeToday: number;
}

export interface ApprovalFilter {
  status: 'all' | 'pending' | 'approved' | 'denied';
  dateRange: 'all' | 'today' | 'week' | 'month';
  searchQuery: string;
}

// List of admin email addresses
export const ADMIN_EMAILS = [
  'mrichcreek@elitebco.com',
  'lbaez@elitebco.com',
];

export function isAdminUser(email: string): boolean {
  return ADMIN_EMAILS.map(e => e.toLowerCase()).includes(email.toLowerCase());
}
