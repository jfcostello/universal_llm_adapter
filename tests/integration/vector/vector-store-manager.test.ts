import { jest } from '@jest/globals';
import { VectorStoreManager } from '@/managers/vector-store-manager.ts';

describe('integration/vector/vector-store-manager', () => {
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
