import { jest } from '@jest/globals';

import { ToolCoordinator } from '@/modules/tools/index.ts';

describe('ToolCoordinator routing precedence', () => {
  function disableTimeouts(coordinator: ToolCoordinator) {
    jest.spyOn(coordinator as any, 'createTimeout').mockImplementation(
      () => new Promise<never>(() => {})
    );
  }

  test('logs routing at debug level (not info)', async () => {
    const routes = [
      {
        id: 'route-a',
        match: { type: 'exact', pattern: 'tool.name' },
        invoke: { kind: 'module', module: 'moduleA', function: 'handle' }
      }
    ];

    const coordinator = new ToolCoordinator(routes as any);
    disableTimeouts(coordinator);

    const proto = Object.getPrototypeOf(coordinator) as any;
    jest.spyOn(proto, 'loadModule').mockImplementation(async () => ({ handle: async () => ({ ok: true }) }));

    const logger = { debug: jest.fn(), info: jest.fn() };

    await coordinator.routeAndInvoke(
      'tool.name',
      'call-1',
      {},
      { provider: 'p', model: 'm', logger } as any
    );

    expect(logger.debug).toHaveBeenCalledWith(
      'Routing tool call',
      expect.objectContaining({ toolName: 'tool.name', callId: 'call-1', routeId: 'route-a' })
    );
    expect(logger.info).not.toHaveBeenCalledWith('Routing tool call', expect.anything());
  });

  test('explicit processRouteId overrides name-based matching', async () => {
    const routes = [
      {
        id: 'route-a',
        match: { type: 'exact', pattern: 'tool.name' },
        invoke: { kind: 'module', module: 'moduleA', function: 'handle' }
      },
      {
        id: 'route-b',
        match: { type: 'exact', pattern: 'other.name' },
        invoke: { kind: 'module', module: 'moduleB', function: 'handle' }
      }
    ];

    const coordinator = new ToolCoordinator(routes as any);
    disableTimeouts(coordinator);

    const proto = Object.getPrototypeOf(coordinator) as any;
    const loadSpy = jest.spyOn(proto, 'loadModule').mockImplementation(async (modulePath: string) => {
      if (modulePath === 'moduleA') return { handle: async () => ({ result: { route: 'A' } }) };
      if (modulePath === 'moduleB') return { handle: async () => ({ result: { route: 'B' } }) };
      throw new Error(`Unexpected module path: ${modulePath}`);
    });

    const result = await coordinator.routeAndInvoke(
      'tool.name',
      'call-1',
      {},
      {
        provider: 'p',
        model: 'm',
        processRouteId: 'route-b'
      } as any
    );

    expect(result).toEqual({ result: { route: 'B' } });
    expect(loadSpy).toHaveBeenCalledWith('moduleB');

    loadSpy.mockRestore();
  });

  test('explicit processRouteId throws when missing', async () => {
    const routes = [
      {
        id: 'route-a',
        match: { type: 'exact', pattern: 'tool.name' },
        invoke: { kind: 'module', module: 'moduleA', function: 'handle' }
      }
    ];

    const coordinator = new ToolCoordinator(routes as any);
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke(
        'tool.name',
        'call-1',
        {},
        { provider: 'p', model: 'm', processRouteId: 'missing-route' } as any
      )
    ).rejects.toThrow("No process route found for id 'missing-route'");
  });

  test('route.id === toolId is an exact shortcut before matchToolId patterns', async () => {
    const routes = [
      {
        id: 'tool-123',
        match: { type: 'exact', pattern: 'unused.tool.id.shortcut' },
        invoke: { kind: 'module', module: 'moduleA', function: 'handle' }
      },
      {
        id: 'route-b',
        match: { type: 'exact', pattern: 'tool.name' },
        matchToolId: { type: 'exact', pattern: 'tool-123' },
        invoke: { kind: 'module', module: 'moduleB', function: 'handle' }
      }
    ];

    const coordinator = new ToolCoordinator(routes as any);
    disableTimeouts(coordinator);

    const proto = Object.getPrototypeOf(coordinator) as any;
    const loadSpy = jest.spyOn(proto, 'loadModule').mockImplementation(async (modulePath: string) => {
      if (modulePath === 'moduleA') return { handle: async () => ({ result: { route: 'A' } }) };
      if (modulePath === 'moduleB') return { handle: async () => ({ result: { route: 'B' } }) };
      throw new Error(`Unexpected module path: ${modulePath}`);
    });

    const result = await coordinator.routeAndInvoke(
      'tool.name',
      'call-1',
      {},
      { provider: 'p', model: 'm', toolId: 'tool-123' } as any
    );

    expect(result).toEqual({ result: { route: 'A' } });
    expect(loadSpy).toHaveBeenCalledWith('moduleA');

    loadSpy.mockRestore();
  });

  test('toolId match routes before name match', async () => {
    const routes = [
      {
        id: 'route-a',
        match: { type: 'exact', pattern: 'tool.name' },
        invoke: { kind: 'module', module: 'moduleA', function: 'handle' }
      },
      {
        id: 'route-b',
        match: { type: 'exact', pattern: 'other.name' },
        matchToolId: { type: 'exact', pattern: 'tool-123' },
        invoke: { kind: 'module', module: 'moduleB', function: 'handle' }
      }
    ];

    const coordinator = new ToolCoordinator(routes as any);
    disableTimeouts(coordinator);

    const proto = Object.getPrototypeOf(coordinator) as any;
    const loadSpy = jest.spyOn(proto, 'loadModule').mockImplementation(async (modulePath: string) => {
      if (modulePath === 'moduleA') return { handle: async () => ({ result: { route: 'A' } }) };
      if (modulePath === 'moduleB') return { handle: async () => ({ result: { route: 'B' } }) };
      throw new Error(`Unexpected module path: ${modulePath}`);
    });

    const result = await coordinator.routeAndInvoke(
      'tool.name',
      'call-1',
      {},
      { provider: 'p', model: 'm', toolId: 'tool-123' } as any
    );

    expect(result).toEqual({ result: { route: 'B' } });
    expect(loadSpy).toHaveBeenCalledWith('moduleB');

    loadSpy.mockRestore();
  });

  test('falls back to name match when toolId does not match', async () => {
    const routes = [
      {
        id: 'route-a',
        match: { type: 'exact', pattern: 'tool.name' },
        invoke: { kind: 'module', module: 'moduleA', function: 'handle' }
      },
      {
        id: 'route-b',
        match: { type: 'exact', pattern: 'other.name' },
        matchToolId: { type: 'exact', pattern: 'tool-123' },
        invoke: { kind: 'module', module: 'moduleB', function: 'handle' }
      }
    ];

    const coordinator = new ToolCoordinator(routes as any);
    disableTimeouts(coordinator);

    const proto = Object.getPrototypeOf(coordinator) as any;
    const loadSpy = jest.spyOn(proto, 'loadModule').mockImplementation(async (modulePath: string) => {
      if (modulePath === 'moduleA') return { handle: async () => ({ result: { route: 'A' } }) };
      if (modulePath === 'moduleB') return { handle: async () => ({ result: { route: 'B' } }) };
      throw new Error(`Unexpected module path: ${modulePath}`);
    });

    const result = await coordinator.routeAndInvoke(
      'tool.name',
      'call-1',
      {},
      { provider: 'p', model: 'm', toolId: 'tool-NOT-MATCHED' } as any
    );

    expect(result).toEqual({ result: { route: 'A' } });
    expect(loadSpy).toHaveBeenCalledWith('moduleA');

    loadSpy.mockRestore();
  });
});
