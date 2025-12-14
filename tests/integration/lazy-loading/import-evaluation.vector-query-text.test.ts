import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (vector query by text)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does evaluate embeddings module when input.query is provided', async () => {
    await jest.isolateModulesAsync(async () => {
      let embeddingsModuleImported = false;

      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        embeddingsModuleImported = true;
        return {
          EmbeddingManager: class EmbeddingManager {
            constructor(..._args: any[]) {}
            async embed(_input: string | string[]) {
              return { vectors: [[0.1, 0.2]] };
            }
          }
        };
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
        embeddingPriority: [{ provider: 'stub-provider', model: 'stub-model' }],
        input: { query: 'hello', topK: 1 }
      } as any);

      expect(result.success).toBe(true);
      expect(embeddingsModuleImported).toBe(true);

      await coordinator.close();
    });
  });
});

