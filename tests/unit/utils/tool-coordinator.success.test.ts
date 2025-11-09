import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

const mockRequest = jest.fn();
let ToolCoordinator: typeof import('@/utils/tools/tool-coordinator.ts').ToolCoordinator;

beforeAll(async () => {
  await (jest as any).unstable_mockModule('axios', () => ({
    __esModule: true,
    default: { request: mockRequest }
  }));

  ({ ToolCoordinator } = await import('@/utils/tools/tool-coordinator.ts'));
});

describe('utils/tools/tool-coordinator success paths', () => {
  afterEach(() => {
    mockRequest.mockReset();
  });

  test('invokeHttp delegates to axios and returns response data', async () => {
    mockRequest.mockResolvedValue({ data: { result: { echoed: 'http' } } });

    const httpRoute = {
      id: 'http',
      match: { type: 'prefix', pattern: 'http.' },
      invoke: { kind: 'http', url: 'http://local/tool', method: 'POST', headers: { 'x-test': '1' } },
      timeoutMs: 1000
    };

    const coordinator = new ToolCoordinator([httpRoute as any]);
    const timeoutSpy = jest
      .spyOn(coordinator as any, 'createTimeout')
      .mockImplementation(() => new Promise<never>(() => {}));
    const result = await coordinator.routeAndInvoke('http.echo', 'call-1', { text: 'hi' }, {
      provider: 'p',
      model: 'm'
    });
    timeoutSpy.mockRestore();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      url: 'http://local/tool',
      headers: { 'x-test': '1' },
      data: expect.objectContaining({ toolName: 'http.echo', callId: 'call-1' })
    });
    expect(result).toEqual({ result: { echoed: 'http' } });
  });

  test('invokeMcp calls pool and wraps result', async () => {
    const mcpRoute = {
      id: 'mcp',
      match: { type: 'glob', pattern: 'mcp.*' },
      invoke: { kind: 'mcp', server: 'local' }
    };

    const pool = {
      call: jest.fn().mockResolvedValue({ ok: true })
    };

    const coordinator = new ToolCoordinator([mcpRoute as any], pool as any);
    const timeoutSpy = jest
      .spyOn(coordinator as any, 'createTimeout')
      .mockImplementation(() => new Promise<never>(() => {}));
    const result = await coordinator.routeAndInvoke('mcp.tool', 'call-2', { text: 'hi' }, {
      provider: 'p',
      model: 'm'
    });
    timeoutSpy.mockRestore();

    expect(pool.call).toHaveBeenCalledWith('local', 'mcp.tool', { text: 'hi' });
    expect(result).toEqual({ result: { ok: true } });
  });

  test('selectRoute matches glob patterns and returns undefined when unmatched', () => {
    const routes = [
      {
        id: 'glob-route',
        match: { type: 'glob', pattern: 'glob.*' },
        invoke: { kind: 'module', module: './noop.js' }
      }
    ];

    const coordinator = new ToolCoordinator(routes as any);
    const match = (coordinator as any).selectRoute('glob.handler');
    expect(match?.id).toBe('glob-route');
    const miss = (coordinator as any).selectRoute('other.handler');
    expect(miss).toBeUndefined();
  });

  test('invokeModule falls back to default export when named handler missing', async () => {
    const moduleRoute = {
      id: 'default-module',
      match: { type: 'exact', pattern: 'module.default' },
      invoke: {
        kind: 'module',
        module: './tests/fixtures/modules/default-only.mjs'
      }
    };

    const coordinator = new ToolCoordinator([moduleRoute as any]);
    const timeoutSpy = jest
      .spyOn(coordinator as any, 'createTimeout')
      .mockImplementation(() => new Promise<never>(() => {}));

    const result = await coordinator.routeAndInvoke('module.default', 'call-3', {}, {
      provider: 'p',
      model: 'm'
    });

    timeoutSpy.mockRestore();
    expect(result).toEqual({ result: { via: 'default', callId: 'call-3' } });
  });

  test('invokeModule supports CommonJS function exports', async () => {
    const moduleRoute = {
      id: 'module-cjs',
      match: { type: 'exact', pattern: 'module.cjs' },
      invoke: {
        kind: 'module',
        module: './tests/fixtures/modules/function-export.cjs'
      }
    };

    const coordinator = new ToolCoordinator([moduleRoute as any]);
    const proto = Object.getPrototypeOf(coordinator) as any;
    const timeoutSpy = jest
      .spyOn(coordinator as any, 'createTimeout')
      .mockImplementation(() => new Promise<never>(() => {}));
    const handler = Object.assign(
      (ctx: any) => ({ result: { via: 'module-fallback', tool: ctx.toolName } }),
      { default: undefined }
    );
    const loadSpy = jest
      .spyOn(proto, 'loadModule')
      .mockResolvedValue(handler);

    const result = await coordinator.routeAndInvoke('module.cjs', 'call-4', {}, {
      provider: 'p',
      model: 'm'
    });

    timeoutSpy.mockRestore();
    loadSpy.mockRestore();
    expect(result).toEqual({ result: { via: 'module-fallback', tool: 'module.cjs' } });
  });

  test('invokeHttp defaults method/headers and returns null result when response empty', async () => {
    mockRequest.mockResolvedValue({});

    const httpRoute = {
      id: 'http-defaults',
      match: { type: 'exact', pattern: 'http.default' },
      invoke: { kind: 'http', url: 'http://local/tool' }
    };

    const coordinator = new ToolCoordinator([httpRoute as any]);
    const proto = Object.getPrototypeOf(coordinator) as any;
    const timeoutSpy = jest
      .spyOn(coordinator as any, 'createTimeout')
      .mockImplementation(() => new Promise<never>(() => {}));

    const result = await coordinator.routeAndInvoke('http.default', 'call-4', {}, {
      provider: 'p',
      model: 'm'
    });

    timeoutSpy.mockRestore();
    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      url: 'http://local/tool',
      headers: {},
      data: expect.objectContaining({ callId: 'call-4' })
    });
    expect(result).toEqual({ result: null });
  });

  test('invokeCommand falls back to null result when stdout empty', async () => {
    const commandRoute = {
      id: 'cmd-empty',
      match: { type: 'exact', pattern: 'cmd.empty' },
      invoke: {
        kind: 'command',
        command: 'node'
      },
      timeoutMs: 200
    };

    const coordinator = new ToolCoordinator([commandRoute as any]);
    const timeoutSpy = jest
      .spyOn(coordinator as any, 'createTimeout')
      .mockImplementation(() => new Promise<never>(() => {}));

    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = { write: jest.fn(), end: jest.fn() };
    const fakeProc: any = new EventEmitter();
    fakeProc.stdout = stdout;
    fakeProc.stderr = stderr;
    fakeProc.stdin = stdin;

    const observed: any = {};
    const originalSpawn = (coordinator as any).spawnProcess?.bind(coordinator) || ToolCoordinator.prototype.spawnProcess.bind(coordinator);
    (coordinator as any).spawnProcess = (command: string, args: string[], options: any) => {
      observed.command = command;
      observed.args = args;
      observed.options = options;
      return fakeProc;
    };

    const invokePromise = coordinator.routeAndInvoke('cmd.empty', 'call-5', { foo: 'bar' }, {
      provider: 'p',
      model: 'm'
    });

    await Promise.resolve();
    stdout.emit('data', Buffer.from(''));
    fakeProc.emit('close', 0);

    const result = await invokePromise;

    timeoutSpy.mockRestore();
    (coordinator as any).spawnProcess = originalSpawn;
    expect(observed.command).toBe('node');
    expect(observed.args).toEqual([]);
    expect(observed.options.env).toBeDefined();
    expect(result).toEqual({ result: null });
  });
});
