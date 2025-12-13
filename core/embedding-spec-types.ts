/**
 * Specification types for embedding operations exposed via coordinators/CLI/server.
 *
 * This file is intentionally provider-agnostic and contains no runtime logic.
 */

import type { EmbeddingPriorityItem, JsonObject } from './types.js';

export interface EmbeddingCallSpec {
  /**
   * The operation to perform.
   *
   * Note: This is intentionally not an enum so server/CLI wiring does not need
   * to change when new operations are added to the coordinator.
   */
  operation: string;

  /**
   * Provider ID for operations like "dimensions" and "validate".
   */
  provider?: string;

  /**
   * Optional model override for operations like "dimensions".
   */
  model?: string;

  /**
   * Embedding providers to try in priority order.
   * Required for the "embed" operation.
   */
  embeddingPriority?: EmbeddingPriorityItem[];

  /**
   * Operation-specific input data.
   */
  input?: {
    text?: string;
    texts?: string[];
  };

  /**
   * Metadata for logging/correlation.
   */
  metadata?: JsonObject;
}

export interface EmbeddingOperationResult {
  operation: string;
  success: boolean;
  error?: string;

  // embed operation
  vectors?: number[][];
  model?: string;
  dimensions?: number;
  tokenCount?: number;

  // validate operation
  valid?: boolean;
}

