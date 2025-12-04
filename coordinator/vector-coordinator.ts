/**
 * VectorStoreCoordinator - Orchestrates vector store operations.
 * Handles embed, upsert, query, delete, and collection management.
 */

import { randomUUID } from 'crypto';
import { PluginRegistry } from '../core/registry.js';
import { EmbeddingManager } from '../managers/embedding-manager.js';
import { VectorStoreManager } from '../managers/vector-store-manager.js';
import { VectorPoint, EmbeddingPriorityItem, VectorQueryOptions } from '../core/types.js';
import {
  VectorCallSpec,
  VectorOperationResult,
  VectorStreamEvent,
  TextChunk
} from '../core/vector-spec-types.js';
import { getLogger, AdapterLogger } from '../core/logging.js';

export class VectorStoreCoordinator {
  private registry: PluginRegistry;
  private embeddingManager?: EmbeddingManager;
  private vectorManager?: VectorStoreManager;
  private logger: AdapterLogger;
  private initializedStores: Set<string> = new Set();

  constructor(registry: PluginRegistry) {
    this.registry = registry;
    this.logger = getLogger();
  }

  /**
   * Execute a vector operation and return the result.
   */
  async execute(spec: VectorCallSpec): Promise<VectorOperationResult> {
    try {
      switch (spec.operation) {
        case 'embed':
          return await this.executeEmbed(spec);
        case 'upsert':
          return await this.executeUpsert(spec);
        case 'query':
          return await this.executeQuery(spec);
        case 'delete':
          return await this.executeDelete(spec);
        case 'collections':
          return await this.executeCollections(spec);
        default:
          return {
            operation: (spec as any).operation ?? 'unknown',
            success: false,
            error: `Unknown operation: ${(spec as any).operation}`
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        operation: spec.operation,
        success: false,
        error: message
      };
    }
  }

  /**
   * Execute with progress streaming for batch operations.
   */
  async *executeStream(spec: VectorCallSpec): AsyncGenerator<VectorStreamEvent> {
    try {
      if (spec.operation === 'embed' && spec.input) {
        yield* this.executeEmbedStream(spec);
        return;
      }

      // For non-batch operations, just execute and yield result
      const result = await this.execute(spec);
      yield { type: 'result', result };
      yield { type: 'done' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    }
  }

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    await this.vectorManager?.closeAll();
  }

  // ========================================
  // Operation Implementations
  // ========================================

  private async executeEmbed(spec: VectorCallSpec): Promise<VectorOperationResult> {
    // Validate embedding priority
    if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
      return {
        operation: 'embed',
        success: false,
        error: 'embeddingPriority is required for embed operation'
      };
    }

    // Get texts to embed
    const { texts, chunks } = this.extractTexts(spec);
    if (texts.length === 0) {
      return {
        operation: 'embed',
        success: true,
        embedded: 0,
        upserted: 0
      };
    }

    // Ensure managers are ready
    await this.ensureManagers(spec);

    // Embed texts
    const embeddingResult = await this.embeddingManager!.embed(texts, spec.embeddingPriority);

    // Build points for upsert
    const points: VectorPoint[] = embeddingResult.vectors.map((vector, i) => {
      const chunk = chunks[i];
      return {
        id: chunk.id || randomUUID(),
        vector,
        payload: {
          text: chunk.text,
          ...chunk.metadata
        }
      };
    });

    // Upsert to vector store
    const collection = await this.resolveCollection(spec);
    await this.vectorManager!.upsert(spec.store, points, collection);

    return {
      operation: 'embed',
      success: true,
      embedded: texts.length,
      upserted: points.length,
      dimensions: embeddingResult.dimensions
    };
  }

  private async *executeEmbedStream(spec: VectorCallSpec): AsyncGenerator<VectorStreamEvent> {
    const batchSize = spec.settings?.batchSize ?? 10;

    // Validate embedding priority
    if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
      yield {
        type: 'error',
        error: 'embeddingPriority is required for embed operation'
      };
      return;
    }

    // Get texts to embed
    const { texts, chunks } = this.extractTexts(spec);
    const total = texts.length;

    if (total === 0) {
      yield {
        type: 'result',
        result: { operation: 'embed', success: true, embedded: 0, upserted: 0 }
      };
      yield { type: 'done' };
      return;
    }

    // Ensure managers are ready
    await this.ensureManagers(spec);

    let embedded = 0;
    let dimensions = 0;
    const collection = await this.resolveCollection(spec);

    // Process in batches
    for (let i = 0; i < total; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, total);
      const batchTexts = texts.slice(i, batchEnd);
      const batchChunks = chunks.slice(i, batchEnd);

      yield {
        type: 'progress',
        progress: {
          current: i,
          total,
          message: `Embedding batch ${Math.floor(i / batchSize) + 1}`
        }
      };

      // Embed batch
      const embeddingResult = await this.embeddingManager!.embed(
        batchTexts,
        spec.embeddingPriority!
      );
      dimensions = embeddingResult.dimensions;

      // Build and upsert points
      const points: VectorPoint[] = embeddingResult.vectors.map((vector, j) => {
        const chunk = batchChunks[j];
        return {
          id: chunk.id || randomUUID(),
          vector,
          payload: {
            text: chunk.text,
            ...chunk.metadata
          }
        };
      });

      await this.vectorManager!.upsert(spec.store, points, collection);
      embedded += batchTexts.length;
    }

    yield {
      type: 'progress',
      progress: { current: total, total, message: 'Complete' }
    };

    yield {
      type: 'result',
      result: {
        operation: 'embed',
        success: true,
        embedded,
        upserted: embedded,
        dimensions
      }
    };

    yield { type: 'done' };
  }

  private async executeUpsert(spec: VectorCallSpec): Promise<VectorOperationResult> {
    const points = spec.input?.points;

    if (!points || points.length === 0) {
      return {
        operation: 'upsert',
        success: true
      };
    }

    await this.ensureVectorManager(spec);
    const collection = await this.resolveCollection(spec);
    await this.vectorManager!.upsert(spec.store, points, collection);

    return {
      operation: 'upsert',
      success: true
    };
  }

  private async executeQuery(spec: VectorCallSpec): Promise<VectorOperationResult> {
    const input = spec.input;

    if (!input) {
      return {
        operation: 'query',
        success: false,
        error: 'input is required for query operation'
      };
    }

    // Get or compute query vector
    let queryVector: number[];

    if (input.vector) {
      queryVector = input.vector;
    } else if (input.query) {
      // Need to embed the query
      if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
        return {
          operation: 'query',
          success: false,
          error: 'embeddingPriority is required when querying with text'
        };
      }

      await this.ensureManagers(spec);
      const embeddingResult = await this.embeddingManager!.embed(
        input.query,
        spec.embeddingPriority
      );
      queryVector = embeddingResult.vectors[0];
    } else {
      return {
        operation: 'query',
        success: false,
        error: 'Either query or vector must be provided'
      };
    }

    // Build query options
    const options: VectorQueryOptions = {
      filter: input.filter,
      includePayload: spec.settings?.includePayload ?? true,
      includeVector: spec.settings?.includeVector ?? false
    };

    // Execute query
    await this.ensureVectorManager(spec);
    const collection = await this.resolveCollection(spec);
    const topK = input.topK ?? 5;

    const compat = await this.vectorManager!.getCompat(spec.store);
    if (!compat) {
      return {
        operation: 'query',
        success: false,
        error: `Vector store not found: ${spec.store}`
      };
    }

    let results = await compat.query(collection, queryVector, topK, options);

    // Apply score threshold
    if (input.scoreThreshold !== undefined) {
      results = results.filter(r => r.score >= input.scoreThreshold!);
    }

    return {
      operation: 'query',
      success: true,
      results
    };
  }

  private async executeDelete(spec: VectorCallSpec): Promise<VectorOperationResult> {
    const ids = spec.input?.ids;

    if (!ids || ids.length === 0) {
      return {
        operation: 'delete',
        success: true,
        deleted: 0
      };
    }

    await this.ensureVectorManager(spec);
    const collection = await this.resolveCollection(spec);
    await this.vectorManager!.deleteByIds(spec.store, ids, collection);

    return {
      operation: 'delete',
      success: true,
      deleted: ids.length
    };
  }

  private async executeCollections(spec: VectorCallSpec): Promise<VectorOperationResult> {
    const input = spec.input;
    const op = input?.collectionOp ?? 'list';

    await this.ensureVectorManager(spec);
    const compat = await this.vectorManager!.getCompat(spec.store);

    if (!compat) {
      return {
        operation: 'collections',
        success: false,
        error: `Vector store not found: ${spec.store}`
      };
    }

    switch (op) {
      case 'list': {
        // Not all compats support listCollections - check if method exists
        if (typeof (compat as any).listCollections === 'function') {
          const collections = await (compat as any).listCollections();
          return { operation: 'collections', success: true, collections };
        }
        return {
          operation: 'collections',
          success: false,
          error: 'listCollections not supported by this store'
        };
      }

      case 'create': {
        if (!input?.collectionName) {
          return {
            operation: 'collections',
            success: false,
            error: 'collectionName is required for create'
          };
        }
        if (!input?.dimensions) {
          return {
            operation: 'collections',
            success: false,
            error: 'dimensions is required for create'
          };
        }
        if (compat.createCollection) {
          await compat.createCollection(input.collectionName, input.dimensions);
          return { operation: 'collections', success: true, created: true };
        }
        return {
          operation: 'collections',
          success: false,
          error: 'createCollection not supported by this store'
        };
      }

      case 'delete': {
        if (!input?.collectionName) {
          return {
            operation: 'collections',
            success: false,
            error: 'collectionName is required for delete'
          };
        }
        if (typeof (compat as any).deleteCollection === 'function') {
          await (compat as any).deleteCollection(input.collectionName);
          return { operation: 'collections', success: true };
        }
        return {
          operation: 'collections',
          success: false,
          error: 'deleteCollection not supported by this store'
        };
      }

      case 'exists': {
        if (!input?.collectionName) {
          return {
            operation: 'collections',
            success: false,
            error: 'collectionName is required for exists'
          };
        }
        const exists = await compat.collectionExists(input.collectionName);
        return { operation: 'collections', success: true, exists };
      }

      default:
        return {
          operation: 'collections',
          success: false,
          error: `Unknown collection operation: ${op}`
        };
    }
  }

  // ========================================
  // Helper Methods
  // ========================================

  private extractTexts(spec: VectorCallSpec): { texts: string[]; chunks: TextChunk[] } {
    const input = spec.input;
    if (!input) {
      return { texts: [], chunks: [] };
    }

    const chunks: TextChunk[] = [];

    // From texts array
    if (input.texts) {
      for (const text of input.texts) {
        chunks.push({ text });
      }
    }

    // From chunks array
    if (input.chunks) {
      chunks.push(...input.chunks);
    }

    const texts = chunks.map(c => c.text);
    return { texts, chunks };
  }

  private async resolveCollection(spec: VectorCallSpec): Promise<string> {
    if (spec.collection) {
      return spec.collection;
    }

    // Get default from store config
    const storeConfig = await this.registry.getVectorStore(spec.store);
    return storeConfig.defaultCollection ?? 'default';
  }

  private async ensureManagers(spec: VectorCallSpec): Promise<void> {
    if (!this.embeddingManager) {
      // Pass logger to embedding manager for HTTP request logging
      this.embeddingManager = new EmbeddingManager(this.registry, this.logger);
    }
    await this.ensureVectorManager(spec);
  }

  private async ensureVectorManager(spec: VectorCallSpec): Promise<void> {
    if (!this.vectorManager) {
      // Pass logger to vector manager for operation logging
      this.vectorManager = new VectorStoreManager(
        new Map(),  // configs - will be loaded from registry
        new Map(),  // adapters - will be created via compat
        undefined,  // embedder - not needed, we use EmbeddingManager directly
        this.registry,
        this.logger  // logger for vector operations
      );
    }

    // Initialize the store if not already done
    if (!this.initializedStores.has(spec.store)) {
      const storeConfig = await this.registry.getVectorStore(spec.store);
      const compat = await this.registry.getVectorStoreCompat(storeConfig.kind);
      if (!compat) {
        throw new Error(`Vector store compat not found for kind: ${storeConfig.kind}`);
      }

      // Inject logger for operation logging
      if (typeof compat.setLogger === 'function') {
        compat.setLogger(this.logger);
      }

      await compat.connect(storeConfig);
      this.initializedStores.add(spec.store);
    }
  }
}
