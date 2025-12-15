import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (server /vector/run)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not evaluate embeddings module when input.vector is provided', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('embeddings module should not be imported by /vector/run when input.vector is provided');
      });

      // Keep the test lightweight: server/handler requires these helpers.
      jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
        createLoggingDeps: () => ({
          getLogger: () => ({ withCorrelation: () => ({ info: () => {} }), info: () => {} }),
          getEmbeddingLogger: () => ({ info: () => {} }),
          getVectorLogger: () => ({ info: () => {} }),
          closeLogger: async () => {}
        }),
        getVectorLogger: () => ({ info: () => {}, warning: () => {}, error: () => {} }),
        closeLogger: async () => {}
      }));

      const { createServer } = await import('@/modules/server/index.ts');

      const registry = {
        loadAll: async () => {},
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

      const running = await createServer({
        host: '127.0.0.1',
        port: 0,
        registry: registry as any
      });

      const res = await fetch(new URL('/vector/run', running.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'query',
          store: 'memory',
          input: { vector: [0.1, 0.2], topK: 1 }
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe('response');
      expect(body.data.success).toBe(true);

      await running.close();
    });
  });
});

