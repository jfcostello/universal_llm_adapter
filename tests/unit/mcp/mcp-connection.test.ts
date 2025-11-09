import { jest } from '@jest/globals';
import { MCPConnectionError } from '@/core/errors.ts';

async function loadClientModule() {
  return import('@/mcp/mcp-client.ts');
}

describe('mcp/MCPConnection edge cases', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('connect throws when command missing', async () => {
    const { MCPConnection } = await loadClientModule();
    const missingCommand = new MCPConnection({ id: 'test', command: '' } as any);
    await expect(missingCommand.connect()).rejects.toThrow(
      "MCP server 'test' missing command"
    );
  });

  test('connect throws when stdio unavailable', async () => {
    (jest as any).unstable_mockModule('child_process', () => ({
      spawn: jest.fn().mockReturnValue({
        stdin: null,
        stdout: null,
        stderr: null,
        pid: 1234,
        connected: false,
        kill: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn(),
        addListener: jest.fn(),
        emit: jest.fn(),
        listeners: jest.fn(),
        off: jest.fn(),
        prependListener: jest.fn(),
        prependOnceListener: jest.fn(),
        setMaxListeners: jest.fn(),
        getMaxListeners: jest.fn()
      })
    }));

    const { MCPConnection } = await loadClientModule();
    const connection = new MCPConnection({ id: 'broken', command: 'node' } as any);
    await expect(connection.connect()).rejects.toThrow(
      "Failed to spawn MCP server 'broken'"
    );
  });

  test('listTools prefixes names and handles pagination', async () => {
    const { MCPConnection } = await loadClientModule();
    const connection = new MCPConnection({ id: 'server', command: 'node' } as any);
    const session = {
      request: jest
        .fn()
        .mockResolvedValueOnce({
          tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
          nextCursor: 'cursor'
        })
        .mockResolvedValueOnce({
          tools: [
            { name: 'server.echo', description: 'Echo', input_schema: { type: 'object' } },
            { name: 'bare', description: 'Bare tool' }
          ],
          nextCursor: undefined
        })
    };

    (connection as any).session = session;

    const tools = await connection.listTools();
    expect(tools).toEqual([
      {
        name: 'server.ping',
        description: 'Ping',
        parametersJsonSchema: { type: 'object' }
      },
      {
        name: 'server.echo',
        description: 'Echo',
        parametersJsonSchema: { type: 'object' }
      },
      {
        name: 'server.bare',
        description: 'Bare tool',
        parametersJsonSchema: { type: 'object', properties: {} }
      }
    ]);

    const map = (connection as any).toolNameMap;
    expect(map.get('server.ping')).toBe('ping');
    expect(map.get('server.echo')).toBe('server.echo');
    expect(map.get('server.bare')).toBe('bare');
  });

  test('connect is idempotent when session already established', async () => {
    const spawnMock = jest.fn();
    (jest as any).unstable_mockModule('child_process', () => ({
      spawn: spawnMock
    }));

    const module = await loadClientModule();
    const connection = new module.MCPConnection({ id: 'server', command: 'node' } as any);
    (connection as any).session = {
      request: jest.fn()
    };

    await connection.connect();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('callTool strips prefixes and returns content when available', async () => {
    const { MCPConnection } = await loadClientModule();
    const connection = new MCPConnection({ id: 'server', command: 'node' } as any);
    const session = {
      request: jest
        .fn()
        .mockResolvedValueOnce({ content: { ok: true } })
        .mockResolvedValueOnce({ status: 'raw' })
    };

    (connection as any).session = session;
    (connection as any).toolNameMap = new Map([['server.echo', 'echo']]);

    const first = await connection.callTool('server.echo', { text: 'hi' });
    expect(first).toEqual({ ok: true });
    expect(session.request).toHaveBeenNthCalledWith(1, 'tools/call', {
      name: 'echo',
      arguments: { text: 'hi' }
    }, 30000);

    const second = await connection.callTool('server.other', { value: 1 });
    expect(second).toEqual({ status: 'raw' });
    expect(session.request).toHaveBeenNthCalledWith(2, 'tools/call', {
      name: 'other',
      arguments: { value: 1 }
    }, 30000);
  });

  test('callTool triggers connect when session missing', async () => {
    const { MCPConnection } = await loadClientModule();
    const connection = new MCPConnection({ id: 'server', command: 'node' } as any);
    const session = {
      request: jest.fn().mockResolvedValue({ content: { ok: true } })
    };

    jest.spyOn(connection, 'connect').mockImplementation(async () => {
      (connection as any).session = session;
    });

    (connection as any).toolNameMap = new Map();

    const result = await connection.callTool('server.tool', {});
    expect(result).toEqual({ ok: true });
  });

  test('callTool falls back to empty args when undefined provided', async () => {
    const { MCPConnection } = await loadClientModule();
    const connection = new MCPConnection({ id: 'server', command: 'node' } as any);
    const session = {
      request: jest.fn().mockResolvedValue({ status: 'ok' })
    };

    (connection as any).session = session;
    (connection as any).toolNameMap = new Map();

    const result = await connection.callTool('server.raw', undefined);
    expect(session.request).toHaveBeenCalledWith('tools/call', {
      name: 'raw',
      arguments: {}
    }, 30000);
    expect(result).toEqual({ status: 'ok' });
  });

  test('MCPClientPool close handles connection errors gracefully', async () => {
    const { MCPClientPool } = await loadClientModule();
    const pool = new MCPClientPool([{ id: 'server', command: 'node' } as any]);
    const failingConnection = { close: jest.fn().mockRejectedValue(new Error('close')) };

    (pool as any).connections.set('server', failingConnection);
    const logger = { debug: jest.fn() };
    (pool as any).logger = logger;

    await pool.close();
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to close MCP connection server',
      expect.objectContaining({ error: expect.any(Error) })
    );
    expect((pool as any).connections.size).toBe(0);
  });
});
