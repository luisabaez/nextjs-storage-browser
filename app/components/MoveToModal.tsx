'use client';
import React, { useState, useEffect } from 'react';
import { Modal } from './Modal';

interface FolderItem {
  path: string;
  name: string;
  level: number;
}

interface MoveToModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMove: (destinationPath: string) => void;
  itemName: string;
  itemType: 'file' | 'folder';
  currentPath: string;
  availableFolders: FolderItem[];
  mode: 'move' | 'copy';
  isLoading?: boolean;
}

export function MoveToModal({
  isOpen,
  onClose,
  onMove,
  itemName,
  itemType,
  currentPath,
  availableFolders,
  mode,
  isLoading = false,
}: MoveToModalProps) {
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isOpen) {
      setSelectedPath('');
      // Expand all root folders by default
      const roots = new Set(availableFolders.filter(f => f.level === 0).map(f => f.path));
      setExpandedFolders(roots);
    }
  }, [isOpen, availableFolders]);

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const isValidDestination = (folderPath: string) => {
    // Can't move to current location
    if (folderPath === currentPath) return false;
    // Can't move folder into itself or its children
    if (itemType === 'folder') {
      const itemPath = currentPath + itemName + '/';
      if (folderPath.startsWith(itemPath)) return false;
    }
    return true;
  };

  const renderFolderTree = () => {
    const rootFolders = availableFolders.filter(f => f.level === 0);

    const renderFolder = (folder: FolderItem) => {
      const children = availableFolders.filter(
        f => f.level === folder.level + 1 && f.path.startsWith(folder.path)
      );
      const isExpanded = expandedFolders.has(folder.path);
      const isValid = isValidDestination(folder.path);
      const isSelected = selectedPath === folder.path;

      return (
        <div key={folder.path} className="folder-tree-item">
          <div
            className={`folder-tree-row ${isSelected ? 'selected' : ''} ${!isValid ? 'disabled' : ''}`}
            style={{ paddingLeft: `${folder.level * 20 + 8}px` }}
            onClick={() => isValid && setSelectedPath(folder.path)}
          >
            {children.length > 0 && (
              <button
                className="folder-expand-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFolder(folder.path);
                }}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            )}
            {children.length === 0 && <span className="folder-expand-spacer" />}
            <span className="folder-icon">📁</span>
            <span className="folder-name">{folder.name}</span>
            {!isValid && folder.path === currentPath && (
              <span className="folder-badge">Current</span>
            )}
          </div>
          {isExpanded && children.length > 0 && (
            <div className="folder-children">
              {children.map(child => renderFolder(child))}
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="folder-tree">
        {/* Root option */}
        <div
          className={`folder-tree-row ${selectedPath === '' ? 'selected' : ''}`}
          onClick={() => setSelectedPath('')}
        >
          <span className="folder-expand-spacer" />
          <span className="folder-icon">🏠</span>
          <span className="folder-name">Root</span>
        </div>
        {rootFolders.map(folder => renderFolder(folder))}
      </div>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`${mode === 'move' ? 'Move' : 'Copy'} "${itemName}"`}
      size="md"
      footer={
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onMove(selectedPath)}
            disabled={isLoading || (selectedPath === '' && mode === 'move')}
          >
            {isLoading ? (
              <span className="btn-loading">
                <span className="spinner" />
                {mode === 'move' ? 'Moving...' : 'Copying...'}
              </span>
            ) : (
              `${mode === 'move' ? 'Move' : 'Copy'} Here`
            )}
          </button>
        </div>
      }
    >
      <div className="move-to-content">
        <p className="move-to-description">
          Select a destination folder to {mode} this {itemType}:
        </p>
        {renderFolderTree()}
        {selectedPath && (
          <div className="selected-destination">
            <strong>Destination:</strong> {selectedPath || 'Root'}
          </div>
        )}
      </div>
    </Modal>
  );
}
