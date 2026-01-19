'use client';
import React, { useState, useEffect, useRef } from 'react';
import { Modal } from './Modal';

interface RenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRename: (newName: string) => void;
  currentName: string;
  itemType: 'file' | 'folder';
  isLoading?: boolean;
}

export function RenameModal({
  isOpen,
  onClose,
  onRename,
  currentName,
  itemType,
  isLoading = false,
}: RenameModalProps) {
  const [newName, setNewName] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNewName(currentName);
  }, [currentName]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      // Select name without extension for files
      if (itemType === 'file') {
        const lastDotIndex = currentName.lastIndexOf('.');
        if (lastDotIndex > 0) {
          inputRef.current.setSelectionRange(0, lastDotIndex);
        } else {
          inputRef.current.select();
        }
      } else {
        inputRef.current.select();
      }
    }
  }, [isOpen, currentName, itemType]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim() && newName !== currentName) {
      onRename(newName.trim());
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Rename ${itemType === 'folder' ? 'Folder' : 'File'}`}
      size="sm"
      footer={
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => handleSubmit({ preventDefault: () => {} } as React.FormEvent)}
            disabled={isLoading || !newName.trim() || newName === currentName}
          >
            {isLoading ? (
              <span className="btn-loading">
                <span className="spinner" />
                Renaming...
              </span>
            ) : (
              'Rename'
            )}
          </button>
        </div>
      }
    >
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="rename-input">New name</label>
          <input
            ref={inputRef}
            id="rename-input"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`Enter ${itemType} name`}
            className="form-input"
          />
        </div>
      </form>
    </Modal>
  );
}
