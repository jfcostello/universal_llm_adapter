import {
  IVectorStoreCompat,
  VectorStoreConfig,
  VectorPoint,
  VectorQueryResult,
  VectorQueryOptions,
  JsonObject,
  IVectorOperationLogger,
  VectorStoreError
} from '../../../../modules/kernel/index.js';
import { queryCollection } from './query.js';
import {
  clearCollections,
  collectionExists as collectionExistsInStore,
  createCollection as createCollectionInStore,
  deleteCollection as deleteCollectionInStore,
  deletePointsByIds,
  getCollection,
  getCollectionPoints as getCollectionPointsFromStore,
  listCollections as listCollectionsInStore,
  upsertPoints
} from './store.js';

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
  private logger?: IVectorOperationLogger;

  setLogger(logger: IVectorOperationLogger): void {
    this.logger = logger;
  }

  async connect(config: VectorStoreConfig): Promise<void> {
    this.config = config;
    this.connected = true;
  }

  async close(): Promise<void> {
    clearCollections(this.collections);
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

    const coll = getCollection(this.collections, collection);
    if (!coll || coll.size === 0) {
      return [];
    }

    return queryCollection(coll, vector, topK, options);
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    this.requireConnected();
    upsertPoints(this.collections, collection, points);
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    this.requireConnected();
    deletePointsByIds(this.collections, collection, ids);
  }

  async collectionExists(collection: string): Promise<boolean> {
    this.requireConnected();
    return collectionExistsInStore(this.collections, collection);
  }

  async createCollection(
    collection: string,
    _dimensions: number,
    _options?: JsonObject
  ): Promise<void> {
    this.requireConnected();
    createCollectionInStore(this.collections, collection);
  }

  async deleteCollection(collection: string): Promise<void> {
    this.requireConnected();
    deleteCollectionInStore(this.collections, collection);
  }

  async listCollections(): Promise<string[]> {
    this.requireConnected();
    return listCollectionsInStore(this.collections);
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
    return getCollectionPointsFromStore(this.collections, collection);
  }

  /**
   * Utility method for tests - clear all data
   */
  clear(): void {
    clearCollections(this.collections);
  }
}
