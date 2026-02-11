// Admin Dashboard Types

// Available source tags for file permissions
export const SOURCE_TAGS = [
  'PRIFAS',
  'HACIENDA',
  'FIMAS',
  '911',
  'RHUM',
  'KRONOSPOL',
  'DOE',
  'ADPPOLICIA',
  'KRONOSDE',
  'SEPI',
] as const;

export type SourceTag = typeof SOURCE_TAGS[number];

export interface AdminUser {
  email: string;
  isAdmin: boolean;
}

export interface UserSourcePermissions {
  email: string;
  allowedSources: SourceTag[];
  updatedAt: string;
  updatedBy: string;
}

export interface CognitoUser {
  username: string;
  email: string;
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'FORCE_CHANGE_PASSWORD' | 'RESET_REQUIRED';
  enabled: boolean;
  created: string;
  lastModified: string;
  emailVerified: boolean;
  allowedSources?: SourceTag[];
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

// Local storage key for user source permissions
const USER_PERMISSIONS_KEY = 'hacienda-user-source-permissions';

// Get all user permissions from localStorage
export function getAllUserPermissions(): Record<string, UserSourcePermissions> {
  if (typeof window === 'undefined') return {};
  const stored = localStorage.getItem(USER_PERMISSIONS_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

// Get permissions for a specific user
export function getUserPermissions(email: string): UserSourcePermissions | null {
  const all = getAllUserPermissions();
  return all[email.toLowerCase()] || null;
}

// Save permissions for a user
export function saveUserPermissions(
  email: string,
  allowedSources: SourceTag[],
  updatedBy: string
): void {
  const all = getAllUserPermissions();
  all[email.toLowerCase()] = {
    email: email.toLowerCase(),
    allowedSources,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(all));
}

// Check if user can access a source
export function canAccessSource(email: string, source: string): boolean {
  // Admins can access everything
  if (isAdminUser(email)) return true;

  const permissions = getUserPermissions(email);
  if (!permissions || permissions.allowedSources.length === 0) return false;

  return permissions.allowedSources.includes(source.toUpperCase() as SourceTag);
}

// Extract source tag from a file path
// Path format: "Home/Data Validation/MOCK 8/FIN/AP Invoices/PRIFAS/1-Extracted"
export function extractSourceFromPath(path: string): string | null {
  const upperPath = path.toUpperCase();
  for (const source of SOURCE_TAGS) {
    // Check if the source appears as a folder in the path
    if (upperPath.includes(`/${source}/`) || upperPath.includes(`\\${source}\\`) ||
        upperPath.startsWith(`${source}/`) || upperPath.endsWith(`/${source}`)) {
      return source;
    }
  }
  return null;
}
