import { jest } from '@jest/globals';

describe('integration/lazy-loading/import-evaluation (tools without vector_search)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not evaluate vector module when routing non-vector tools', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../modules/vector/index.js', () => {
        throw new Error('vector module should not be imported unless vector_search invoked');
      });

      const { ToolCoordinator } = await import('@/modules/tools/index.ts');

      const coordinator = new ToolCoordinator([]);
      await expect(
        coordinator.routeAndInvoke(
          'nonexistent_tool',
          'call-1',
          {},
          { provider: 'p', model: 'm' }
        )
      ).rejects.toThrow(/No matching process route/);

      await coordinator.close();
    });
  });
});

