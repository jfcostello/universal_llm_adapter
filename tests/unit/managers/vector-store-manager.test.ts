import { jest } from '@jest/globals';
import { VectorStoreManager } from '@/managers/vector-store-manager.ts';

function createAdapter(returnResults: any[]) {
  return {
    query: jest.fn().mockResolvedValue(returnResults),
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteByIds: jest.fn().mockResolvedValue(undefined)
  };
}

describe('managers/vector-store-manager', () => {
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

  test('delegates upsert and delete and errors on missing adapter', async () => {
    const adapter = createAdapter([]);
    const adapters = new Map<string, any>([['a', adapter]]);
    const manager = new VectorStoreManager(new Map(), adapters, async () => [1]);

    await manager.upsert('a', [{ id: '1' }]);
    await manager.deleteByIds('a', ['1']);
    expect(adapter.upsert).toHaveBeenCalledWith([{ id: '1' }]);
    expect(adapter.deleteByIds).toHaveBeenCalledWith(['1']);

    await expect(manager.upsert('missing', [])).rejects.toThrow(
      "No adapter registered for vector store 'missing'"
    );
  });
});
