/**
 * Type definitions for Vector Store CLI operations.
 * Used by VectorStoreCoordinator and vector_store_coordinator CLI.
 */

import { JsonObject, EmbeddingPriorityItem, VectorPoint, VectorQueryResult } from './types.js';

/**
 * Specification for vector store operations.
 * Passed to VectorStoreCoordinator.execute()
 */
export interface VectorCallSpec {
  /**
   * The operation to perform
   */
  operation: 'embed' | 'upsert' | 'query' | 'delete' | 'collections';

  /**
   * Target vector store ID (from plugins/vector/*.json)
   */
  store: string;

  /**
   * Collection name (overrides store's defaultCollection)
   */
  collection?: string;

  /**
   * Embedding providers for operations that need embedding.
   * Used by 'embed' and 'query' operations.
   */
  embeddingPriority?: EmbeddingPriorityItem[];

  /**
   * Operation-specific input data
   */
  input?: VectorOperationInput;

  /**
   * Operation settings
   */
  settings?: VectorOperationSettings;

  /**
   * Metadata for logging/correlation
   */
  metadata?: JsonObject;
}

/**
 * Input data for vector operations
 */
export interface VectorOperationInput {
  // For 'embed' operation
  /**
   * Raw texts to embed (IDs auto-generated)
   */
  texts?: string[];

  /**
   * Pre-chunked texts with metadata
   */
  chunks?: TextChunk[];

  /**
   * Path to file to read and chunk
   */
  file?: string;

  // For 'upsert' operation
  /**
   * Pre-computed vectors to upsert
   */
  points?: VectorPoint[];

  // For 'query' operation
  /**
   * Query text (will be embedded)
   */
  query?: string;

  /**
   * Pre-computed query vector
   */
  vector?: number[];

  /**
   * Number of results to return
   */
  topK?: number;

  /**
   * Metadata filter
   */
  filter?: JsonObject;

  /**
   * Minimum similarity score
   */
  scoreThreshold?: number;

  // For 'delete' operation
  /**
   * IDs to delete
   */
  ids?: string[];

  // For 'collections' operation
  /**
   * Collection operation type
   */
  collectionOp?: 'list' | 'create' | 'delete' | 'exists';

  /**
   * Collection name for create/delete/exists
   */
  collectionName?: string;

  /**
   * Dimensions for collection creation
   */
  dimensions?: number;

  /**
   * Optional payload indexes to create when making a collection (store-specific support).
   * Example: [{ field: 'category', type: 'keyword' }]
   */
  payloadIndexes?: Array<{
    field: string;
    type: 'keyword' | 'integer' | 'float' | 'boolean';
  }>;
}

/**
 * A text chunk with optional metadata
 */
export interface TextChunk {
  /**
   * Unique ID (auto-generated if not provided)
   */
  id?: string;

  /**
   * The text content
   */
  text: string;

  /**
   * Metadata to store with the vector
   */
  metadata?: JsonObject;
}

/**
 * Settings for vector operations
 */
export interface VectorOperationSettings {
  /**
   * Characters per chunk when auto-chunking
   */
  chunkSize?: number;

  /**
   * Overlap between chunks (characters)
   */
  chunkOverlap?: number;

  /**
   * Include payload in query results
   */
  includePayload?: boolean;

  /**
   * Include vector in query results
   */
  includeVector?: boolean;

  /**
   * Batch size for large operations
   */
  batchSize?: number;
}

/**
 * Result from a vector operation
 */
export interface VectorOperationResult {
  operation: string;
  success: boolean;
  error?: string;

  // embed operation
  embedded?: number;
  upserted?: number;
  dimensions?: number;

  // query operation
  results?: VectorQueryResult[];

  // delete operation
  deleted?: number;

  // collections operation
  collections?: string[];
  exists?: boolean;
  created?: boolean;
}

/**
 * Streaming event for progress reporting
 */
export interface VectorStreamEvent {
  type: 'progress' | 'result' | 'error' | 'done';
  progress?: {
    current: number;
    total: number;
    message?: string;
  };
  result?: VectorOperationResult;
  error?: string;
}
