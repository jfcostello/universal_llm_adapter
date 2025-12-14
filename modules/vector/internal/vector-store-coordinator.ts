/**
 * VectorStoreCoordinator - Orchestrates vector store operations.
 * Handles embed, upsert, query, delete, and collection management.
 */

import { randomUUID } from 'crypto';
import type { EmbeddingManager } from '../../embeddings/index.js';
import {
  PluginRegistry,
  VectorPoint,
  EmbeddingPriorityItem,
  VectorQueryOptions,
  VectorCallSpec,
  VectorOperationResult,
  VectorStreamEvent,
  TextChunk,
} from '../../kernel/index.js';
import { VectorStoreManager } from './vector-store-manager.js';
import {
  getEmbeddingLogger,
  getVectorLogger
} from '../../logging/index.js';

export class VectorStoreCoordinator {
  private registry: PluginRegistry;
  private embeddingManager?: EmbeddingManager;
  private vectorManager?: VectorStoreManager;
  private embeddingLogger = getEmbeddingLogger();
  private vectorLogger = getVectorLogger();

  constructor(registry: PluginRegistry) {
    this.registry = registry;
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
    const batchSize = spec.settings?.batchSize ?? 10;

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
    await this.ensureVectorManager(spec);
    const embeddingManager = await this.ensureEmbeddingManager();

    // Resolve collection
    const collection = await this.resolveCollection(spec);

    // Ensure store is available
    const compat = await this.vectorManager!.getCompat(spec.store);
    if (!compat) {
      throw new Error(`Vector store not found: ${spec.store}`);
    }

    // Embed in batches
    let embedded = 0;
    const points: VectorPoint[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, texts.length);
      const batchTexts = texts.slice(i, batchEnd);
      const batchChunks = chunks.slice(i, batchEnd);

      const result = await embeddingManager.embed(batchTexts, spec.embeddingPriority);
      const vectors = result.vectors;

      for (let j = 0; j < vectors.length; j++) {
        const chunk = batchChunks[j];
        points.push({
          id: chunk.id || randomUUID(),
          vector: vectors[j],
          payload: {
            text: chunk.text,
            ...chunk.metadata
          }
        });
      }

      embedded += vectors.length;
    }

    // Upsert points
    await compat.upsert(collection, points);

    return {
      operation: 'embed',
      success: true,
      embedded,
      upserted: points.length,
      dimensions: points[0]?.vector.length
    };
  }

  private async *executeEmbedStream(spec: VectorCallSpec): AsyncGenerator<VectorStreamEvent> {
    const batchSize = spec.settings?.batchSize ?? 10;

    // Validate embedding priority
    if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
      yield { type: 'error', error: 'embeddingPriority is required for embed operation' };
      return;
    }

    // Get texts to embed
    const { texts, chunks } = this.extractTexts(spec);
    if (texts.length === 0) {
      yield { type: 'result', result: { operation: 'embed', success: true, embedded: 0, upserted: 0 } };
      yield { type: 'done' };
      return;
    }

    // Ensure managers are ready
    await this.ensureVectorManager(spec);
    const embeddingManager = await this.ensureEmbeddingManager();

    // Resolve collection
    const collection = await this.resolveCollection(spec);

    // Ensure store is available
    const compat = await this.vectorManager!.getCompat(spec.store);
    if (!compat) {
      yield { type: 'error', error: `Vector store not found: ${spec.store}` };
      return;
    }

    // Embed in batches with progress
    let embedded = 0;
    const points: VectorPoint[] = [];
    const totalBatches = Math.ceil(texts.length / batchSize);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, texts.length);
      const batchTexts = texts.slice(i, batchEnd);
      const batchChunks = chunks.slice(i, batchEnd);
      const batchNumber = Math.floor(i / batchSize) + 1;

      yield {
        type: 'progress',
        progress: {
          current: batchNumber,
          total: totalBatches,
          message: `Embedding batch ${batchNumber}`
        }
      };

      const result = await embeddingManager.embed(batchTexts, spec.embeddingPriority);
      const vectors = result.vectors;

      for (let j = 0; j < vectors.length; j++) {
        const chunk = batchChunks[j];
        points.push({
          id: chunk.id || randomUUID(),
          vector: vectors[j],
          payload: {
            text: chunk.text,
            ...chunk.metadata
          }
        });
      }

      embedded += vectors.length;
    }

    yield {
      type: 'progress',
      progress: {
        current: totalBatches,
        total: totalBatches,
        message: 'Upserting points'
      }
    };

    // Upsert points
    await compat.upsert(collection, points);

    yield {
      type: 'result',
      result: {
        operation: 'embed',
        success: true,
        embedded,
        upserted: points.length,
        dimensions: points[0]?.vector.length
      }
    };
    yield { type: 'done' };
  }

  private async executeUpsert(spec: VectorCallSpec): Promise<VectorOperationResult> {
    if (!spec.input?.points || spec.input.points.length === 0) {
      return { operation: 'upsert', success: true, upserted: 0 };
    }

    await this.ensureVectorManager(spec);

    const collection = await this.resolveCollection(spec);

    const compat = await this.vectorManager!.getCompat(spec.store);
    if (!compat) {
      throw new Error(`Vector store not found: ${spec.store}`);
    }

    await compat.upsert(collection, spec.input.points);

    return { operation: 'upsert', success: true, upserted: spec.input.points.length };
  }

  private async executeQuery(spec: VectorCallSpec): Promise<VectorOperationResult> {
    await this.ensureVectorManager(spec);

    const input = spec.input;
    if (!input) {
      return { operation: 'query', success: false, error: 'input is required for query operation' };
    }

    const compat = await this.vectorManager!.getCompat(spec.store);
    if (!compat) {
      throw new Error(`Vector store not found: ${spec.store}`);
    }

    const collection = await this.resolveCollection(spec);
    const topK = input.topK ?? 5;

    let queryVector: number[] | undefined = input.vector;

    if (!queryVector && input.query) {
      if (!spec.embeddingPriority || spec.embeddingPriority.length === 0) {
        return { operation: 'query', success: false, error: 'embeddingPriority is required when querying with text' };
      }

      const embeddingManager = await this.ensureEmbeddingManager();
      const embedResult = await embeddingManager.embed(input.query, spec.embeddingPriority);
      queryVector = embedResult.vectors[0];
    }

    if (!queryVector) {
      return { operation: 'query', success: false, error: 'Either query or vector must be provided' };
    }

    const options: VectorQueryOptions = {
      filter: input.filter,
      includePayload: spec.settings?.includePayload ?? true,
      includeVector: spec.settings?.includeVector
    };

    let results = await compat.query(collection, queryVector, topK, options);

    if (input.scoreThreshold !== undefined) {
      results = results.filter(r => r.score >= input.scoreThreshold!);
    }

    return { operation: 'query', success: true, results };
  }

  private async executeDelete(spec: VectorCallSpec): Promise<VectorOperationResult> {
    await this.ensureVectorManager(spec);

    const ids = spec.input?.ids;
    if (!ids || ids.length === 0) {
      return { operation: 'delete', success: true, deleted: 0 };
    }

    const collection = await this.resolveCollection(spec);
    const compat = await this.vectorManager!.getCompat(spec.store);
    if (!compat) {
      throw new Error(`Vector store not found: ${spec.store}`);
    }

    await compat.deleteByIds(collection, ids);

    return { operation: 'delete', success: true, deleted: ids.length };
  }

  private async executeCollections(spec: VectorCallSpec): Promise<VectorOperationResult> {
    await this.ensureVectorManager(spec);

    const compat = await this.vectorManager!.getCompat(spec.store);
    if (!compat) {
      throw new Error(`Vector store not found: ${spec.store}`);
    }

    const op = spec.input?.collectionOp ?? 'list';
    const input = spec.input;

    switch (op) {
      case 'list': {
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
        if (!input.dimensions) {
          return {
            operation: 'collections',
            success: false,
            error: 'dimensions is required for create'
          };
        }
        if (typeof (compat as any).createCollection === 'function') {
          await (compat as any).createCollection(input.collectionName, input.dimensions, {
            payloadIndexes: input.payloadIndexes ?? []
          });
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

  private async ensureEmbeddingManager(): Promise<EmbeddingManager> {
    if (!this.embeddingManager) {
      const { EmbeddingManager } = await import('../../embeddings/index.js');
      // Pass logger to embedding manager for HTTP request logging
      this.embeddingManager = new EmbeddingManager(this.registry as any, this.embeddingLogger);
    }
    return this.embeddingManager;
  }

  private async ensureVectorManager(_spec: VectorCallSpec): Promise<void> {
    if (!this.vectorManager) {
      // Pass logger to vector manager for operation logging
      this.vectorManager = new VectorStoreManager(
        new Map(),  // configs - will be loaded from registry
        new Map(),  // adapters - will be created via compat
        undefined,  // embedder - not needed, we use EmbeddingManager directly
        this.registry,
        this.vectorLogger  // logger for vector operations
      );
    }
  }
}
