import {
  VectorStoreConfig,
  JsonObject,
  IVectorStoreCompat,
  VectorPoint,
  VectorQueryResult,
  VectorQueryOptions,
  IOperationLogger
} from '../core/types.js';
import { VectorStoreError } from '../core/errors.js';

/**
 * Legacy adapter interface for backward compatibility.
 * New code should use IVectorStoreCompat directly.
 */
export interface VectorStoreAdapter {
  query(vector: number[], topK: number, filter?: JsonObject): Promise<any[]>;
  upsert(points: any[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
}

export type EmbedderFn = (text: string | string[]) => Promise<number[] | number[][]>;

/**
 * Wraps an IVectorStoreCompat to provide the simpler VectorStoreAdapter interface.
 * Uses the default collection from config.
 */
class CompatAdapterWrapper implements VectorStoreAdapter {
  constructor(
    private compat: IVectorStoreCompat,
    private collection: string
  ) {}

  async query(vector: number[], topK: number, filter?: JsonObject): Promise<VectorQueryResult[]> {
    const options: VectorQueryOptions | undefined = filter ? { filter } : undefined;
    return this.compat.query(this.collection, vector, topK, options);
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    return this.compat.upsert(this.collection, points);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    return this.compat.deleteByIds(this.collection, ids);
  }
}

/**
 * VectorStoreManager - Agnostic vector store orchestration
 *
 * Supports two modes:
 * 1. Direct adapter injection (for testing/backward compatibility)
 * 2. Registry-based compat loading (for production use)
 */
export class VectorStoreManager {
  private loadedCompats = new Map<string, IVectorStoreCompat>();
  private logger?: IOperationLogger;

  constructor(
    private configs: Map<string, VectorStoreConfig>,
    private adapters: Map<string, VectorStoreAdapter>,
    private embedder?: EmbedderFn,
    private registry?: any,
    logger?: IOperationLogger
  ) {
    this.logger = logger;
  }

  /**
   * Set the embedder function (can be set after construction)
   */
  setEmbedder(embedder: EmbedderFn): void {
    this.embedder = embedder;
  }

  /**
   * Query with priority-based fallback across multiple stores
   */
  async queryWithPriority(
    priority: string[],
    query: string,
    topK = 5,
    filter?: JsonObject
  ): Promise<{ store: string | null; results: any[] }> {
    if (!priority || priority.length === 0) {
      return { store: null, results: [] };
    }

    const vector = await this.embed(query);

    for (const storeId of priority) {
      const adapter = await this.getAdapter(storeId);
      if (!adapter) continue;

      const results = await adapter.query(vector, topK, filter);
      if (results && results.length > 0) {
        return { store: storeId, results };
      }
    }

    return { store: priority[priority.length - 1], results: [] };
  }

  /**
   * Upsert points to a specific store
   * @param storeId - The store ID to upsert to
   * @param points - The vector points to upsert
   * @param collection - Optional collection override (uses default from config if not provided)
   */
  async upsert(storeId: string, points: VectorPoint[], collection?: string): Promise<void> {
    if (collection) {
      // Direct compat access for collection override
      const compat = await this.getCompat(storeId);
      if (!compat) {
        throw new VectorStoreError(`No adapter registered for vector store '${storeId}'`, storeId);
      }
      await compat.upsert(collection, points);
    } else {
      const adapter = await this.requireAdapter(storeId);
      await adapter.upsert(points);
    }
  }

  /**
   * Delete points by ID from a specific store
   * @param storeId - The store ID to delete from
   * @param ids - The IDs to delete
   * @param collection - Optional collection override (uses default from config if not provided)
   */
  async deleteByIds(storeId: string, ids: string[], collection?: string): Promise<void> {
    if (collection) {
      // Direct compat access for collection override
      const compat = await this.getCompat(storeId);
      if (!compat) {
        throw new VectorStoreError(`No adapter registered for vector store '${storeId}'`, storeId);
      }
      await compat.deleteByIds(collection, ids);
    } else {
      const adapter = await this.requireAdapter(storeId);
      await adapter.deleteByIds(ids);
    }
  }

  /**
   * Get the underlying compat for a store (for advanced operations)
   */
  async getCompat(storeId: string): Promise<IVectorStoreCompat | null> {
    // Check if already loaded
    if (this.loadedCompats.has(storeId)) {
      return this.loadedCompats.get(storeId)!;
    }

    // Try to load from registry
    if (!this.registry) {
      return null;
    }

    try {
      const config = await this.registry.getVectorStore(storeId);
      const compat = await this.registry.getVectorStoreCompat(config.kind);

      // Inject logger for operation logging
      if (this.logger && typeof compat.setLogger === 'function') {
        compat.setLogger(this.logger);
      }

      // Connect the compat
      await compat.connect(config);

      this.loadedCompats.set(storeId, compat);
      return compat;
    } catch {
      return null;
    }
  }

  /**
   * Set the logger for this manager and all loaded compats
   */
  setLogger(logger: IOperationLogger): void {
    this.logger = logger;
    // Update all already-loaded compats
    for (const compat of this.loadedCompats.values()) {
      if (typeof compat.setLogger === 'function') {
        compat.setLogger(logger);
      }
    }
  }

  /**
   * Close all loaded compat connections
   */
  async closeAll(): Promise<void> {
    for (const compat of this.loadedCompats.values()) {
      await compat.close();
    }
    this.loadedCompats.clear();
  }

  private async embed(text: string): Promise<number[]> {
    if (!this.embedder) {
      throw new Error('No embedder function provided to VectorStoreManager');
    }

    const result = await this.embedder(text);

    if (Array.isArray(result[0])) {
      // Batch result, take first
      return (result as number[][])[0];
    }

    return result as number[];
  }

  /**
   * Get adapter for a store, creating wrapper from compat if needed
   */
  private async getAdapter(storeId: string): Promise<VectorStoreAdapter | null> {
    // Check direct adapters first (backward compatibility)
    if (this.adapters.has(storeId)) {
      return this.adapters.get(storeId)!;
    }

    // Try to get/load compat and wrap it
    const compat = await this.getCompat(storeId);
    if (!compat) {
      return null;
    }

    // Get config to determine collection
    const config = this.configs.get(storeId) || await this.registry?.getVectorStore(storeId);
    const collection = config?.defaultCollection || 'default';

    // Create and cache wrapper adapter
    const wrapper = new CompatAdapterWrapper(compat, collection);
    this.adapters.set(storeId, wrapper);

    return wrapper;
  }

  private async requireAdapter(storeId: string): Promise<VectorStoreAdapter> {
    const adapter = await this.getAdapter(storeId);
    if (!adapter) {
      throw new VectorStoreError(`No adapter registered for vector store '${storeId}'`, storeId);
    }
    return adapter;
  }
}
