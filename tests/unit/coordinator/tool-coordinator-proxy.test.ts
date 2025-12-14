import { jest } from '@jest/globals';

const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
if (!unstableMockModule) {
  throw new Error('jest.unstable_mockModule is required for this test suite');
}

describe('coordinator toolCoordinator proxy', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('routeAndInvoke lazy-initializes ToolCoordinator when active spec is set', async () => {
    const ctorSpy = jest.fn();

    unstableMockModule('../../../modules/tools/index.js', () => ({
      ToolCoordinator: class ToolCoordinator {
        constructor(...args: any[]) {
          ctorSpy(...args);
        }
        setVectorContext() {}
        async routeAndInvoke() {
          return { result: 'ok' };
        }
        async close() {}
      }
    }));

    const { LLMCoordinator } = await import('@/coordinator/coordinator.ts');

    const registry = {
      getProcessRoutes: jest.fn().mockResolvedValue([]),
      getMCPServers: jest.fn().mockResolvedValue([])
    } as any;

    const coordinator = new LLMCoordinator(registry);
    (coordinator as any).activeToolSpec = { mcpServers: [], vectorContext: undefined } as any;

    const result = await (coordinator as any).toolCoordinator.routeAndInvoke(
      't',
      'c1',
      {},
      { provider: 'p', model: 'm' }
    );

    expect(result).toEqual({ result: 'ok' });
    expect(ctorSpy).toHaveBeenCalled();
  });
});

