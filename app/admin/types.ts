// Admin Dashboard Types

// ============================================
// SOURCE TAGS
// ============================================
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

// ============================================
// ENTITY TAGS
// ============================================
// Default entity tags - more can be added dynamically
export const DEFAULT_ENTITY_TAGS = [
  'Person_Address',
  'Person_Assign',
  'Person_Email',
  'Person',
  'Person_Name',
  'Person_Nid',
  'Person_Supv',
] as const;

export type DefaultEntityTag = typeof DEFAULT_ENTITY_TAGS[number];

// Storage key for dynamic entity tags
const DYNAMIC_ENTITY_TAGS_KEY = 'hacienda-dynamic-entity-tags';

// Get all entity tags (default + dynamic)
export function getAllEntityTags(): string[] {
  const defaultTags = [...DEFAULT_ENTITY_TAGS];
  if (typeof window === 'undefined') return defaultTags;

  const stored = localStorage.getItem(DYNAMIC_ENTITY_TAGS_KEY);
  if (!stored) return defaultTags;

  try {
    const dynamicTags: string[] = JSON.parse(stored);
    // Combine and dedupe
    const allTags = new Set([...defaultTags, ...dynamicTags]);
    return Array.from(allTags).sort();
  } catch {
    return defaultTags;
  }
}

// Add a new dynamic entity tag
export function addDynamicEntityTag(tag: string): void {
  if (typeof window === 'undefined') return;

  const stored = localStorage.getItem(DYNAMIC_ENTITY_TAGS_KEY);
  let dynamicTags: string[] = [];

  if (stored) {
    try {
      dynamicTags = JSON.parse(stored);
    } catch {
      dynamicTags = [];
    }
  }

  // Normalize tag and check if it already exists
  const normalizedTag = tag.trim();
  if (!normalizedTag) return;

  // Check against both default and dynamic tags
  const allExisting = new Set([...DEFAULT_ENTITY_TAGS, ...dynamicTags].map(t => t.toLowerCase()));
  if (!allExisting.has(normalizedTag.toLowerCase())) {
    dynamicTags.push(normalizedTag);
    localStorage.setItem(DYNAMIC_ENTITY_TAGS_KEY, JSON.stringify(dynamicTags));
  }
}

// ============================================
// MOCK NUMBER TAGS
// ============================================
// Generate mock tags from MOCK6 to MOCK15, each with a PRE version
export function generateMockTags(): string[] {
  const mocks: string[] = [];
  for (let i = 6; i <= 15; i++) {
    mocks.push(`MOCK${i}`);
    mocks.push(`MOCK${i}PRE`);
  }
  return mocks;
}

export const MOCK_TAGS = generateMockTags();

// ============================================
// BUSINESS UNIT TAGS
// ============================================
// Default business unit numbers - more can be added dynamically
export const DEFAULT_BUSINESS_UNIT_TAGS = [
  '00014',
  '00015',
  '00016',
  '00017',
  '00018',
  '00019',
  '00020',
  '00021',
  '00022',
  '00023',
  '00024',
  '00025',
] as const;

export type DefaultBusinessUnitTag = typeof DEFAULT_BUSINESS_UNIT_TAGS[number];

// Storage key for dynamic business unit tags
const DYNAMIC_BU_TAGS_KEY = 'hacienda-dynamic-bu-tags';

// Get all business unit tags (default + dynamic)
export function getAllBusinessUnitTags(): string[] {
  const defaultTags = [...DEFAULT_BUSINESS_UNIT_TAGS];
  if (typeof window === 'undefined') return defaultTags;

  const stored = localStorage.getItem(DYNAMIC_BU_TAGS_KEY);
  if (!stored) return defaultTags;

  try {
    const dynamicTags: string[] = JSON.parse(stored);
    // Combine and dedupe
    const allTags = new Set([...defaultTags, ...dynamicTags]);
    return Array.from(allTags).sort();
  } catch {
    return defaultTags;
  }
}

// Add a new dynamic business unit tag
export function addDynamicBusinessUnitTag(tag: string): void {
  if (typeof window === 'undefined') return;

  const stored = localStorage.getItem(DYNAMIC_BU_TAGS_KEY);
  let dynamicTags: string[] = [];

  if (stored) {
    try {
      dynamicTags = JSON.parse(stored);
    } catch {
      dynamicTags = [];
    }
  }

  // Normalize tag and check if it already exists
  const normalizedTag = tag.trim();
  if (!normalizedTag) return;

  // Check against both default and dynamic tags
  const allExisting = new Set([...DEFAULT_BUSINESS_UNIT_TAGS, ...dynamicTags]);
  if (!allExisting.has(normalizedTag)) {
    dynamicTags.push(normalizedTag);
    localStorage.setItem(DYNAMIC_BU_TAGS_KEY, JSON.stringify(dynamicTags));
  }
}

// Legacy export for backward compatibility
export const BUSINESS_UNIT_TAGS = DEFAULT_BUSINESS_UNIT_TAGS;

// ============================================
// USER INTERFACES
// ============================================
export interface AdminUser {
  email: string;
  isAdmin: boolean;
}

// Extended permissions interface with all permission types
export interface UserPermissions {
  email: string;
  allowedSources: SourceTag[];
  allowedEntities: string[];  // Dynamic, so string[] instead of type
  allowedMocks: string[];
  allowedBusinessUnits: string[];
  updatedAt: string;
  updatedBy: string;
}

// Legacy interface for backward compatibility
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

// ============================================
// ADMIN HELPERS
// ============================================
// List of admin email addresses
export const ADMIN_EMAILS = [
  'mrichcreek@elitebco.com',
  'lbaez@elitebco.com',
];

export function isAdminUser(email: string): boolean {
  return ADMIN_EMAILS.map(e => e.toLowerCase()).includes(email.toLowerCase());
}

// ============================================
// PERMISSION STORAGE
// ============================================
// Local storage key for user permissions (new extended format)
const USER_PERMISSIONS_KEY = 'hacienda-user-permissions-v2';
// Legacy key for backward compatibility
const USER_PERMISSIONS_LEGACY_KEY = 'hacienda-user-source-permissions';

// Get all user permissions from localStorage
export function getAllUserPermissions(): Record<string, UserPermissions> {
  if (typeof window === 'undefined') return {};

  // Try new format first
  const stored = localStorage.getItem(USER_PERMISSIONS_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return {};
    }
  }

  // Migrate from legacy format if exists
  const legacy = localStorage.getItem(USER_PERMISSIONS_LEGACY_KEY);
  if (legacy) {
    try {
      const legacyData: Record<string, UserSourcePermissions> = JSON.parse(legacy);
      const migrated: Record<string, UserPermissions> = {};

      for (const [email, perms] of Object.entries(legacyData)) {
        migrated[email] = {
          email: perms.email,
          allowedSources: perms.allowedSources,
          allowedEntities: [],
          allowedMocks: [],
          allowedBusinessUnits: [],
          updatedAt: perms.updatedAt,
          updatedBy: perms.updatedBy,
        };
      }

      // Save migrated data
      localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(migrated));
      return migrated;
    } catch {
      return {};
    }
  }

  return {};
}

// Get permissions for a specific user
export function getUserPermissions(email: string): UserPermissions | null {
  const all = getAllUserPermissions();
  return all[email.toLowerCase()] || null;
}

// Save permissions for a user (full permissions)
export function saveUserFullPermissions(
  email: string,
  permissions: {
    allowedSources: SourceTag[];
    allowedEntities: string[];
    allowedMocks: string[];
    allowedBusinessUnits: string[];
  },
  updatedBy: string
): void {
  const all = getAllUserPermissions();
  all[email.toLowerCase()] = {
    email: email.toLowerCase(),
    allowedSources: permissions.allowedSources,
    allowedEntities: permissions.allowedEntities,
    allowedMocks: permissions.allowedMocks,
    allowedBusinessUnits: permissions.allowedBusinessUnits,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  localStorage.setItem(USER_PERMISSIONS_KEY, JSON.stringify(all));
}

// Legacy function for backward compatibility
export function saveUserPermissions(
  email: string,
  allowedSources: SourceTag[],
  updatedBy: string
): void {
  const existing = getUserPermissions(email);
  saveUserFullPermissions(
    email,
    {
      allowedSources,
      allowedEntities: existing?.allowedEntities || [],
      allowedMocks: existing?.allowedMocks || [],
      allowedBusinessUnits: existing?.allowedBusinessUnits || [],
    },
    updatedBy
  );
}

// ============================================
// ACCESS CHECKING
// ============================================
// Check if user can access a source
export function canAccessSource(email: string, source: string): boolean {
  if (isAdminUser(email)) return true;

  const permissions = getUserPermissions(email);
  if (!permissions || permissions.allowedSources.length === 0) return false;

  return permissions.allowedSources.includes(source.toUpperCase() as SourceTag);
}

// Check if user can access an entity
export function canAccessEntity(email: string, entity: string): boolean {
  if (isAdminUser(email)) return true;

  const permissions = getUserPermissions(email);
  if (!permissions || permissions.allowedEntities.length === 0) return false;

  return permissions.allowedEntities.some(
    e => e.toLowerCase() === entity.toLowerCase()
  );
}

// Check if user can access a mock
export function canAccessMock(email: string, mock: string): boolean {
  if (isAdminUser(email)) return true;

  const permissions = getUserPermissions(email);
  if (!permissions || permissions.allowedMocks.length === 0) return false;

  return permissions.allowedMocks.some(
    m => m.toLowerCase() === mock.toLowerCase()
  );
}

// Check if user can access a business unit
export function canAccessBusinessUnit(email: string, unit: string): boolean {
  if (isAdminUser(email)) return true;

  const permissions = getUserPermissions(email);
  if (!permissions || permissions.allowedBusinessUnits.length === 0) return false;

  return permissions.allowedBusinessUnits.some(
    u => u.toLowerCase() === unit.toLowerCase()
  );
}

// ============================================
// PATH EXTRACTION
// ============================================
// Extract source tag from a file path
export function extractSourceFromPath(path: string): string | null {
  const upperPath = path.toUpperCase();
  for (const source of SOURCE_TAGS) {
    if (upperPath.includes(`/${source}/`) || upperPath.includes(`\\${source}\\`) ||
        upperPath.startsWith(`${source}/`) || upperPath.endsWith(`/${source}`)) {
      return source;
    }
  }
  return null;
}

// Extract entity tag from a file path
export function extractEntityFromPath(path: string): string | null {
  const allEntities = getAllEntityTags();
  for (const entity of allEntities) {
    const entityUpper = entity.toUpperCase();
    const upperPath = path.toUpperCase();
    if (upperPath.includes(`/${entityUpper}/`) || upperPath.includes(`\\${entityUpper}\\`) ||
        upperPath.includes(`/${entityUpper}.`) || upperPath.includes(`_${entityUpper}_`) ||
        upperPath.includes(`_${entityUpper}.`)) {
      return entity;
    }
  }
  return null;
}

// Extract mock number from a file path
export function extractMockFromPath(path: string): string | null {
  const upperPath = path.toUpperCase();

  // Match patterns like "MOCK 8", "MOCK8", "MOCK8PRE", "MOCK 8 PRE"
  const mockPattern = /MOCK\s*(\d+)\s*(PRE)?/gi;
  const match = mockPattern.exec(upperPath);

  if (match) {
    const mockNum = match[1];
    const isPre = match[2] ? 'PRE' : '';
    return `MOCK${mockNum}${isPre}`;
  }

  return null;
}

// Extract business unit from a file path
export function extractBusinessUnitFromPath(path: string): string | null {
  const allUnits = getAllBusinessUnitTags();
  for (const unit of allUnits) {
    if (path.includes(`/${unit}/`) || path.includes(`\\${unit}\\`) ||
        path.includes(`/${unit}.`) || path.includes(`_${unit}_`) ||
        path.includes(`_${unit}.`)) {
      return unit;
    }
  }

  // Also try to match any 5-digit BU pattern like 00014, 00015, etc.
  const buPattern = /\/(\d{5})\//;
  const match = buPattern.exec(path);
  if (match) {
    return match[1];
  }

  return null;
}

// Check if user can access a file based on all permission types
export function canUserAccessPath(email: string, path: string): boolean {
  if (isAdminUser(email)) return true;

  const permissions = getUserPermissions(email);
  if (!permissions) return false;

  // Extract tags from path
  const source = extractSourceFromPath(path);
  const entity = extractEntityFromPath(path);
  const mock = extractMockFromPath(path);
  const businessUnit = extractBusinessUnitFromPath(path);

  // If any tag is found in the path, user must have permission for it
  // If no permissions are set for a category, that category is not enforced

  // Check source permission
  if (source) {
    if (permissions.allowedSources.length > 0 &&
        !permissions.allowedSources.includes(source as SourceTag)) {
      return false;
    }
  }

  // Check entity permission
  if (entity) {
    if (permissions.allowedEntities.length > 0 &&
        !permissions.allowedEntities.some(e => e.toLowerCase() === entity.toLowerCase())) {
      return false;
    }
  }

  // Check mock permission
  if (mock) {
    if (permissions.allowedMocks.length > 0 &&
        !permissions.allowedMocks.some(m => m.toLowerCase() === mock.toLowerCase())) {
      return false;
    }
  }

  // Check business unit permission
  if (businessUnit) {
    if (permissions.allowedBusinessUnits.length > 0 &&
        !permissions.allowedBusinessUnits.some(u => u.toLowerCase() === businessUnit.toLowerCase())) {
      return false;
    }
  }

  return true;
}
