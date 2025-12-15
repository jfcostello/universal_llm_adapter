import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (vector query by vector)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not evaluate embeddings module when input.vector is provided', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported for vector query by vector');
      });

      const { VectorStoreCoordinator } = await import('@/modules/vector/index.ts');

      const registry = {
        getVectorStore: async () => ({ kind: 'stub-kind', defaultCollection: 'default' }),
        getVectorStoreCompat: async () => ({
          connect: async () => {},
          query: async () => [{ id: 'r1', score: 0.9, payload: { ok: true } }],
          upsert: async () => {},
          deleteByIds: async () => {},
          collectionExists: async () => true,
          close: async () => {}
        })
      };

      const coordinator = new VectorStoreCoordinator(registry as any);
      const result = await coordinator.execute({
        operation: 'query',
        store: 'memory',
        input: { vector: [0.1, 0.2], topK: 1 }
      } as any);

      expect(result.success).toBe(true);
      await coordinator.close();
    });
  });
});

