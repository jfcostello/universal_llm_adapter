/**
 * Text chunking utility for vector store ingestion.
 * Splits text into manageable chunks for embedding.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { JsonObject, TextChunk, getDefaults } from '../../kernel/index.js';

export interface ChunkOptions {
  /**
   * Maximum characters per chunk. Default: 500
   */
  chunkSize?: number;

  /**
   * Number of characters to overlap between chunks. Default: 50
   */
  chunkOverlap?: number;

  /**
   * Custom separator to split on (e.g., '\n\n' for paragraphs)
   */
  separator?: string;

  /**
   * Try to preserve sentence boundaries. Default: false
   */
  preserveSentences?: boolean;

  /**
   * Metadata to include with all chunks
   */
  metadata?: JsonObject;
}

// Get defaults from config (lazy loaded)
const getChunkingDefaults = () => getDefaults().chunking;

/**
 * @deprecated Use getChunkingDefaults().size for dynamic access
 */
const DEFAULT_CHUNK_SIZE = 500;
/**
 * @deprecated Use getChunkingDefaults().overlap for dynamic access
 */
const DEFAULT_CHUNK_OVERLAP = 50;

/**
 * Split text into chunks of specified size.
 *
 * @param text - The text to chunk
 * @param options - Chunking options
 * @returns Array of text chunks with IDs and metadata
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const defaults = getChunkingDefaults();
  const chunkSize = options.chunkSize ?? defaults.size;
  const chunkOverlap = Math.min(options.chunkOverlap ?? defaults.overlap, chunkSize - 1);

  // Handle empty or whitespace-only text
  const trimmedText = text.trim();
  if (!trimmedText) {
    return [];
  }

  // If using a separator, split on it first
  if (options.separator) {
    return chunkBySeparator(trimmedText, options);
  }

  // If preserving sentences, use sentence-aware chunking
  if (options.preserveSentences) {
    return chunkBySentences(trimmedText, options);
  }

  // Default character-based chunking
  return chunkByCharacters(trimmedText, chunkSize, chunkOverlap, options.metadata);
}

/**
 * Read a file and chunk its contents.
 *
 * @param filePath - Path to the file
 * @param options - Chunking options
 * @returns Array of text chunks with file metadata
 */
export async function chunkFile(filePath: string, options: ChunkOptions = {}): Promise<TextChunk[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath);

  // Merge file metadata with provided metadata
  const fileMetadata: JsonObject = {
    filename,
    filepath: filePath,
    ...options.metadata
  };

  const chunks = chunkText(content, { ...options, metadata: fileMetadata });

  return chunks;
}

/**
 * Chunk text by character count with overlap.
 */
function chunkByCharacters(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  baseMetadata?: JsonObject
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const step = chunkSize - chunkOverlap;
  let position = 0;
  let chunkIndex = 0;

  while (position < text.length) {
    // Extract chunk
    let end = Math.min(position + chunkSize, text.length);
    let chunkText = text.slice(position, end);

    // Trim whitespace from boundaries
    chunkText = chunkText.trim();

    // Skip empty chunks
    if (chunkText) {
      // Ensure we don't break unicode characters
      chunkText = safeUnicodeSlice(chunkText);

      chunks.push({
        id: randomUUID(),
        text: chunkText,
        metadata: {
          ...baseMetadata,
          chunkIndex
        }
      });
      chunkIndex++;
    }

    position += step;
  }

  return chunks;
}

/**
 * Chunk text by a separator (e.g., paragraphs).
 */
function chunkBySeparator(text: string, options: ChunkOptions): TextChunk[] {
  const separator = options.separator!;
  const chunkSize = options.chunkSize ?? getChunkingDefaults().size;
  const parts = text.split(separator);

  const chunks: TextChunk[] = [];
  let currentChunk = '';
  let chunkIndex = 0;

  for (const part of parts) {
    const trimmedPart = part.trim();
    if (!trimmedPart) continue;

    // If adding this part would exceed chunk size, save current and start new
    if (currentChunk && (currentChunk.length + separator.length + trimmedPart.length) > chunkSize) {
      chunks.push({
        id: randomUUID(),
        text: currentChunk.trim(),
        metadata: {
          ...options.metadata,
          chunkIndex
        }
      });
      chunkIndex++;
      currentChunk = trimmedPart;
    } else {
      currentChunk = currentChunk ? `${currentChunk}${separator}${trimmedPart}` : trimmedPart;
    }
  }

  // Add remaining chunk
  if (currentChunk.trim()) {
    chunks.push({
      id: randomUUID(),
      text: currentChunk.trim(),
      metadata: {
        ...options.metadata,
        chunkIndex
      }
    });
  }

  return chunks;
}

/**
 * Chunk text while trying to preserve sentence boundaries.
 */
function chunkBySentences(text: string, options: ChunkOptions): TextChunk[] {
  const chunkSize = options.chunkSize ?? getChunkingDefaults().size;

  // Split on sentence endings
  const sentencePattern = /[.!?]+[\s]+/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sentencePattern.exec(text)) !== null) {
    sentences.push(text.slice(lastIndex, match.index + match[0].length).trim());
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text as last sentence
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      sentences.push(remaining);
    }
  }

  // Group sentences into chunks
  const chunks: TextChunk[] = [];
  let currentChunk = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    // Sentences always contain at least punctuation from the regex pattern [.!?]+
    // and any remaining text at the end, so empty sentences are not possible
    if (currentChunk && (currentChunk.length + sentence.length + 1) > chunkSize) {
      // Save current chunk
      chunks.push({
        id: randomUUID(),
        text: currentChunk.trim(),
        metadata: {
          ...options.metadata,
          chunkIndex
        }
      });
      chunkIndex++;
      currentChunk = sentence;
    } else {
      currentChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
    }
  }

  // Add remaining chunk
  if (currentChunk.trim()) {
    chunks.push({
      id: randomUUID(),
      text: currentChunk.trim(),
      metadata: {
        ...options.metadata,
        chunkIndex
      }
    });
  }

  return chunks;
}

/**
 * Ensure we don't break Unicode surrogate pairs.
 */
function safeUnicodeSlice(text: string): string {
  // Check if we end on a high surrogate (incomplete pair)
  const lastChar = text.charCodeAt(text.length - 1);
  if (lastChar >= 0xD800 && lastChar <= 0xDBFF) {
    return text.slice(0, -1);
  }

  // Check if we start with a low surrogate (incomplete pair)
  const firstChar = text.charCodeAt(0);
  if (firstChar >= 0xDC00 && firstChar <= 0xDFFF) {
    return text.slice(1);
  }

  return text;
}

