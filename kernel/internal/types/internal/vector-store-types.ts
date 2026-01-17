import type { EmbeddingPriorityItem } from './embedding-types.js';
import type { JsonObject } from './json.js';

export interface VectorStoreConfig {
  id: string;
  kind: string;
  connection: JsonObject;
  defaultCollection?: string;
  /**
   * Default embedding priority for operations that require embeddings when the spec does not provide one.
   * Must reference embedding provider IDs from plugins/embeddings/*.json.
   */
  defaultEmbeddingPriority?: EmbeddingPriorityItem[];
  metadata?: JsonObject;
}

/**
 * A point to store in a vector database
 */
export interface VectorPoint {
  id: string;
  vector: number[];
  payload?: JsonObject;
}

/**
 * Result from a vector similarity search
 */
export interface VectorQueryResult {
  id: string;
  score: number;
  payload?: JsonObject;
  vector?: number[];
}

/**
 * Options for vector queries
 */
export interface VectorQueryOptions {
  filter?: JsonObject;
  includeVector?: boolean;
  includePayload?: boolean;
}
