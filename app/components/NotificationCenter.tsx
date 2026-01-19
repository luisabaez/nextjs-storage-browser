'use client';
import React, { useState } from 'react';

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'upload' | 'download' | 'delete' | 'move' | 'copy' | 'info' | 'error';
  timestamp: Date;
  isRead: boolean;
  fileItemPath?: string;
}

interface NotificationCenterProps {
  isOpen: boolean;
  onClose: () => void;
  notifications: Notification[];
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
  onClearAll: () => void;
  onNavigateToFile?: (path: string) => void;
}

export function NotificationCenter({
  isOpen,
  onClose,
  notifications,
  onMarkAsRead,
  onMarkAllAsRead,
  onClearAll,
  onNavigateToFile,
}: NotificationCenterProps) {
  const unreadCount = notifications.filter(n => !n.isRead).length;

  const getIcon = (type: Notification['type']) => {
    switch (type) {
      case 'upload': return '📤';
      case 'download': return '📥';
      case 'delete': return '🗑️';
      case 'move': return '📦';
      case 'copy': return '📋';
      case 'error': return '❌';
      default: return 'ℹ️';
    }
  };

  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="notification-overlay" onClick={onClose} />
      <div className="notification-center">
        <div className="notification-header">
          <h3>Notifications {unreadCount > 0 && <span className="unread-badge">{unreadCount}</span>}</h3>
          <div className="notification-actions">
            {unreadCount > 0 && (
              <button className="notification-action-btn" onClick={onMarkAllAsRead}>
                Mark all read
              </button>
            )}
            {notifications.length > 0 && (
              <button className="notification-action-btn" onClick={onClearAll}>
                Clear all
              </button>
            )}
            <button className="notification-close-btn" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="notification-list">
          {notifications.length === 0 ? (
            <div className="notification-empty">
              <span className="empty-icon">🔔</span>
              <p>No notifications yet</p>
            </div>
          ) : (
            notifications.map(notification => (
              <div
                key={notification.id}
                className={`notification-item ${notification.isRead ? 'read' : 'unread'}`}
                onClick={() => {
                  onMarkAsRead(notification.id);
                  if (notification.fileItemPath && onNavigateToFile) {
                    onNavigateToFile(notification.fileItemPath);
                    onClose();
                  }
                }}
              >
                <span className="notification-icon">{getIcon(notification.type)}</span>
                <div className="notification-content">
                  <div className="notification-title">{notification.title}</div>
                  <div className="notification-message">{notification.message}</div>
                  <div className="notification-time">{formatTime(notification.timestamp)}</div>
                </div>
                {!notification.isRead && <span className="unread-dot" />}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// Hook for managing notifications
export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const addNotification = (
    title: string,
    message: string,
    type: Notification['type'],
    fileItemPath?: string
  ) => {
    const notification: Notification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title,
      message,
      type,
      timestamp: new Date(),
      isRead: false,
      fileItemPath,
    };
    setNotifications(prev => [notification, ...prev]);
    return notification.id;
  };

  const markAsRead = (id: string) => {
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, isRead: true } : n))
    );
  };

  const markAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const unreadCount = notifications.filter(n => !n.isRead).length;

  return {
    notifications,
    addNotification,
    markAsRead,
    markAllAsRead,
    clearAll,
    unreadCount,
  };
}
