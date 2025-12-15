import { jest } from '@jest/globals';

describe('integration/lazy-loading/server-import-evaluation', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('importing server does not evaluate coordinator modules', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/llm/index.js', () => {
        throw new Error('LLM module must not be imported at server module load');
      });
      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('Vector module must not be imported at server module load');
      });
      jest.unstable_mockModule('../../../modules/embeddings/index.js', () => {
        throw new Error('Embeddings module must not be imported at server module load');
      });

      const { createServerHandlerWithDefaults } = await import('@/modules/server/index.ts');

      const handler = createServerHandlerWithDefaults({
        registry: { loadAll: async () => {} } as any,
        deps: {
          createRegistry: async () => ({}) as any,
          createCoordinator: async () => ({}) as any,
          closeLogger: async () => {}
        }
      } as any);

      expect(typeof handler).toBe('function');
    });
  });
});
