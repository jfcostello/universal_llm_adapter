import {
  IVectorStoreCompat,
  VectorStoreConfig,
  VectorPoint,
  VectorQueryResult,
  VectorQueryOptions,
  JsonObject,
  IOperationLogger
} from '../../core/types.js';
import { VectorStoreError } from '../../core/errors.js';

/**
 * In-Memory Vector Store Compat Module
 *
 * Simple in-memory implementation for testing purposes.
 * Uses cosine similarity for vector search.
 */
export default class MemoryCompat implements IVectorStoreCompat {
  private collections = new Map<string, Map<string, VectorPoint>>();
  private connected = false;
  private config: VectorStoreConfig | null = null;
  // Logger is optional for in-memory operations (no HTTP to log)
  private logger?: IOperationLogger;

  setLogger(logger: IOperationLogger): void {
    this.logger = logger;
  }

  async connect(config: VectorStoreConfig): Promise<void> {
    this.config = config;
    this.connected = true;
  }

  async close(): Promise<void> {
    this.collections.clear();
    this.connected = false;
    this.config = null;
  }

  async query(
    collection: string,
    vector: number[],
    topK: number,
    options?: VectorQueryOptions
  ): Promise<VectorQueryResult[]> {
    this.requireConnected();

    const coll = this.collections.get(collection);
    if (!coll || coll.size === 0) {
      return [];
    }

    // Calculate similarity scores for all points
    const scored: Array<{ id: string; score: number; point: VectorPoint }> = [];

    for (const [id, point] of coll.entries()) {
      // Apply filter if provided
      if (options?.filter && !this.matchesFilter(point.payload, options.filter)) {
        continue;
      }

      const score = this.cosineSimilarity(vector, point.vector);
      scored.push({ id, score, point });
    }

    // Sort by score descending and take topK
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, topK);

    return topResults.map(item => ({
      id: item.id,
      score: item.score,
      payload: options?.includePayload !== false ? item.point.payload : undefined,
      vector: options?.includeVector ? item.point.vector : undefined
    }));
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    this.requireConnected();

    if (!this.collections.has(collection)) {
      this.collections.set(collection, new Map());
    }

    const coll = this.collections.get(collection)!;
    for (const point of points) {
      coll.set(point.id, { ...point });
    }
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    this.requireConnected();

    const coll = this.collections.get(collection);
    if (!coll) return;

    for (const id of ids) {
      coll.delete(id);
    }
  }

  async collectionExists(collection: string): Promise<boolean> {
    this.requireConnected();
    return this.collections.has(collection);
  }

  async createCollection(
    collection: string,
    _dimensions: number,
    _options?: JsonObject
  ): Promise<void> {
    this.requireConnected();

    if (!this.collections.has(collection)) {
      this.collections.set(collection, new Map());
    }
  }

  async deleteCollection(collection: string): Promise<void> {
    this.requireConnected();
    this.collections.delete(collection);
  }

  async listCollections(): Promise<string[]> {
    this.requireConnected();
    return Array.from(this.collections.keys());
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Check if payload matches filter conditions
   */
  private matchesFilter(payload: JsonObject | undefined, filter: JsonObject): boolean {
    if (!payload) return false;

    for (const [key, value] of Object.entries(filter)) {
      if (payload[key] !== value) {
        return false;
      }
    }

    return true;
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new VectorStoreError('Not connected. Call connect() first.');
    }
  }

  /**
   * Utility method for tests - get all points in a collection
   */
  getCollectionPoints(collection: string): VectorPoint[] {
    const coll = this.collections.get(collection);
    if (!coll) return [];
    return Array.from(coll.values());
  }

  /**
   * Utility method for tests - clear all data
   */
  clear(): void {
    this.collections.clear();
  }
}
