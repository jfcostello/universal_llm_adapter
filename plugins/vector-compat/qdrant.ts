import { QdrantClient } from '@qdrant/js-client-rest';
import {
  IVectorStoreCompat,
  VectorStoreConfig,
  VectorPoint,
  VectorQueryResult,
  VectorQueryOptions,
  JsonObject,
  IVectorOperationLogger
} from '../../core/types.js';
import { VectorStoreConnectionError, VectorStoreError } from '../../core/errors.js';

// Factory type for creating Qdrant clients (allows test injection)
export type QdrantClientFactory = (options: { host?: string; port?: number; url?: string; apiKey?: string }) => QdrantClient;

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
    this.config = config;
    const conn = config.connection;
    const startTime = Date.now();

    // Log connect request
    this.logger?.logVectorRequest({
      operation: 'connect',
      store: config.id,
      params: {
        url: conn.url ? String(conn.url).replace(/\/\/[^:]+:[^@]+@/, '//***:***@') : undefined,
        host: conn.host as string | undefined,
        port: conn.port as number | undefined,
        hasApiKey: !!conn.apiKey
      }
    });

    try {
      if (conn.url) {
        // Cloud configuration
        this.client = this.clientFactory({
          url: conn.url as string,
          apiKey: conn.apiKey as string | undefined
        });
      } else if (conn.host) {
        // Local configuration
        this.client = this.clientFactory({
          host: conn.host as string,
          port: (conn.port as number) || 6333
        });
      } else {
        throw new VectorStoreConnectionError(
          config.id,
          'Invalid connection config: must specify either "url" or "host"'
        );
      }

      // Verify connection by listing collections
      await this.client.getCollections();

      // Log success
      this.logger?.logVectorResponse({
        operation: 'connect',
        store: config.id,
        result: 'success',
        duration: Date.now() - startTime
      });
    } catch (error: any) {
      // Log failure
      this.logger?.logVectorResponse({
        operation: 'connect',
        store: config.id,
        result: { error: error.message },
        duration: Date.now() - startTime
      });

      if (error instanceof VectorStoreConnectionError) {
        throw error;
      }
      throw new VectorStoreConnectionError(config.id, error.message);
    }
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
    const storeId = this.config!.id;
    const startTime = Date.now();

    // Log query request
    this.logger?.logVectorRequest({
      operation: 'query',
      store: storeId,
      collection,
      params: {
        vectorDimensions: vector.length,
        topK,
        filter: options?.filter,
        includePayload: options?.includePayload !== false,
        includeVector: options?.includeVector || false
      }
    });

    try {
      const searchParams: any = {
        vector,
        limit: topK,
        with_payload: options?.includePayload !== false,
        with_vector: options?.includeVector || false
      };

      // Convert generic filter to Qdrant format
      if (options?.filter) {
        searchParams.filter = this.convertFilter(options.filter);
      }

      const results = await this.client!.search(collection, searchParams);

      const mappedResults = results.map(item => ({
        id: String(item.id),
        score: item.score,
        payload: item.payload as JsonObject | undefined,
        vector: item.vector as number[] | undefined
      }));

      // Log success
      this.logger?.logVectorResponse({
        operation: 'query',
        store: storeId,
        collection,
        result: {
          count: mappedResults.length,
          topScore: mappedResults[0]?.score,
          ids: mappedResults.map(r => r.id)
        },
        duration: Date.now() - startTime
      });

      return mappedResults;
    } catch (error: any) {
      // Log failure
      this.logger?.logVectorResponse({
        operation: 'query',
        store: storeId,
        collection,
        result: { error: error.message },
        duration: Date.now() - startTime
      });

      throw new VectorStoreError(
        `Query failed: ${error.message}`,
        storeId,
        collection
      );
    }
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    this.requireClient();
    const storeId = this.config!.id;
    const startTime = Date.now();

    // Log upsert request
    this.logger?.logVectorRequest({
      operation: 'upsert',
      store: storeId,
      collection,
      params: {
        pointCount: points.length,
        ids: points.map(p => p.id),
        vectorDimensions: points[0]?.vector.length
      }
    });

    try {
      const qdrantPoints = points.map(point => ({
        id: point.id,
        vector: point.vector,
        payload: point.payload || {}
      }));

      await this.client!.upsert(collection, {
        wait: true,
        points: qdrantPoints
      });

      // Log success
      this.logger?.logVectorResponse({
        operation: 'upsert',
        store: storeId,
        collection,
        result: { success: true, pointCount: points.length },
        duration: Date.now() - startTime
      });
    } catch (error: any) {
      // Log failure
      this.logger?.logVectorResponse({
        operation: 'upsert',
        store: storeId,
        collection,
        result: { error: error.message },
        duration: Date.now() - startTime
      });

      throw new VectorStoreError(
        `Upsert failed: ${error.message}`,
        storeId,
        collection
      );
    }
  }

  async createPayloadIndex(
    collection: string,
    field: string,
    schema: any
  ): Promise<void> {
    this.requireClient();
    const storeId = this.config!.id;
    const startTime = Date.now();

    this.logger?.logVectorRequest({
      operation: 'createPayloadIndex',
      store: storeId,
      collection,
      params: { field, schema }
    });

    try {
      await this.client!.createPayloadIndex(collection, {
        field_name: field,
        field_schema: schema
      });

      this.logger?.logVectorResponse({
        operation: 'createPayloadIndex',
        store: storeId,
        collection,
        result: 'success',
        duration: Date.now() - startTime
      });
    } catch (error: any) {
      this.logger?.logVectorResponse({
        operation: 'createPayloadIndex',
        store: storeId,
        collection,
        result: { error: error.message },
        duration: Date.now() - startTime
      });
      throw new VectorStoreError(
        `Create payload index failed: ${error.message}`,
        storeId,
        collection
      );
    }
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    this.requireClient();
    const storeId = this.config!.id;
    const startTime = Date.now();

    // Log delete request
    this.logger?.logVectorRequest({
      operation: 'delete',
      store: storeId,
      collection,
      params: { idCount: ids.length, ids }
    });

    try {
      await this.client!.delete(collection, {
        wait: true,
        points: ids
      });

      // Log success
      this.logger?.logVectorResponse({
        operation: 'delete',
        store: storeId,
        collection,
        result: { success: true, deletedCount: ids.length },
        duration: Date.now() - startTime
      });
    } catch (error: any) {
      // Log failure
      this.logger?.logVectorResponse({
        operation: 'delete',
        store: storeId,
        collection,
        result: { error: error.message },
        duration: Date.now() - startTime
      });

      throw new VectorStoreError(
        `Delete failed: ${error.message}`,
        storeId,
        collection
      );
    }
  }

  async collectionExists(collection: string): Promise<boolean> {
    this.requireClient();

    try {
      const { collections } = await this.client!.getCollections();
      return collections.some(c => c.name === collection);
    } catch (error: any) {
      throw new VectorStoreError(
        `Failed to check collection existence: ${error.message}`,
        this.config!.id,
        collection
      );
    }
  }

  async createCollection(
    collection: string,
    dimensions: number,
    options?: JsonObject
  ): Promise<void> {
    this.requireClient();
    const storeId = this.config!.id;
    const startTime = Date.now();
    const distance =
      ((options as any)?.distance as 'Cosine' | 'Euclid' | 'Dot' | 'Manhattan') || 'Cosine';
    const payloadIndexes = (options as any)?.payloadIndexes as
      | Array<{ field: string; type: 'keyword' | 'integer' | 'float' | 'boolean' }>
      | undefined;

    // Log createCollection request
    this.logger?.logVectorRequest({
      operation: 'createCollection',
      store: storeId,
      collection,
      params: { dimensions, distance, payloadIndexes: payloadIndexes?.length ?? 0 }
    });

    try {
      await this.client!.createCollection(collection, {
        vectors: {
          size: dimensions,
          distance
        }
      });

      if (payloadIndexes?.length) {
        for (const idx of payloadIndexes) {
          const schema =
            idx.type === 'boolean'
              ? 'bool'
              : (idx.type as 'keyword' | 'integer' | 'float' | 'bool');
          await this.client!.createPayloadIndex(collection, {
            field_name: idx.field,
            field_schema: schema
          });
        }
      }

      // Log success
      this.logger?.logVectorResponse({
        operation: 'createCollection',
        store: storeId,
        collection,
        result: { success: true, dimensions, distance, indexes: payloadIndexes?.length ?? 0 },
        duration: Date.now() - startTime
      });
    } catch (error: any) {
      // Log failure
      this.logger?.logVectorResponse({
        operation: 'createCollection',
        store: storeId,
        collection,
        result: { error: error.message },
        duration: Date.now() - startTime
      });

      throw new VectorStoreError(
        `Failed to create collection: ${error.message}`,
        storeId,
        collection
      );
    }
  }

  async listCollections(): Promise<string[]> {
    this.requireClient();
    const res = await this.client!.getCollections();
    return res.collections?.map((c: any) => c.name) ?? [];
  }

  async deleteCollection(collection: string): Promise<void> {
    this.requireClient();
    await this.client!.deleteCollection(collection);
  }

  /**
   * Convert generic JsonObject filter to Qdrant filter format
   *
   * Qdrant filter format:
   * {
   *   must: [{ key: "field", match: { value: "value" } }],
   *   should: [...],
   *   must_not: [...]
   * }
   */
  private convertFilter(filter: JsonObject): any {
    // If filter already has Qdrant structure, use as-is
    if (filter.must || filter.should || filter.must_not) {
      return filter;
    }

    // Convert simple key-value pairs to Qdrant "must" conditions
    const must: any[] = [];
    for (const [key, value] of Object.entries(filter)) {
      if (value !== null && value !== undefined) {
        must.push({
          key,
          match: { value }
        });
      }
    }

    return must.length > 0 ? { must } : undefined;
  }

  private requireClient(): void {
    if (!this.client) {
      throw new VectorStoreError('Not connected. Call connect() first.');
    }
  }
}
