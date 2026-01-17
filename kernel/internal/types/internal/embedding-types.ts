import type { JsonObject } from './json.js';

/**
 * Configuration for an embedding provider (loaded from JSON)
 */
export interface EmbeddingProviderConfig {
  id: string;
  kind: string;
  endpoint: {
    urlTemplate: string;
    headers: Record<string, string>;
  };
  model: string;
  dimensions?: number;
  metadata?: JsonObject;
}

/**
 * Priority item for embedding - which provider/model to try
 */
export interface EmbeddingPriorityItem {
  provider: string;
  model?: string;
}

/**
 * Result from an embedding operation
 */
export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  tokenCount?: number;
}
