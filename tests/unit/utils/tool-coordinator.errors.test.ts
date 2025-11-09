import { jest } from '@jest/globals';
import path from 'path';
import { ToolCoordinator } from '@/utils/tools/tool-coordinator.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

const rawModulePath = path.join(ROOT_DIR, 'tests/fixtures/modules/raw-return.mjs');
const slowModulePath = path.join(ROOT_DIR, 'tests/fixtures/modules/slow-return.mjs');

describe('ToolCoordinator edge cases', () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(ROOT_DIR);
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  function disableTimeouts(coordinator: ToolCoordinator) {
    jest.spyOn(coordinator as any, 'createTimeout').mockImplementation(
      () => new Promise<never>(() => {})
    );
  }

  test('wraps primitive module result and logs call progress', async () => {
    const logger = { info: jest.fn() } as any;
    const route = {
      id: 'raw-module',
      match: { type: 'exact', pattern: 'raw.tool' },
      invoke: {
        kind: 'module',
        module: rawModulePath
      },
      timeoutMs: 5
    };

    const coordinator = new ToolCoordinator([route]);
    disableTimeouts(coordinator);

    const result = await coordinator.routeAndInvoke(
      'raw.tool',
      'call-raw',
      {},
      {
        provider: 'provider',
        model: 'model',
        logger,
        callProgress: { toolCallProgress: '1 of 1', finalToolCall: true }
      }
    );

    expect(result).toEqual({ result: 'raw-value' });
    expect(logger.info).toHaveBeenCalledWith('Routing tool call', expect.objectContaining({
      routeId: 'raw-module',
      invokeKind: 'module',
      toolCallProgress: '1 of 1',
      finalToolCall: true
    }));
  });

  test('throws descriptive error when module metadata missing', async () => {
    const route = {
      id: 'bad-module',
      match: { type: 'exact', pattern: 'bad.module' },
      invoke: {
        kind: 'module'
      },
      timeoutMs: 5
    };

    const coordinator = new ToolCoordinator([route]);
    disableTimeouts(coordinator);
    await expect(
      coordinator.routeAndInvoke('bad.module', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'bad-module' failed: Module route missing module field");
  });

  test('command route with missing command rejects', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'bad-command',
        match: { type: 'regex', pattern: '^cmd\\.' },
        invoke: { kind: 'command' },
        timeoutMs: 5
      }
    ]);
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke('cmd.noop', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'bad-command' failed: Command route missing command");
  });

  test('http route without url rejects early', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'bad-http',
        match: { type: 'prefix', pattern: 'http.' },
        invoke: { kind: 'http' }
      }
    ]);
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke('http.tool', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'bad-http' failed: HTTP route missing url");
  });

  test('mcp route requires pool', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'mcp',
        match: { type: 'glob', pattern: 'mcp.*' },
        invoke: { kind: 'mcp', server: 'local' }
      }
    ]);
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke('mcp.echo', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'mcp' failed: MCP route requested but no pool configured");
  });

  test('unsupported invoke kind surfaces error', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'unknown',
        match: { type: 'exact', pattern: 'unknown.tool' },
        invoke: { kind: 'other' }
      } as any
    ]);
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke('unknown.tool', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'unknown' failed: Unsupported invoke kind 'other'");
  });

  test('command route invalid JSON output is wrapped with context', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'command',
        match: { type: 'exact', pattern: 'cmd.invalid' },
        invoke: {
          kind: 'command',
          command: 'node',
          args: ['-e', "process.stdout.write('not-json')"]
        },
        timeoutMs: 200
      }
    ]);
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke('cmd.invalid', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'command' failed: Invalid JSON output: not-json");
  });

  test('command route propagates stderr when process exits non-zero', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'command-error',
        match: { type: 'exact', pattern: 'cmd.fail' },
        invoke: {
          kind: 'command',
          command: 'node',
          args: ['-e', "process.stderr.write('bad'); process.exit(2);"]
        },
        timeoutMs: 200
      }
    ]);
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke('cmd.fail', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'command-error' failed: Command exited with code 2: bad");
  });

  test('timeout path rejects when handler takes too long', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'slow-module',
        match: { type: 'exact', pattern: 'slow.tool' },
        invoke: {
          kind: 'module',
          module: slowModulePath
        },
        timeoutMs: 1
      }
    ]);

    await expect(
      coordinator.routeAndInvoke('slow.tool', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'slow-module' failed: Tool execution timeout after 0.001s");
  });

  test('mcp route validates presence of server when pool provided', async () => {
    const pool = { call: jest.fn() } as any;
    const coordinator = new ToolCoordinator(
      [
        {
          id: 'mcp-missing',
          match: { type: 'exact', pattern: 'mcp.route' },
          invoke: { kind: 'mcp' }
        }
      ],
      pool
    );
    disableTimeouts(coordinator);

    await expect(
      coordinator.routeAndInvoke('mcp.route', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("Process route 'mcp-missing' failed: MCP route missing server");
    expect(pool.call).not.toHaveBeenCalled();
  });

  test('selectRoute honors prefix, regex, and glob matches', async () => {
    const coordinator = new ToolCoordinator([
      {
        id: 'exact-route',
        match: { type: 'exact', pattern: 'tool.exact' },
        invoke: { kind: 'module', module: rawModulePath },
        timeoutMs: 5
      },
      {
        id: 'prefix-route',
        match: { type: 'prefix', pattern: 'pref.' },
        invoke: { kind: 'module', module: rawModulePath },
        timeoutMs: 5
      },
      {
        id: 'regex-route',
        match: { type: 'regex', pattern: '^re\\d+' },
        invoke: { kind: 'module', module: rawModulePath },
        timeoutMs: 5
      },
      {
        id: 'glob-route',
        match: { type: 'glob', pattern: 'glob.*' },
        invoke: { kind: 'module', module: rawModulePath },
        timeoutMs: 5
      }
    ]);
    disableTimeouts(coordinator);

    const invokeSpy = jest.spyOn(coordinator as any, 'invoke').mockResolvedValue({ result: 'ok' });

    await coordinator.routeAndInvoke('pref.tool', 'call', {}, { provider: 'p', model: 'm' });
    expect(invokeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'prefix-route' }),
      expect.any(Object)
    );

    await coordinator.routeAndInvoke('re5', 'call', {}, { provider: 'p', model: 'm' });
    expect(invokeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'regex-route' }),
      expect.any(Object)
    );

    await coordinator.routeAndInvoke('glob.match', 'call', {}, { provider: 'p', model: 'm' });
    expect(invokeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'glob-route' }),
      expect.any(Object)
    );

    invokeSpy.mockRestore();
  });
});
