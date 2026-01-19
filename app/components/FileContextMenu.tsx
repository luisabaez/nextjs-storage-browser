'use client';
import React, { useState, useEffect, useRef } from 'react';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  divider?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

interface FileContextMenuProps {
  actions: ContextMenuAction[];
  trigger: React.ReactNode;
}

export function FileContextMenu({ actions, trigger }: FileContextMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  // Position the menu
  useEffect(() => {
    if (isOpen && menuRef.current && triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const menuRect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let top = triggerRect.bottom + 4;
      let left = triggerRect.right - menuRect.width;

      // Adjust if menu goes off-screen
      if (left < 8) {
        left = triggerRect.left;
      }
      if (top + menuRect.height > viewportHeight - 8) {
        top = triggerRect.top - menuRect.height - 4;
      }

      menuRef.current.style.top = `${top}px`;
      menuRef.current.style.left = `${left}px`;
    }
  }, [isOpen]);

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const handleActionClick = (action: ContextMenuAction) => {
    if (!action.disabled) {
      action.onClick();
      setIsOpen(false);
    }
  };

  return (
    <div className="file-context-menu-wrapper" style={{ position: 'relative' }}>
      <div ref={triggerRef} onClick={handleTriggerClick}>
        {trigger}
      </div>

      {isOpen && (
        <div
          ref={menuRef}
          className="file-context-menu"
          style={{
            position: 'fixed',
            zIndex: 1000,
          }}
        >
          {actions.map((action, index) => (
            <React.Fragment key={action.id}>
              {action.divider && index > 0 && <div className="context-menu-divider" />}
              <button
                className={`context-menu-action ${action.danger ? 'danger' : ''} ${action.disabled ? 'disabled' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleActionClick(action);
                }}
                disabled={action.disabled}
              >
                <span className="action-icon">{action.icon}</span>
                <span className="action-label">{action.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
