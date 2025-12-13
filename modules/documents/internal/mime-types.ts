import * as path from 'path';

/**
 * Common MIME types for document processing.
 */
export const MIME_TYPES = {
  // Documents
  PDF: 'application/pdf',
  CSV: 'text/csv',
  TXT: 'text/plain',
  HTML: 'text/html',
  XML: 'application/xml',
  JSON: 'application/json',

  // Microsoft Office
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  DOC: 'application/msword',
  XLS: 'application/vnd.ms-excel',
  PPT: 'application/vnd.ms-powerpoint',

  // Images (may overlap with ImageContent)
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  GIF: 'image/gif',
  WEBP: 'image/webp',

  // Other
  MD: 'text/markdown',
  RTF: 'application/rtf',
  ZIP: 'application/zip',
} as const;

/**
 * File extension to MIME type mapping.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  // Documents
  '.pdf': MIME_TYPES.PDF,
  '.csv': MIME_TYPES.CSV,
  '.txt': MIME_TYPES.TXT,
  '.html': MIME_TYPES.HTML,
  '.htm': MIME_TYPES.HTML,
  '.xml': MIME_TYPES.XML,
  '.json': MIME_TYPES.JSON,

  // Microsoft Office (modern)
  '.docx': MIME_TYPES.DOCX,
  '.xlsx': MIME_TYPES.XLSX,
  '.pptx': MIME_TYPES.PPTX,

  // Microsoft Office (legacy)
  '.doc': MIME_TYPES.DOC,
  '.xls': MIME_TYPES.XLS,
  '.ppt': MIME_TYPES.PPT,

  // Images
  '.jpg': MIME_TYPES.JPEG,
  '.jpeg': MIME_TYPES.JPEG,
  '.png': MIME_TYPES.PNG,
  '.gif': MIME_TYPES.GIF,
  '.webp': MIME_TYPES.WEBP,

  // Other
  '.md': MIME_TYPES.MD,
  '.markdown': MIME_TYPES.MD,
  '.rtf': MIME_TYPES.RTF,
  '.zip': MIME_TYPES.ZIP,
};

/**
 * Detect MIME type from file path based on extension.
 * Falls back to 'application/octet-stream' for unknown types.
 *
 * @param filePath - Path to the file
 * @returns MIME type string
 */
export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_MIME[ext] || 'application/octet-stream';
}

/**
 * Check if a MIME type is a document type (non-image).
 * Useful for routing between DocumentContent and ImageContent.
 *
 * @param mimeType - MIME type to check
 * @returns true if document type, false if image type
 */
export function isDocumentMimeType(mimeType: string): boolean {
  return !mimeType.startsWith('image/');
}

