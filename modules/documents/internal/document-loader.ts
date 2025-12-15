import * as fs from 'fs';
import * as path from 'path';
import { detectMimeType } from './mime-types.js';
import type { DocumentContent } from '../../kernel/index.js';

/**
 * Loaded document with all metadata populated.
 */
export interface LoadedDocument {
  data: string;           // Base64-encoded file data
  mimeType: string;       // Detected or provided MIME type
  filename: string;       // Extracted or provided filename
  sizeBytes: number;      // Original file size in bytes
}

/**
 * Load a document from a file path.
 * Reads the file, detects MIME type, encodes to base64.
 *
 * @param filePath - Absolute or relative path to the file
 * @param providedMimeType - Optional MIME type override
 * @param providedFilename - Optional filename override
 * @returns LoadedDocument with base64 data and metadata
 * @throws Error if file doesn't exist or can't be read
 */
export function loadDocumentFromPath(
  filePath: string,
  providedMimeType?: string,
  providedFilename?: string
): LoadedDocument {
  // Check file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Read file
  const fileBuffer = fs.readFileSync(filePath);

  // Encode to base64
  const base64Data = fileBuffer.toString('base64');

  // Detect or use provided MIME type
  const mimeType = providedMimeType || detectMimeType(filePath);

  // Extract or use provided filename
  const filename = providedFilename || path.basename(filePath);

  return {
    data: base64Data,
    mimeType,
    filename,
    sizeBytes: fileBuffer.length
  };
}

/**
 * Load document from already-encoded base64 string.
 * Useful when user has pre-encoded data.
 *
 * @param base64Data - Base64-encoded string
 * @param mimeType - MIME type of the document
 * @param filename - Filename for reference
 * @returns LoadedDocument
 */
export function loadDocumentFromBase64(
  base64Data: string,
  mimeType: string,
  filename?: string
): LoadedDocument {
  // Calculate approximate size
  const sizeBytes = Math.floor(base64Data.length * 0.75); // Base64 is ~33% larger

  return {
    data: base64Data,
    mimeType,
    filename: filename || 'document',
    sizeBytes
  };
}

/**
 * Process a DocumentContent to ensure it has base64 data.
 * Handles filepath sources by loading the file.
 * Passes through base64/url/file_id sources.
 *
 * @param content - DocumentContent from user
 * @returns DocumentContent with populated mimeType and filename
 */
export function processDocumentContent(content: DocumentContent): DocumentContent {
  // If filepath, load the file
  if (content.source.type === 'filepath') {
    const loaded = loadDocumentFromPath(
      content.source.path,
      content.mimeType,
      content.filename
    );

    return {
      ...content,
      source: { type: 'base64', data: loaded.data },
      mimeType: loaded.mimeType,
      filename: loaded.filename
    };
  }

  // For other source types, ensure mimeType and filename are set
  if (!content.mimeType) {
    throw new Error('mimeType is required for non-filepath document sources');
  }

  return {
    ...content,
    filename: content.filename || 'document'
  };
}

