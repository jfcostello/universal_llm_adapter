import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (tools vector_search invocation)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does evaluate vector module only when vector_search is invoked', async () => {
    await jest.isolateModulesAsync(async () => {
      let vectorModuleImported = false;

      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        vectorModuleImported = true;
        return {
          executeVectorSearch: async () => ({ results: [] }),
          formatVectorSearchResults: () => 'formatted'
        };
      });

      const { ToolCoordinator } = await import('@/modules/tools/index.ts');

      const coordinator = new ToolCoordinator(
        [],
        undefined,
        {
          vectorContext: { mode: 'tool', stores: ['memory'], topK: 1 },
          registry: {} as any
        }
      );

      expect(vectorModuleImported).toBe(false);

      const result = await coordinator.routeAndInvoke(
        'vector_search',
        'call-1',
        { query: 'hello', topK: 1, store: 'memory' },
        { provider: 'p', model: 'm' }
      );

      expect(vectorModuleImported).toBe(true);
      expect(result).toEqual({ result: 'formatted' });

      await coordinator.close();
    });
  });
});

