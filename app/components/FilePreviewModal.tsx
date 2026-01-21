'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { Modal } from './Modal';
import { getUrl } from 'aws-amplify/storage';

interface FilePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: {
    name: string;
    path: string;
    size?: number;
  } | null;
  onDownload: () => void;
}

type PreviewType = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'office' | 'unsupported';

// Supported file extensions for preview
const PREVIEW_EXTENSIONS: Record<PreviewType, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'],
  pdf: ['pdf'],
  video: ['mp4', 'webm', 'ogg', 'mov'],
  audio: ['mp3', 'wav', 'ogg', 'aac', 'm4a'],
  text: ['txt', 'json', 'xml', 'csv', 'md', 'log', 'yaml', 'yml', 'ini', 'cfg', 'conf'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
  unsupported: [],
};

// Code file extensions (shown with syntax highlighting potential)
const CODE_EXTENSIONS = ['js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'sql', 'sh', 'bash', 'ps1', 'bat'];

function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

function getPreviewType(filename: string): PreviewType {
  const ext = getFileExtension(filename);

  for (const [type, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
    if (extensions.includes(ext)) {
      return type as PreviewType;
    }
  }

  // Check if it's a code file (treat as text)
  if (CODE_EXTENSIONS.includes(ext)) {
    return 'text';
  }

  return 'unsupported';
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function FilePreviewModal({ isOpen, onClose, file, onDownload }: FilePreviewModalProps) {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);

  const previewType = file ? getPreviewType(file.name) : 'unsupported';

  // Fetch the signed URL for the file
  const fetchFileUrl = useCallback(async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setTextContent(null);

    try {
      const result = await getUrl({
        path: file.path,
        options: { expiresIn: 3600 },
      });

      const url = result.url.toString();
      setFileUrl(url);

      // For text files, fetch the content
      if (previewType === 'text') {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const text = await response.text();
            // Limit text content to 500KB for performance
            if (text.length > 500000) {
              setTextContent(text.substring(0, 500000) + '\n\n... (Content truncated - file too large to display fully)');
            } else {
              setTextContent(text);
            }
          } else {
            setError('Failed to load text content');
          }
        } catch {
          setError('Failed to load text content');
        }
      }
    } catch (err) {
      console.error('Error fetching file URL:', err);
      setError('Failed to load file preview');
    } finally {
      setLoading(false);
    }
  }, [file, previewType]);

  useEffect(() => {
    if (isOpen && file) {
      fetchFileUrl();
    } else {
      // Reset state when modal closes
      setFileUrl(null);
      setTextContent(null);
      setError(null);
      setLoading(true);
    }
  }, [isOpen, file, fetchFileUrl]);

  const renderPreview = () => {
    if (loading) {
      return (
        <div className="preview-loading">
          <div className="preview-spinner"></div>
          <span>Loading preview...</span>
        </div>
      );
    }

    if (error) {
      return (
        <div className="preview-error">
          <span className="preview-error-icon">!</span>
          <p>{error}</p>
          <button className="btn btn-secondary" onClick={fetchFileUrl}>
            Retry
          </button>
        </div>
      );
    }

    if (!fileUrl) {
      return (
        <div className="preview-error">
          <p>Unable to load file</p>
        </div>
      );
    }

    switch (previewType) {
      case 'image':
        return (
          <div className="preview-image-container">
            <img
              src={fileUrl}
              alt={file?.name}
              className="preview-image"
              onError={() => setError('Failed to load image')}
            />
          </div>
        );

      case 'pdf':
        return (
          <div className="preview-pdf-container">
            <iframe
              src={`${fileUrl}#toolbar=1&navpanes=0`}
              title={file?.name}
              className="preview-pdf"
            />
          </div>
        );

      case 'video':
        return (
          <div className="preview-video-container">
            <video
              controls
              className="preview-video"
              onError={() => setError('Failed to load video')}
            >
              <source src={fileUrl} />
              Your browser does not support video playback.
            </video>
          </div>
        );

      case 'audio':
        return (
          <div className="preview-audio-container">
            <div className="preview-audio-icon">🎵</div>
            <p className="preview-audio-filename">{file?.name}</p>
            <audio
              controls
              className="preview-audio"
              onError={() => setError('Failed to load audio')}
            >
              <source src={fileUrl} />
              Your browser does not support audio playback.
            </audio>
          </div>
        );

      case 'text':
        return (
          <div className="preview-text-container">
            <pre className="preview-text">{textContent || 'No content'}</pre>
          </div>
        );

      case 'office':
        // Use Microsoft Office Online viewer for Office documents
        const officeViewerUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`;
        return (
          <div className="preview-office-container">
            <div className="preview-office-notice">
              <p>Office documents are previewed using Microsoft Office Online.</p>
              <p className="preview-office-note">Note: Preview may take a moment to load. If the preview doesn't appear, the file may need to be downloaded.</p>
            </div>
            <iframe
              src={officeViewerUrl}
              title={file?.name}
              className="preview-office"
            />
          </div>
        );

      default:
        return (
          <div className="preview-unsupported">
            <span className="preview-unsupported-icon">📄</span>
            <h3>Preview not available</h3>
            <p>This file type ({getFileExtension(file?.name || '')}) cannot be previewed in the browser.</p>
            <button className="btn btn-primary" onClick={onDownload}>
              Download to View
            </button>
          </div>
        );
    }
  };

  const getPreviewTitle = () => {
    if (!file) return 'File Preview';
    return file.name;
  };

  const footer = (
    <div className="preview-footer">
      <div className="preview-file-info">
        <span className="preview-file-size">{formatFileSize(file?.size)}</span>
        {previewType !== 'unsupported' && (
          <span className="preview-file-type">
            {previewType.charAt(0).toUpperCase() + previewType.slice(1)}
          </span>
        )}
      </div>
      <div className="preview-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary" onClick={onDownload}>
          <span>⬇️</span> Download
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={getPreviewTitle()}
      size="lg"
      footer={footer}
    >
      <div className="file-preview-content">
        {renderPreview()}
      </div>
    </Modal>
  );
}
