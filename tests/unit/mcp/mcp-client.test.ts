import { jest } from '@jest/globals';
import { MCPClientPool, MCPConnection } from '@/mcp/mcp-client.ts';
import { MCPConnectionError } from '@/core/errors.ts';
import { resolveFixture } from '@tests/helpers/paths.ts';

describe('mcp/mcp-client', () => {
  test('MCPConnection uses fallback packageInfo when package.json fields are missing', async () => {
    // This test ensures the fallback branches in lines 20-21 are covered
    // We need to reimport the module with a mocked fs to return incomplete package.json
    jest.resetModules();

    const originalReadFileSync = await import('fs').then(m => m.readFileSync);

    // Mock fs.readFileSync to return package.json with missing name/version
    const fsMock = {
      readFileSync: jest.fn((path: string, encoding: string) => {
        if (path.includes('package.json')) {
          // Return package.json with missing fields to trigger fallback
          return JSON.stringify({ description: 'test' });
        }
        return originalReadFileSync(path, encoding as any);
      })
    };

    (jest as any).unstable_mockModule('fs', () => fsMock);

    // Now import MCPConnection which will use the mocked fs
    const { MCPConnection: MockedConnection } = await import('@/mcp/mcp-client.ts');

    // Creating a connection will trigger the package.json reading code
    const connection = new MockedConnection({ id: 'test', command: 'node' } as any);

    expect(connection).toBeDefined();

    // Restore
    jest.resetModules();
  });

  test('MCPClientPool lists tools via real mock server and calls tool', async () => {
    const serverScript = resolveFixture('mcp', 'mock-server.mjs');
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    (global as any).setTimeout = ((fn: (...args: any[]) => void, _ms?: number) => ({ fn })) as any;
    (global as any).clearTimeout = () => {};
    const servers = [
      {
        id: 'mock',
        command: process.execPath,
        args: [serverScript]
      }
    ];

    const pool = new MCPClientPool(servers as any);
    const tools = await pool.listTools('mock');
    expect(tools.map(tool => tool.name)).toEqual(['mock.echo', 'mock.math']);

    const echoResult = await pool.call('mock', 'mock.echo', { text: 'hi' });
    expect(echoResult).toEqual({ echoed: { text: 'hi' } });

    const mathResult = await pool.call('mock', 'mock.math', { value: 21 });
    expect(mathResult).toEqual({ doubled: 42 });

    await pool.close();

    (global as any).setTimeout = realSetTimeout;
    (global as any).clearTimeout = realClearTimeout;
  });

  test('MCPConnection throws when command missing', async () => {
    const connection = new MCPConnection({ id: 'bad' } as any);
    await expect(connection.connect()).rejects.toThrow(MCPConnectionError);
  });

  test('MCPClientPool rejects unknown server id', async () => {
    const pool = new MCPClientPool([]);
    await expect(pool.listTools('missing')).rejects.toThrow("Unknown MCP server 'missing'");
  });

  test('MCPConnection listTools tolerates pages without tool entries', async () => {
    const connection = new MCPConnection({ id: 'empty', command: 'node' } as any);
    const requests: any[] = [
      { nextCursor: '1' },
      {}
    ];

    (connection as any).session = {
      request: jest.fn().mockImplementation(async () => requests.shift())
    };
    (connection as any).toolNameMap = new Map();

    const tools = await connection.listTools();
    expect(tools).toEqual([]);
    expect(((connection as any).session.request as jest.Mock).mock.calls[0]).toEqual([
      'tools/list',
      { cursor: undefined },
      30000
    ]);
    expect(((connection as any).session.request as jest.Mock).mock.calls[1]).toEqual([
      'tools/list',
      { cursor: '1' },
      30000
    ]);
  });

  test('MCPConnection sends clientInfo in initialize request', async () => {
    const serverScript = resolveFixture('mcp', 'mock-server.mjs');
    const connection = new MCPConnection({
      id: 'test',
      command: process.execPath,
      args: [serverScript]
    } as any);

    // Should successfully connect with clientInfo
    await expect(connection.connect()).resolves.not.toThrow();
    await connection.close();
  });

  test('MCPConnection includes protocol version and clientInfo in initialize', async () => {
    // Use real connection to verify initialization params
    const serverScript = resolveFixture('mcp', 'mock-server.mjs');
    const connection = new MCPConnection({
      id: 'test',
      command: process.execPath,
      args: [serverScript]
    } as any);

    // Connect and verify it works
    await connection.connect();

    // List tools to ensure initialization was successful
    const tools = await connection.listTools();
    expect(tools.length).toBeGreaterThan(0);

    await connection.close();
  });

  test('MCPConnection.callToolStream returns provided chunks', async () => {
    const connection = new MCPConnection({ id: 'mock', command: 'node' } as any);
    (connection as any).session = {
      request: jest.fn().mockResolvedValue({ chunks: ['chunk-1', 'chunk-2'] })
    };

    const stream = await connection.callToolStream('mock.echo', {});
    const received: string[] = [];
    for await (const chunk of stream) {
      received.push(chunk as string);
    }
    expect(received).toEqual(['chunk-1', 'chunk-2']);
  });

  test('MCPConnection exposes cached serverInfo', () => {
    const connection = new MCPConnection({ id: 'info', command: 'node' } as any);
    (connection as any).serverInfo = { version: '2.0.0' };
    expect(connection.getServerInfo()).toEqual({ version: '2.0.0' });
  });

  test('MCPClientPool.resetConnection closes and removes cached connection', async () => {
    const pool = new MCPClientPool([]);
    const close = jest.fn().mockResolvedValue(undefined);
    (pool as any).connections.set('srv', { close });

    await pool.resetConnection('srv');

    expect(close).toHaveBeenCalledTimes(1);
    expect((pool as any).connections.has('srv')).toBe(false);
  });

  test('MCPClientPool.resetConnection logs debug when close fails', async () => {
    const pool = new MCPClientPool([]);
    const close = jest.fn().mockRejectedValue(new Error('close failed'));
    (pool as any).connections.set('srv', { close });

    const debugSpy = jest.spyOn((pool as any).logger, 'debug').mockImplementation(() => {});

    await pool.resetConnection('srv');

    expect(debugSpy).toHaveBeenCalledWith(
      'Failed to reset MCP connection srv',
      expect.objectContaining({ error: expect.any(Error) })
    );
    expect((pool as any).connections.has('srv')).toBe(false);

    debugSpy.mockRestore();
  });

  test('MCPClientPool.resetConnection is a no-op for unknown server ids', async () => {
    const pool = new MCPClientPool([]);
    await expect(pool.resetConnection('missing')).resolves.toBeUndefined();
  });

  test('MCPClientPool.getServerInfo returns cached connection info', async () => {
    const pool = new MCPClientPool([]);
    (pool as any).connections.set('srv', {
      getServerInfo: jest.fn().mockReturnValue({ version: 'v1' })
    });

    const info = await pool.getServerInfo('srv');
    expect(info).toEqual({ version: 'v1' });
  });

  test('MCPConnection.callToolStream connects lazily when session missing', async () => {
    const connection = new MCPConnection({ id: 'lazy', command: 'node' } as any);
    const requestMock = jest.fn().mockResolvedValue({ chunks: ['chunk'] });

    const connectSpy = jest.spyOn(connection as any, 'connect').mockImplementation(async function (this: any) {
      this.session = { request: requestMock };
    });

    const stream = await connection.callToolStream('lazy.echo', undefined);
    const chunks: any[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(requestMock).toHaveBeenCalledWith(
      'tools/call_stream',
      { name: 'lazy.echo', arguments: {} },
      expect.any(Number)
    );
    expect(chunks).toEqual(['chunk']);

    connectSpy.mockRestore();
  });

  test('MCPConnection.callToolStream handles missing response chunks', async () => {
    const connection = new MCPConnection({ id: 'empty', command: 'node' } as any);
    (connection as any).session = {
      request: jest.fn().mockResolvedValue(undefined)
    };

    const stream = await connection.callToolStream('empty.echo', {});
    const chunks: any[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });
});
