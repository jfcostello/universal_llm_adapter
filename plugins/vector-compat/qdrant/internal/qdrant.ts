import { QdrantClient } from '@qdrant/js-client-rest';
import {
  IVectorStoreCompat,
  VectorStoreConfig,
  VectorPoint,
  VectorQueryResult,
  VectorQueryOptions,
  JsonObject,
  IVectorOperationLogger,
  VectorStoreError
} from '../../../../kernel/index.js';
import type { QdrantClientFactory } from './client/create-client.js';
import { connectQdrant } from './operations/connect.js';
import { queryQdrant } from './operations/query.js';
import { upsertQdrant } from './operations/upsert.js';
import { deleteByIdsQdrant } from './operations/delete-by-ids.js';
import {
  collectionExistsQdrant,
  createCollectionQdrant,
  createPayloadIndexQdrant,
  deleteCollectionQdrant,
  listCollectionsQdrant
} from './operations/collections.js';

/**
 * Qdrant Vector Store Compat Module
 *
 * Handles communication with Qdrant vector database.
 * Supports both local (host:port) and cloud (url+apiKey) configurations.
 */
export default class QdrantCompat implements IVectorStoreCompat {
  private client: QdrantClient | null = null;
  private config: VectorStoreConfig | null = null;
  private clientFactory: QdrantClientFactory;
  private logger?: IVectorOperationLogger;

  constructor(clientFactory?: QdrantClientFactory) {
    this.clientFactory = clientFactory || ((opts) => new QdrantClient(opts));
  }

  setLogger(logger: IVectorOperationLogger): void {
    this.logger = logger;
  }

  async connect(config: VectorStoreConfig): Promise<void> {
    const client = await connectQdrant({
      config,
      clientFactory: this.clientFactory,
      logger: this.logger
    });

    this.client = client;
    this.config = config;
  }

  async close(): Promise<void> {
    // QdrantClient doesn't require explicit closing
    this.client = null;
    this.config = null;
  }

  async query(
    collection: string,
    vector: number[],
    topK: number,
    options?: VectorQueryOptions
  ): Promise<VectorQueryResult[]> {
    this.requireClient();
    return queryQdrant({
      client: this.client!,
      storeId: this.config!.id,
      collection,
      vector,
      topK,
      queryOptions: options,
      logger: this.logger
    });
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    this.requireClient();
    return upsertQdrant({
      client: this.client!,
      storeId: this.config!.id,
      collection,
      points,
      logger: this.logger
    });
  }

  async createPayloadIndex(
    collection: string,
    field: string,
    schema: any
  ): Promise<void> {
    this.requireClient();
    return createPayloadIndexQdrant({
      client: this.client!,
      storeId: this.config!.id,
      collection,
      field,
      schema,
      logger: this.logger
    });
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    this.requireClient();
    return deleteByIdsQdrant({
      client: this.client!,
      storeId: this.config!.id,
      collection,
      ids,
      logger: this.logger
    });
  }

  async collectionExists(collection: string): Promise<boolean> {
    this.requireClient();
    return collectionExistsQdrant({
      client: this.client!,
      storeId: this.config!.id,
      collection
    });
  }

  async createCollection(
    collection: string,
    dimensions: number,
    options?: JsonObject
  ): Promise<void> {
    this.requireClient();
    return createCollectionQdrant({
      client: this.client!,
      storeId: this.config!.id,
      collection,
      dimensions,
      createOptions: options,
      logger: this.logger
    });
  }

  async listCollections(): Promise<string[]> {
    this.requireClient();
    return listCollectionsQdrant({ client: this.client! });
  }

  async deleteCollection(collection: string): Promise<void> {
    this.requireClient();
    return deleteCollectionQdrant({ client: this.client!, collection });
  }

  private requireClient(): void {
    if (!this.client || !this.config) {
      throw new VectorStoreError('Not connected. Call connect() first.');
    }
  }
}
