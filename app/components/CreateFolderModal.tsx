'use client';
import React, { useState, useEffect, useRef } from 'react';
import { Modal } from './Modal';

interface CreateFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (folderName: string) => void;
  isLoading?: boolean;
}

export function CreateFolderModal({
  isOpen,
  onClose,
  onCreate,
  isLoading = false,
}: CreateFolderModalProps) {
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setFolderName('');
      setError('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const validateFolderName = (name: string): string | null => {
    if (!name.trim()) {
      return 'Folder name is required';
    }
    if (name.includes('/') || name.includes('\\')) {
      return 'Folder name cannot contain slashes';
    }
    if (name.startsWith('.')) {
      return 'Folder name cannot start with a dot';
    }
    if (/[<>:"|?*]/.test(name)) {
      return 'Folder name contains invalid characters';
    }
    return null;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateFolderName(folderName);
    if (validationError) {
      setError(validationError);
      return;
    }
    onCreate(folderName.trim());
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFolderName(e.target.value);
    if (error) {
      setError('');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create New Folder" size="sm">
      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          <div className="form-group">
            <label htmlFor="folderName">Folder Name</label>
            <input
              ref={inputRef}
              id="folderName"
              type="text"
              value={folderName}
              onChange={handleChange}
              placeholder="Enter folder name"
              className={error ? 'input-error' : ''}
              disabled={isLoading}
            />
            {error && <span className="error-text">{error}</span>}
          </div>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!folderName.trim() || isLoading}
          >
            {isLoading ? 'Creating...' : 'Create Folder'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
