import { jest } from '@jest/globals';
import { ToolCoordinator } from '@/utils/tools/tool-coordinator.ts';
import { startStubServer } from '@tests/helpers/http-server.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

const moduleRoute = {
  id: 'module-route',
  match: { type: 'exact', pattern: 'echo.text' },
  invoke: {
    kind: 'module',
    module: './tests/fixtures/modules/echo-tool.mjs',
    function: 'handle'
  },
  timeoutMs: 2000
};

const commandRoute = {
  id: 'command-route',
  match: { type: 'regex', pattern: '^cmd\\.' },
  invoke: {
    kind: 'command',
    command: 'node',
    args: ['./tests/fixtures/command/echo.cjs']
  },
  timeoutMs: 2000
};

const globRoute = {
  id: 'mcp-route',
  match: { type: 'glob', pattern: 'mcp.*' },
  invoke: {
    kind: 'mcp',
    server: 'local'
  }
};

describe('utils/tools/tool-coordinator integration', () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(ROOT_DIR);
  });

  afterAll(() => {
    process.chdir(originalCwd);
  });

  test('invokes module and command routes', async () => {
    const coordinator = new ToolCoordinator([moduleRoute, commandRoute]);

    const moduleResult = await coordinator.routeAndInvoke('echo.text', 'call-1', { text: 'hello' }, {
      provider: 'test',
      model: 'demo'
    });
    expect(moduleResult.result.echoed).toBe('hello');

    const commandResult = await coordinator.routeAndInvoke('cmd.echo', 'call-2', { text: 'hey' }, {
      provider: 'test',
      model: 'demo'
    });
    expect(commandResult.result.echoed).toBe('hey');
  });

  test('invokes HTTP and MCP routes with appropriate matching', async () => {
    let server;
    try {
      server = await startStubServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: { echoed: 'http-response' } }));
      });
    } catch (error: any) {
      if (error?.code === 'EPERM') {
        console.warn('Skipping HTTP/MCP route test: binding not permitted');
        return;
      }
      throw error;
    }

    const httpRoute = {
      id: 'http-route',
      match: { type: 'prefix', pattern: 'http.' },
      invoke: {
        kind: 'http',
        url: `${server.url}/tool`
      }
    };

    const mcpPool = {
      call: jest.fn().mockResolvedValue('mcp-response')
    } as any;

    const coordinator = new ToolCoordinator([httpRoute, globRoute], mcpPool);

    try {
      const httpResult = await coordinator.routeAndInvoke('http.echo', 'call-3', { text: 'ignored' }, {
        provider: 'test',
        model: 'demo'
      });
      expect(httpResult.result.echoed).toBe('http-response');

      const mcpResult = await coordinator.routeAndInvoke('mcp.tool', 'call-4', { text: 'value' }, {
        provider: 'test',
        model: 'demo'
      });
      expect(mcpResult.result).toBe('mcp-response');
      expect(mcpPool.call).toHaveBeenCalledWith('local', 'mcp.tool', { text: 'value' });
    } finally {
      await server.close();
    }
  });

  test('throws when no matching route', async () => {
    const coordinator = new ToolCoordinator([moduleRoute]);
    await expect(
      coordinator.routeAndInvoke('unknown.tool', 'call', {}, { provider: 'p', model: 'm' })
    ).rejects.toThrow("No matching process route for tool 'unknown.tool'");
  });

  test('auto-routes MCP tools with underscore separator for sanitized names', async () => {
    const mcpPool = {
      call: jest.fn().mockResolvedValue({ sanitized: 'result' }),
      servers: [{ id: 'testserver' }]
    } as any;

    // Create coordinator with no explicit routes but MCP pool with server
    const coordinator = new ToolCoordinator([], mcpPool);

    // Tool name with underscore should auto-route to MCP
    const result = await coordinator.routeAndInvoke('testserver_tool_name', 'call-5', { data: 'test' }, {
      provider: 'test',
      model: 'demo'
    });

    expect(result.result).toEqual({ sanitized: 'result' });
    expect(mcpPool.call).toHaveBeenCalledWith('testserver', 'testserver_tool_name', { data: 'test' });
  });

  test('auto-routes MCP tools with dot separator', async () => {
    const mcpPool = {
      call: jest.fn().mockResolvedValue({ dotted: 'result' }),
      servers: [{ id: 'myserver' }]
    } as any;

    // Create coordinator with no explicit routes but MCP pool with server
    const coordinator = new ToolCoordinator([], mcpPool);

    // Tool name with dot should also auto-route to MCP
    const result = await coordinator.routeAndInvoke('myserver.tool.name', 'call-6', { data: 'test' }, {
      provider: 'test',
      model: 'demo'
    });

    expect(result.result).toEqual({ dotted: 'result' });
    expect(mcpPool.call).toHaveBeenCalledWith('myserver', 'myserver.tool.name', { data: 'test' });
  });
});
