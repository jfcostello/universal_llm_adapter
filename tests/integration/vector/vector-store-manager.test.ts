import { jest } from '@jest/globals';
import { VectorStoreManager } from '@/managers/vector-store-manager.ts';
import { EmbeddingManager } from '@/managers/embedding-manager.ts';
import MemoryCompat from '@/plugins/vector-compat/memory.ts';
import type { IVectorStoreCompat, VectorStoreConfig, EmbeddingPriorityItem } from '@/core/types.ts';

describe('integration/vector/vector-store-manager', () => {
  describe('basic adapter interface', () => {
    function createAdapter(results: any[]) {
      return {
        query: jest.fn().mockResolvedValue(results),
        upsert: jest.fn().mockResolvedValue(undefined),
        deleteByIds: jest.fn().mockResolvedValue(undefined)
      };
    }

    test('queryWithPriority resolves using first adapter that returns results', async () => {
      const adapters = new Map<string, any>([
        ['store-a', createAdapter([])],
        ['store-b', createAdapter([{ id: 'match' }])]
      ]);

      const manager = new VectorStoreManager(new Map(), adapters, async () => [0.1, 0.2]);

      const result = await manager.queryWithPriority(['store-a', 'store-b'], 'query', 5);

      expect(result.store).toBe('store-b');
      expect(result.results).toHaveLength(1);
      expect(adapters.get('store-a')!.query).toHaveBeenCalled();
      expect(adapters.get('store-b')!.query).toHaveBeenCalled();
    });

    test('upsert and delete delegate to registered adapter', async () => {
      const adapter = createAdapter([]);
      const adapters = new Map<string, any>([['memory', adapter]]);
      const manager = new VectorStoreManager(new Map(), adapters, async () => [1]);

      await manager.upsert('memory', [{ id: '1' }]);
      await manager.deleteByIds('memory', ['1']);

      expect(adapter.upsert).toHaveBeenCalledWith([{ id: '1' }]);
      expect(adapter.deleteByIds).toHaveBeenCalledWith(['1']);
    });
  });

  describe('full flow with Memory compat', () => {
    let memoryCompat: MemoryCompat;
    let manager: VectorStoreManager;
    const mockEmbedder = async (text: string | string[]) => {
      // Simple mock embedder - returns consistent vectors based on text hash
      const texts = Array.isArray(text) ? text : [text];
      const vectors = texts.map(t => {
        const hash = t.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        return [hash % 1, (hash * 2) % 1, (hash * 3) % 1];
      });
      return Array.isArray(text) ? vectors : vectors[0];
    };

    beforeEach(async () => {
      memoryCompat = new MemoryCompat();
      await memoryCompat.connect({
        id: 'test-memory',
        kind: 'memory',
        connection: {}
      });

      // Create collection
      await memoryCompat.createCollection('documents', 3);

      const mockRegistry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'test-memory',
          kind: 'memory',
          connection: {},
          defaultCollection: 'documents'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(memoryCompat)
      };

      const configs = new Map<string, VectorStoreConfig>();
      configs.set('test-memory', {
        id: 'test-memory',
        kind: 'memory',
        connection: {},
        defaultCollection: 'documents'
      });

      manager = new VectorStoreManager(
        configs,
        new Map(),
        mockEmbedder,
        mockRegistry
      );
    });

    afterEach(async () => {
      await manager.closeAll();
    });

    test('upsert, query, and delete full flow', async () => {
      // Upsert some documents
      await manager.upsert('test-memory', [
        { id: 'doc1', vector: [0.1, 0.2, 0.3], payload: { text: 'Hello world', category: 'greeting' } },
        { id: 'doc2', vector: [0.4, 0.5, 0.6], payload: { text: 'Goodbye world', category: 'farewell' } },
        { id: 'doc3', vector: [0.11, 0.21, 0.31], payload: { text: 'Hi there', category: 'greeting' } }
      ]);

      // Query without filter
      const { store, results } = await manager.queryWithPriority(
        ['test-memory'],
        'test query',
        2
      );

      expect(store).toBe('test-memory');
      expect(results.length).toBeLessThanOrEqual(2);

      // Query with filter
      const filteredResult = await manager.queryWithPriority(
        ['test-memory'],
        'test query',
        10,
        { category: 'greeting' }
      );

      // All results should be greetings (filter applied)
      for (const r of filteredResult.results) {
        expect(r.payload?.category).toBe('greeting');
      }

      // Delete a document
      await manager.deleteByIds('test-memory', ['doc1']);

      // Query again - doc1 should be gone
      const afterDelete = await manager.queryWithPriority(
        ['test-memory'],
        'test query',
        10
      );

      const ids = afterDelete.results.map(r => r.id);
      expect(ids).not.toContain('doc1');
    });

    test('priority fallback with multiple stores', async () => {
      // Create a second memory compat that returns empty results
      const emptyCompat = new MemoryCompat();
      await emptyCompat.connect({ id: 'empty', kind: 'memory', connection: {} });
      await emptyCompat.createCollection('empty-col', 3);

      let callCount = 0;
      const mockRegistry = {
        getVectorStore: jest.fn().mockImplementation(async (id: string) => ({
          id,
          kind: 'memory',
          connection: {},
          defaultCollection: id === 'empty-store' ? 'empty-col' : 'documents'
        })),
        getVectorStoreCompat: jest.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1 ? emptyCompat : memoryCompat;
        })
      };

      const multiManager = new VectorStoreManager(
        new Map(),
        new Map(),
        mockEmbedder,
        mockRegistry
      );

      // Add data to the second store only
      await memoryCompat.upsert('documents', [
        { id: 'found', vector: [0.5, 0.5, 0.5], payload: { text: 'Found me!' } }
      ]);

      const { store, results } = await multiManager.queryWithPriority(
        ['empty-store', 'test-memory'],
        'find me',
        5
      );

      expect(store).toBe('test-memory');
      expect(results.length).toBeGreaterThan(0);

      await multiManager.closeAll();
      await emptyCompat.close();
    });

    test('getCompat returns underlying compat for advanced operations', async () => {
      const compat = await manager.getCompat('test-memory');

      expect(compat).toBe(memoryCompat);

      // Use compat directly for advanced operations
      const exists = await compat!.collectionExists('documents');
      expect(exists).toBe(true);

      const notExists = await compat!.collectionExists('nonexistent');
      expect(notExists).toBe(false);
    });

    test('closeAll properly closes all connections', async () => {
      // Get compat to ensure it's loaded
      await manager.getCompat('test-memory');

      // Close all
      await manager.closeAll();

      // After close, getCompat should load fresh (we can verify by checking registry calls)
      // This is a smoke test - just ensure no errors
    });
  });

  describe('with EmbeddingManager integration', () => {
    test('createEmbedderFn integrates with VectorStoreManager', async () => {
      // Create mock embedding compat
      const mockEmbeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(3)
      };

      const mockRegistry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-embedder',
          kind: 'openrouter',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 3
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(mockEmbeddingCompat)
      };

      const embeddingManager = new EmbeddingManager(mockRegistry);
      const embedFn = embeddingManager.createEmbedderFn([{ provider: 'test-embedder' }]);

      // Create vector store manager with embedding function
      const memoryCompat = new MemoryCompat();
      await memoryCompat.connect({ id: 'mem', kind: 'memory', connection: {} });
      await memoryCompat.createCollection('test', 3);

      const vectorRegistry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'mem',
          kind: 'memory',
          connection: {},
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(memoryCompat)
      };

      const manager = new VectorStoreManager(
        new Map(),
        new Map(),
        embedFn,
        vectorRegistry
      );

      // Upsert and query
      await manager.upsert('mem', [
        { id: 'doc1', vector: [0.1, 0.2, 0.3], payload: { text: 'test' } }
      ]);

      const { results } = await manager.queryWithPriority(['mem'], 'test query', 5);

      expect(results.length).toBe(1);
      expect(mockEmbeddingCompat.embed).toHaveBeenCalled();

      await manager.closeAll();
    });
  });
});
