/**
 * Shareable Links Library
 *
 * Generates and decodes shareable links for files and folders in the storage system.
 * Links are formatted as:
 *   - Files: /files/{fileId}
 *   - Folders: /folders/{folderId}
 * where the ID is a base64-encoded representation of the path.
 */

// Storage key for shared links registry
const SHARED_LINKS_KEY = 'hacienda-shared-links';

export type ShareableType = 'file' | 'folder';

export interface SharedLink {
  id: string;
  path: string;
  name: string;
  type: ShareableType;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
}

/**
 * Generate a unique ID from a file path
 * Uses base64 encoding with URL-safe characters
 */
export function generateShareableFileId(filePath: string): string {
  // Use base64 encoding with URL-safe characters
  const encoded = btoa(filePath)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return encoded;
}

/**
 * Decode a shareable file ID back to the original path
 */
export function decodeShareableFileId(fileId: string): string | null {
  try {
    // Restore base64 padding and characters
    let base64 = fileId.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    return atob(base64);
  } catch (error) {
    console.error('Error decoding file ID:', error);
    return null;
  }
}

/**
 * Generate a shareable link for a file
 */
export function generateShareableLink(
  filePath: string,
  fileName: string,
  createdBy: string
): { url: string; id: string } {
  return generateShareableLinkWithType(filePath, fileName, createdBy, 'file');
}

/**
 * Generate a shareable link for a folder
 */
export function generateShareableFolderLink(
  folderPath: string,
  folderName: string,
  createdBy: string
): { url: string; id: string } {
  return generateShareableLinkWithType(folderPath, folderName, createdBy, 'folder');
}

/**
 * Generate a shareable link for a file or folder
 */
export function generateShareableLinkWithType(
  path: string,
  name: string,
  createdBy: string,
  type: ShareableType
): { url: string; id: string } {
  const id = generateShareableFileId(path);

  // Store the shared link info
  const sharedLinks = getAllSharedLinks();
  sharedLinks[id] = {
    id,
    path,
    name,
    type,
    createdAt: new Date().toISOString(),
    createdBy,
  };

  if (typeof window !== 'undefined') {
    localStorage.setItem(SHARED_LINKS_KEY, JSON.stringify(sharedLinks));
  }

  // Generate full URL
  const baseUrl = typeof window !== 'undefined'
    ? window.location.origin
    : '';

  const routePath = type === 'folder' ? 'folders' : 'files';

  return {
    url: `${baseUrl}/${routePath}/${id}`,
    id,
  };
}

/**
 * Get all shared links from storage
 */
export function getAllSharedLinks(): Record<string, SharedLink> {
  if (typeof window === 'undefined') return {};

  const stored = localStorage.getItem(SHARED_LINKS_KEY);
  if (!stored) return {};

  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

/**
 * Get shared file info from an ID
 */
export function getSharedFileInfo(fileId: string): { path: string; name: string; type?: ShareableType } | null {
  // First check the registry
  const sharedLinks = getAllSharedLinks();
  if (sharedLinks[fileId]) {
    return {
      path: sharedLinks[fileId].path,
      name: sharedLinks[fileId].name,
      type: sharedLinks[fileId].type,
    };
  }

  // Otherwise try to decode directly
  const path = decodeShareableFileId(fileId);
  if (!path) return null;

  // Extract filename from path
  const parts = path.split('/').filter(Boolean);
  const name = parts[parts.length - 1] || path;

  // Determine if it's a folder (ends with /)
  const type: ShareableType = path.endsWith('/') ? 'folder' : 'file';

  return { path, name, type };
}

/**
 * Get shared folder info from an ID
 */
export function getSharedFolderInfo(folderId: string): { path: string; name: string } | null {
  const info = getSharedFileInfo(folderId);
  if (!info) return null;
  return { path: info.path, name: info.name };
}

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        return true;
      } finally {
        document.body.removeChild(textArea);
      }
    }
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    return false;
  }
}

/**
 * Delete a shared link
 */
export function deleteSharedLink(fileId: string): void {
  const sharedLinks = getAllSharedLinks();
  delete sharedLinks[fileId];

  if (typeof window !== 'undefined') {
    localStorage.setItem(SHARED_LINKS_KEY, JSON.stringify(sharedLinks));
  }
}
