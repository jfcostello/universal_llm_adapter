import { jest } from '@jest/globals';
import { VectorStoreManager } from '@/managers/vector-store-manager.ts';
import type { IVectorStoreCompat, VectorStoreConfig } from '@/core/types.ts';

function createAdapter(returnResults: any[]) {
  return {
    query: jest.fn().mockResolvedValue(returnResults),
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteByIds: jest.fn().mockResolvedValue(undefined)
  };
}

function createMockCompat(queryResults: any[] = []): IVectorStoreCompat {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(queryResults),
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteByIds: jest.fn().mockResolvedValue(undefined),
    collectionExists: jest.fn().mockResolvedValue(true),
    createCollection: jest.fn().mockResolvedValue(undefined)
  };
}

function createMockRegistry(options: {
  vectorStoreConfig?: VectorStoreConfig;
  compat?: IVectorStoreCompat;
  error?: Error;
} = {}) {
  return {
    getVectorStore: jest.fn().mockImplementation(async () => {
      if (options.error) throw options.error;
      return options.vectorStoreConfig || {
        id: 'test-store',
        kind: 'memory',
        connection: {},
        defaultCollection: 'test-collection'
      };
    }),
    getVectorStoreCompat: jest.fn().mockImplementation(async () => {
      if (options.error) throw options.error;
      return options.compat || createMockCompat();
    })
  };
}

describe('managers/vector-store-manager', () => {
  describe('queryWithPriority', () => {
    test('queries with priority returning first non-empty result', async () => {
      const adapters = new Map<string, any>();
      adapters.set('a', createAdapter([]));
      adapters.set('b', createAdapter([{ id: 1 }]));

      const manager = new VectorStoreManager(new Map(), adapters, async () => [0.1, 0.2]);

      const result = await manager.queryWithPriority(['a', 'b'], 'query', 5);
      expect(result.store).toBe('b');
      expect(result.results).toEqual([{ id: 1 }]);
      expect(adapters.get('a')!.query).toHaveBeenCalled();
      expect(adapters.get('b')!.query).toHaveBeenCalled();
    });

    test('returns last store when no results found and handles batch embedding', async () => {
      const adapters = new Map<string, any>();
      adapters.set('a', createAdapter([]));
      adapters.set('b', createAdapter([]));

      const manager = new VectorStoreManager(
        new Map(),
        adapters,
        async () => [[0.5, 0.7]]
      );

      const result = await manager.queryWithPriority(['a', 'b'], 'query');
      expect(result.store).toBe('b');
      expect(result.results).toEqual([]);
    });

    test('queryWithPriority skips stores without registered adapters', async () => {
      const adapters = new Map<string, any>();
      adapters.set('present', createAdapter([{ id: 1 }]));

      const manager = new VectorStoreManager(new Map(), adapters, async () => [0.2, 0.4]);
      const result = await manager.queryWithPriority(['missing', 'present'], 'query');
      expect(result.store).toBe('present');
      expect(result.results).toEqual([{ id: 1 }]);
    });

    test('queryWithPriority returns null when priority empty and throws without embedder', async () => {
      const adapters = new Map<string, any>();
      const manager = new VectorStoreManager(new Map(), adapters);

      await expect(manager.queryWithPriority([], 'query')).resolves.toEqual({ store: null, results: [] });
      await expect(manager.queryWithPriority(['missing'], 'query')).rejects.toThrow('No embedder function provided');
    });

    test('passes filter to adapter query', async () => {
      const adapter = createAdapter([{ id: 1 }]);
      const adapters = new Map<string, any>([['a', adapter]]);
      const manager = new VectorStoreManager(new Map(), adapters, async () => [0.1]);

      await manager.queryWithPriority(['a'], 'query', 5, { category: 'tech' });

      expect(adapter.query).toHaveBeenCalledWith([0.1], 5, { category: 'tech' });
    });
  });

  describe('upsert and deleteByIds', () => {
    test('delegates upsert and delete and errors on missing adapter', async () => {
      const adapter = createAdapter([]);
      const adapters = new Map<string, any>([['a', adapter]]);
      const manager = new VectorStoreManager(new Map(), adapters, async () => [1]);

      await manager.upsert('a', [{ id: '1', vector: [0.1] }]);
      await manager.deleteByIds('a', ['1']);
      expect(adapter.upsert).toHaveBeenCalledWith([{ id: '1', vector: [0.1] }]);
      expect(adapter.deleteByIds).toHaveBeenCalledWith(['1']);

      await expect(manager.upsert('missing', [])).rejects.toThrow(
        "No adapter registered for vector store 'missing'"
      );
    });
  });

  describe('setEmbedder', () => {
    test('allows setting embedder after construction', async () => {
      const adapters = new Map<string, any>([['a', createAdapter([{ id: 1 }])]]);
      const manager = new VectorStoreManager(new Map(), adapters);

      // Should fail without embedder
      await expect(manager.queryWithPriority(['a'], 'query')).rejects.toThrow('No embedder');

      // Set embedder
      manager.setEmbedder(async () => [0.1, 0.2]);

      // Should work now
      const result = await manager.queryWithPriority(['a'], 'query');
      expect(result.results).toEqual([{ id: 1 }]);
    });
  });

  describe('getCompat', () => {
    test('returns null when no registry and not loaded', async () => {
      const manager = new VectorStoreManager(new Map(), new Map());

      const compat = await manager.getCompat('unknown');

      expect(compat).toBeNull();
    });

    test('loads compat from registry and caches it', async () => {
      const mockCompat = createMockCompat();
      const mockRegistry = createMockRegistry({ compat: mockCompat });
      const manager = new VectorStoreManager(new Map(), new Map(), undefined, mockRegistry);

      // First call - loads from registry
      const compat1 = await manager.getCompat('test-store');
      expect(compat1).toBe(mockCompat);
      expect(mockCompat.connect).toHaveBeenCalled();
      expect(mockRegistry.getVectorStore).toHaveBeenCalledTimes(1);

      // Second call - returns cached
      const compat2 = await manager.getCompat('test-store');
      expect(compat2).toBe(mockCompat);
      expect(mockRegistry.getVectorStore).toHaveBeenCalledTimes(1); // Not called again
    });

    test('returns null when registry throws', async () => {
      const mockRegistry = createMockRegistry({ error: new Error('Not found') });
      const manager = new VectorStoreManager(new Map(), new Map(), undefined, mockRegistry);

      const compat = await manager.getCompat('unknown');

      expect(compat).toBeNull();
    });
  });

  describe('closeAll', () => {
    test('closes all loaded compats and clears cache', async () => {
      const mockCompat1 = createMockCompat();
      const mockCompat2 = createMockCompat();

      let callCount = 0;
      const mockRegistry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'store',
          kind: 'memory',
          connection: {},
          defaultCollection: 'col'
        }),
        getVectorStoreCompat: jest.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1 ? mockCompat1 : mockCompat2;
        })
      };

      const manager = new VectorStoreManager(new Map(), new Map(), undefined, mockRegistry);

      // Load two compats
      await manager.getCompat('store1');
      await manager.getCompat('store2');

      // Close all
      await manager.closeAll();

      expect(mockCompat1.close).toHaveBeenCalled();
      expect(mockCompat2.close).toHaveBeenCalled();

      // Cache should be cleared - next call loads fresh
      callCount = 0;
      await manager.getCompat('store1');
      expect(mockRegistry.getVectorStore).toHaveBeenCalledTimes(3); // 2 before + 1 after closeAll
    });
  });

  describe('CompatAdapterWrapper via getAdapter', () => {
    test('wraps compat with adapter interface using config defaultCollection', async () => {
      const queryResults = [{ id: '1', score: 0.9, payload: { text: 'hello' } }];
      const mockCompat = createMockCompat(queryResults);
      const mockRegistry = createMockRegistry({
        vectorStoreConfig: {
          id: 'test-store',
          kind: 'memory',
          connection: {},
          defaultCollection: 'my-collection'
        },
        compat: mockCompat
      });

      const configs = new Map<string, any>();
      configs.set('test-store', {
        id: 'test-store',
        kind: 'memory',
        connection: {},
        defaultCollection: 'my-collection'
      });

      const manager = new VectorStoreManager(configs, new Map(), async () => [0.1, 0.2], mockRegistry);

      const result = await manager.queryWithPriority(['test-store'], 'query', 5);

      expect(result.results).toEqual(queryResults);
      expect(mockCompat.query).toHaveBeenCalledWith('my-collection', [0.1, 0.2], 5, undefined);
    });

    test('wrapper adapter delegates upsert to compat with collection', async () => {
      const mockCompat = createMockCompat();
      const mockRegistry = createMockRegistry({ compat: mockCompat });
      const configs = new Map<string, any>([['store', { defaultCollection: 'col' }]]);
      const manager = new VectorStoreManager(configs, new Map(), async () => [1], mockRegistry);

      await manager.upsert('store', [{ id: '1', vector: [0.1] }]);

      expect(mockCompat.upsert).toHaveBeenCalledWith('col', [{ id: '1', vector: [0.1] }]);
    });

    test('wrapper adapter delegates deleteByIds to compat with collection', async () => {
      const mockCompat = createMockCompat();
      const mockRegistry = createMockRegistry({ compat: mockCompat });
      const configs = new Map<string, any>([['store', { defaultCollection: 'col' }]]);
      const manager = new VectorStoreManager(configs, new Map(), async () => [1], mockRegistry);

      await manager.deleteByIds('store', ['id1', 'id2']);

      expect(mockCompat.deleteByIds).toHaveBeenCalledWith('col', ['id1', 'id2']);
    });

    test('wrapper adapter passes filter to compat query', async () => {
      const mockCompat = createMockCompat([{ id: '1', score: 0.9 }]);
      const mockRegistry = createMockRegistry({ compat: mockCompat });
      const configs = new Map<string, any>([['store', { defaultCollection: 'col' }]]);
      const manager = new VectorStoreManager(configs, new Map(), async () => [0.5], mockRegistry);

      await manager.queryWithPriority(['store'], 'test', 10, { status: 'active' });

      expect(mockCompat.query).toHaveBeenCalledWith('col', [0.5], 10, { filter: { status: 'active' } });
    });

    test('uses default collection when config has none', async () => {
      const mockCompat = createMockCompat([]);
      const mockRegistry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'store',
          kind: 'memory',
          connection: {}
          // No defaultCollection
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockCompat)
      };

      const manager = new VectorStoreManager(new Map(), new Map(), async () => [0.1], mockRegistry);

      await manager.queryWithPriority(['store'], 'query', 5);

      expect(mockCompat.query).toHaveBeenCalledWith('default', [0.1], 5, undefined);
    });

    test('caches wrapper adapter after first creation', async () => {
      const mockCompat = createMockCompat([{ id: '1', score: 0.9 }]);
      const mockRegistry = createMockRegistry({ compat: mockCompat });
      const configs = new Map<string, any>([['store', { defaultCollection: 'col' }]]);
      const manager = new VectorStoreManager(configs, new Map(), async () => [0.5], mockRegistry);

      // Multiple calls should reuse same adapter
      await manager.queryWithPriority(['store'], 'q1', 5);
      await manager.queryWithPriority(['store'], 'q2', 5);

      // Registry should only be called once for the compat
      expect(mockRegistry.getVectorStoreCompat).toHaveBeenCalledTimes(1);
    });
  });
});
