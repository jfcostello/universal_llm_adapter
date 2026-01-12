import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockRequest = jest.fn();
let ToolCoordinator: typeof import('@/modules/tools/index.ts').ToolCoordinator;

beforeAll(async () => {
  await (jest as any).unstable_mockModule('axios', () => ({
    __esModule: true,
    default: { request: mockRequest }
  }));

  ({ ToolCoordinator } = await import('@/modules/tools/index.ts'));
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
      data: expect.objectContaining({ toolName: 'http.echo', callId: 'call-1' }),
      signal: expect.any(AbortSignal)
    });
    expect(result).toEqual({ result: { echoed: 'http' } });
  });

  test('invokeHttp aborts axios request when tool timeout fires', async () => {
    jest.useFakeTimers();

    try {
      let capturedSignal: AbortSignal | undefined;
      mockRequest.mockImplementation(async (config: any) => {
        capturedSignal = config.signal;
        await new Promise(() => {});
        return { data: { result: null } };
      });

      const httpRoute = {
        id: 'http-timeout',
        match: { type: 'prefix', pattern: 'http.' },
        invoke: { kind: 'http', url: 'http://local/tool', method: 'POST' },
        timeoutMs: 5
      };

      const coordinator = new ToolCoordinator([httpRoute as any]);
      const promise = coordinator.routeAndInvoke('http.never', 'call-timeout', {}, { provider: 'p', model: 'm' });

      const assertion = expect(promise).rejects.toThrow(
        "Process route 'http-timeout' failed: Tool execution timeout after 0.005s"
      );
      await jest.advanceTimersByTimeAsync(10);

      await assertion;
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('invokeMcp calls pool and wraps result', async () => {
    const mcpRoute = {
      id: 'mcp',
      match: { type: 'glob', pattern: 'mcp.*' },
      invoke: { kind: 'mcp', server: 'local' }
    };

    const pool = {
      call: jest.fn().mockResolvedValue({ ok: true }),
      getServerIds: jest.fn().mockReturnValue(['local'])
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

  test('loadModule supports node: and bare specifiers', async () => {
    const coordinator = new ToolCoordinator([]);

    const nodeFs = await (coordinator as any).loadModule('node:fs');
    expect(typeof nodeFs.readFileSync).toBe('function');

    const bareFs = await (coordinator as any).loadModule('fs');
    expect(typeof bareFs.readFileSync).toBe('function');
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

  test('invokeModule resolves relative module paths via registry manifest source (manifest dir)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-process-pack-'));
    try {
      const packRoot = path.join(tmpRoot, 'pack');
      const manifestPath = path.join(packRoot, 'processes', 'echo.json');
      const modulePath = path.join(packRoot, 'modules', 'echo.mjs');

      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });

      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            id: 'external-echo',
            match: { type: 'exact', pattern: 'echo.external' },
            invoke: { kind: 'module', module: '../modules/echo.mjs', function: 'handle' }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        modulePath,
        [
          'export async function handle(ctx) {',
          '  return { result: { echoed: String(ctx?.args?.text || \"\"), callId: String(ctx?.callId || \"\") } };',
          '}'
        ].join('\n'),
        'utf-8'
      );

      const registry = {
        getManifestSource: (area: string, id: string) =>
          area === 'processes' && id === 'external-echo'
            ? { kind: 'external', root: packRoot, filePath: manifestPath, precedence: 0 }
            : undefined
      } as any;

      const route = {
        id: 'external-echo',
        match: { type: 'exact', pattern: 'echo.external' },
        invoke: { kind: 'module', module: '../modules/echo.mjs', function: 'handle' }
      };

      const coordinator = new ToolCoordinator([route as any], undefined, { registry });
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));

      const result = await coordinator.routeAndInvoke('echo.external', 'call-1', { text: 'hello' }, {
        provider: 'p',
        model: 'm'
      });

      timeoutSpy.mockRestore();
      expect(result).toEqual({ result: { echoed: 'hello', callId: 'call-1' } });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('invokeModule resolves relative module paths via registry manifest source (pack root)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-process-pack-'));
    try {
      const packRoot = path.join(tmpRoot, 'pack');
      const manifestPath = path.join(packRoot, 'processes', 'echo.json');
      const modulePath = path.join(packRoot, 'modules', 'echo.mjs');

      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });

      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            id: 'external-echo-pack-root',
            match: { type: 'exact', pattern: 'echo.external.pack' },
            invoke: { kind: 'module', module: './modules/echo.mjs', function: 'handle' }
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        modulePath,
        [
          'export async function handle(ctx) {',
          '  return { result: { ok: true, tool: String(ctx?.toolName || \"\") } };',
          '}'
        ].join('\n'),
        'utf-8'
      );

      const registry = {
        getManifestSource: (area: string, id: string) =>
          area === 'processes' && id === 'external-echo-pack-root'
            ? { kind: 'external', root: packRoot, filePath: manifestPath, precedence: 0 }
            : undefined
      } as any;

      const route = {
        id: 'external-echo-pack-root',
        match: { type: 'exact', pattern: 'echo.external.pack' },
        invoke: { kind: 'module', module: './modules/echo.mjs', function: 'handle' }
      };

      const coordinator = new ToolCoordinator([route as any], undefined, { registry });
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));

      const result = await coordinator.routeAndInvoke('echo.external.pack', 'call-2', {}, {
        provider: 'p',
        model: 'm'
      });

      timeoutSpy.mockRestore();
      expect(result).toEqual({ result: { ok: true, tool: 'echo.external.pack' } });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('invokeModule warns when falling back to cwd resolution while registry source is present', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-process-pack-'));
    try {
      const packRoot = path.join(tmpRoot, 'pack');
      const manifestPath = path.join(packRoot, 'processes', 'echo.json');
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            id: 'cwd-fallback',
            match: { type: 'exact', pattern: 'module.cwd.fallback' },
            invoke: { kind: 'module', module: './tests/fixtures/modules/default-only.mjs' }
          },
          null,
          2
        ),
        'utf-8'
      );

      const registry = {
        getManifestSource: (area: string, id: string) =>
          area === 'processes' && id === 'cwd-fallback'
            ? { kind: 'external', root: packRoot, filePath: manifestPath, precedence: 0 }
            : undefined
      } as any;

      const route = {
        id: 'cwd-fallback',
        match: { type: 'exact', pattern: 'module.cwd.fallback' },
        invoke: { kind: 'module', module: './tests/fixtures/modules/default-only.mjs' }
      };

      const coordinator = new ToolCoordinator([route as any], undefined, { registry });
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await coordinator.routeAndInvoke('module.cwd.fallback', 'call-3', {}, {
        provider: 'p',
        model: 'm'
      });
      const result2 = await coordinator.routeAndInvoke('module.cwd.fallback', 'call-4', {}, {
        provider: 'p',
        model: 'm'
      });

      timeoutSpy.mockRestore();
      expect(result).toEqual({ result: { via: 'default', callId: 'call-3' } });
      expect(result2).toEqual({ result: { via: 'default', callId: 'call-4' } });
      expect(warnSpy).toHaveBeenCalledWith(
        'process_route.invoke_module.cwd_fallback',
        expect.objectContaining({ routeId: 'cwd-fallback' })
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('invokeModule warns with undefined source fields when manifest source meta is malformed', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-process-pack-'));
    try {
      const packRoot = path.join(tmpRoot, 'pack');
      const manifestPath = path.join(packRoot, 'processes', 'echo.json');
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            id: 'cwd-fallback-malformed-source',
            match: { type: 'exact', pattern: 'module.cwd.fallback.malformed' },
            invoke: { kind: 'module', module: './tests/fixtures/modules/default-only.mjs' }
          },
          null,
          2
        ),
        'utf-8'
      );

      const registry = {
        getManifestSource: (area: string, id: string) =>
          area === 'processes' && id === 'cwd-fallback-malformed-source'
            ? { kind: 123, root: false, filePath: null, precedence: 'nope' }
            : undefined
      } as any;

      const route = {
        id: 'cwd-fallback-malformed-source',
        match: { type: 'exact', pattern: 'module.cwd.fallback.malformed' },
        invoke: { kind: 'module', module: './tests/fixtures/modules/default-only.mjs' }
      };

      const coordinator = new ToolCoordinator([route as any], undefined, { registry });
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await coordinator.routeAndInvoke('module.cwd.fallback.malformed', 'call-5', {}, {
        provider: 'p',
        model: 'm'
      });

      timeoutSpy.mockRestore();
      expect(result).toEqual({ result: { via: 'default', callId: 'call-5' } });
      expect(warnSpy).toHaveBeenCalledWith(
        'process_route.invoke_module.cwd_fallback',
        expect.objectContaining({
          routeId: 'cwd-fallback-malformed-source',
          source: {
            kind: undefined,
            root: undefined,
            filePath: undefined,
            precedence: undefined
          }
        })
      );

      warnSpy.mockRestore();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('invokeModule preserves non-path module specifiers when registry source is present', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-process-pack-'));
    try {
      const packRoot = path.join(tmpRoot, 'pack');
      const manifestPath = path.join(packRoot, 'processes', 'echo.json');
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            id: 'module-nonpath',
            match: { type: 'exact', pattern: 'module.nonpath' },
            invoke: { kind: 'module', module: 'definitely-not-a-file-or-package', function: 'handle' }
          },
          null,
          2
        ),
        'utf-8'
      );

      const registry = {
        getManifestSource: (area: string, id: string) =>
          area === 'processes' && id === 'module-nonpath'
            ? { kind: 'external', root: packRoot, filePath: manifestPath, precedence: 0 }
            : undefined
      } as any;

      const route = {
        id: 'module-nonpath',
        match: { type: 'exact', pattern: 'module.nonpath' },
        invoke: { kind: 'module', module: 'definitely-not-a-file-or-package', function: 'handle' }
      };

      const coordinator = new ToolCoordinator([route as any], undefined, { registry });
      const proto = Object.getPrototypeOf(coordinator) as any;
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));

      const loadSpy = jest.spyOn(proto, 'loadModule').mockResolvedValue({
        handle: async (ctx: any) => ({ result: { ok: true, tool: ctx.toolName } })
      });

      const result = await coordinator.routeAndInvoke('module.nonpath', 'call-6', {}, {
        provider: 'p',
        model: 'm'
      });

      timeoutSpy.mockRestore();
      expect(result).toEqual({ result: { ok: true, tool: 'module.nonpath' } });
      expect(loadSpy).toHaveBeenCalledWith('definitely-not-a-file-or-package');

      loadSpy.mockRestore();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('invokeModule treats non-relative module specifiers as module specifiers when no registry source exists', async () => {
    const route = {
      id: 'module-no-registry',
      match: { type: 'exact', pattern: 'module.no.registry' },
      invoke: { kind: 'module', module: 'definitely-not-a-file-or-package', function: 'handle' }
    };

    const coordinator = new ToolCoordinator([route as any]);
    const proto = Object.getPrototypeOf(coordinator) as any;
    const timeoutSpy = jest
      .spyOn(coordinator as any, 'createTimeout')
      .mockImplementation(() => new Promise<never>(() => {}));

    const loadSpy = jest.spyOn(proto, 'loadModule').mockResolvedValue({
      handle: async (ctx: any) => ({ result: { ok: true, tool: ctx.toolName } })
    });

    const result = await coordinator.routeAndInvoke('module.no.registry', 'call-7', {}, {
      provider: 'p',
      model: 'm'
    });

    timeoutSpy.mockRestore();
    expect(result).toEqual({ result: { ok: true, tool: 'module.no.registry' } });
    expect(loadSpy).toHaveBeenCalledWith('definitely-not-a-file-or-package');

    loadSpy.mockRestore();
  });

  test('invokeModule preserves npm package subpath specifiers (with extensions) when registry source is present', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-process-pack-'));
    try {
      const packRoot = path.join(tmpRoot, 'pack');
      const manifestPath = path.join(packRoot, 'processes', 'echo.json');
      fs.mkdirSync(path.join(packRoot, 'processes'), { recursive: true });

      const registry = {
        getManifestSource: (area: string, id: string) =>
          area === 'processes' && id === 'module-package-subpath'
            ? { kind: 'external', root: packRoot, filePath: manifestPath, precedence: 0 }
            : undefined
      } as any;

      const route = {
        id: 'module-package-subpath',
        match: { type: 'exact', pattern: 'module.pkg.subpath' },
        invoke: { kind: 'module', module: '@scope/pkg/dist/handler.js', function: 'handle' }
      };

      const coordinator = new ToolCoordinator([route as any], undefined, { registry });
      const proto = Object.getPrototypeOf(coordinator) as any;
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));

      const loadSpy = jest.spyOn(proto, 'loadModule').mockResolvedValue({
        handle: async (ctx: any) => ({ result: { ok: true, tool: ctx.toolName } })
      });

      const result = await coordinator.routeAndInvoke('module.pkg.subpath', 'call-9', {}, {
        provider: 'p',
        model: 'm'
      });

      timeoutSpy.mockRestore();
      expect(result).toEqual({ result: { ok: true, tool: 'module.pkg.subpath' } });
      expect(loadSpy).toHaveBeenCalledWith('@scope/pkg/dist/handler.js');

      loadSpy.mockRestore();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('invokeModule throws when a registry-owned module route cannot resolve a path-like module specifier', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-process-pack-'));
    try {
      const packRoot = path.join(tmpRoot, 'pack');
      const manifestPath = path.join(packRoot, 'processes', 'echo.json');

      const registry = {
        getManifestSource: (area: string, id: string) =>
          area === 'processes' && id === 'missing-module'
            ? { kind: 'external', root: packRoot, filePath: manifestPath, precedence: 0 }
            : undefined
      } as any;

      const route = {
        id: 'missing-module',
        match: { type: 'exact', pattern: 'module.missing' },
        invoke: { kind: 'module', module: './missing-tool.mjs', function: 'handle' }
      };

      const coordinator = new ToolCoordinator([route as any], undefined, { registry });
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));

      await expect(
        coordinator.routeAndInvoke('module.missing', 'call-8', {}, { provider: 'p', model: 'm' })
      ).rejects.toThrow("Process route 'missing-module' failed");

      timeoutSpy.mockRestore();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
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
      data: expect.objectContaining({ callId: 'call-4' }),
      signal: expect.any(AbortSignal)
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
