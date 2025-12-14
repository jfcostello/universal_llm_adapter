import { jest } from '@jest/globals';

describe('integration/lazy-loading/server-import-evaluation', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('importing server does not evaluate coordinator modules', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../coordinator/coordinator.js', () => {
        throw new Error('LLM coordinator must not be imported at server module load');
      });
      jest.unstable_mockModule('../../../coordinator/vector-coordinator.js', () => {
        throw new Error('Vector coordinator must not be imported at server module load');
      });
      jest.unstable_mockModule('../../../coordinator/embedding-coordinator.js', () => {
        throw new Error('Embedding coordinator must not be imported at server module load');
      });

      const { createServerHandlerWithDefaults } = await import('@/utils/server/index.ts');

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

