import { QdrantClient } from '@qdrant/js-client-rest';
import {
  IVectorStoreCompat,
  VectorStoreConfig,
  VectorPoint,
  VectorQueryResult,
  VectorQueryOptions,
  JsonObject
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

  constructor(clientFactory?: QdrantClientFactory) {
    this.clientFactory = clientFactory || ((opts) => new QdrantClient(opts));
  }

  async connect(config: VectorStoreConfig): Promise<void> {
    this.config = config;
    const conn = config.connection;

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
    } catch (error: any) {
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

      return results.map(item => ({
        id: String(item.id),
        score: item.score,
        payload: item.payload as JsonObject | undefined,
        vector: item.vector as number[] | undefined
      }));
    } catch (error: any) {
      throw new VectorStoreError(
        `Query failed: ${error.message}`,
        this.config?.id,
        collection
      );
    }
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    this.requireClient();

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
    } catch (error: any) {
      throw new VectorStoreError(
        `Upsert failed: ${error.message}`,
        this.config?.id,
        collection
      );
    }
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    this.requireClient();

    try {
      await this.client!.delete(collection, {
        wait: true,
        points: ids
      });
    } catch (error: any) {
      throw new VectorStoreError(
        `Delete failed: ${error.message}`,
        this.config?.id,
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
        this.config?.id,
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

    try {
      const distance = (options?.distance as 'Cosine' | 'Euclid' | 'Dot' | 'Manhattan') || 'Cosine';
      await this.client!.createCollection(collection, {
        vectors: {
          size: dimensions,
          distance
        }
      });
    } catch (error: any) {
      throw new VectorStoreError(
        `Failed to create collection: ${error.message}`,
        this.config?.id,
        collection
      );
    }
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
