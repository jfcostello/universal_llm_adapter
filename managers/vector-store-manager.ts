import { VectorStoreConfig, JsonObject } from '../core/types.js';

export interface VectorStoreAdapter {
  query(vector: number[], topK: number, filter?: JsonObject): Promise<any[]>;
  upsert(points: any[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
}

export type EmbedderFn = (text: string | string[]) => Promise<number[] | number[][]>;

export class VectorStoreManager {
  constructor(
    private configs: Map<string, VectorStoreConfig>,
    private adapters: Map<string, VectorStoreAdapter>,
    private embedder?: EmbedderFn
  ) {}

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
      const adapter = this.adapters.get(storeId);
      if (!adapter) continue;
      
      const results = await adapter.query(vector, topK, filter);
      if (results && results.length > 0) {
        return { store: storeId, results };
      }
    }
    
    return { store: priority[priority.length - 1], results: [] };
  }

  async upsert(storeId: string, points: any[]): Promise<void> {
    const adapter = this.requireAdapter(storeId);
    await adapter.upsert(points);
  }

  async deleteByIds(storeId: string, ids: string[]): Promise<void> {
    const adapter = this.requireAdapter(storeId);
    await adapter.deleteByIds(ids);
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

  private requireAdapter(storeId: string): VectorStoreAdapter {
    const adapter = this.adapters.get(storeId);
    if (!adapter) {
      throw new Error(`No adapter registered for vector store '${storeId}'`);
    }
    return adapter;
  }
}