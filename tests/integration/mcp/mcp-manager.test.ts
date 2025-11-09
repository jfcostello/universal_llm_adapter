import { jest } from '@jest/globals';
import { MCPManager } from '@/managers/mcp-manager.ts';
import { MCPServerConfig } from '@/core/types.ts';
import { MCPClientPool } from '@/mcp/mcp-client.ts';
import { MCPConnectionError } from '@/core/errors.ts';

describe('integration/mcp/mcp-manager', () => {
  beforeEach(() => {
    process.env.TEST_LLM_ENDPOINT = 'http://localhost';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  function createServers(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig[] {
    return [
      {
        id: 'local',
        command: 'node',
        args: ['./tests/fixtures/mcp/server.mjs'],
        autoStart: true,
        capabilities: { streaming: true },
        requestTimeoutMs: 2000,
        ...overrides
      }
    ];
  }

  test('gatherTools caches results and returns active servers', async () => {
    const manager = new MCPManager(createServers());
    const listSpy = jest.spyOn(MCPClientPool.prototype, 'listTools');

    try {

      const [firstTools, firstServers] = await manager.gatherTools(['local']);
      expect(firstServers).toEqual(['local']);
      expect(firstTools.map(tool => tool.name)).toEqual(
        expect.arrayContaining(['local.ping', 'local.echo'])
      );

      const [secondTools, secondServers] = await manager.gatherTools(['local']);
      expect(secondServers).toEqual(['local']);
      expect(secondTools).toHaveLength(firstTools.length);

      // listTools invoked only once thanks to cache
      expect(listSpy).toHaveBeenCalledTimes(1);
    } finally {
      listSpy.mockRestore();
      await manager.close();
    }
  });

  test('call routes requests to the correct server', async () => {
    const manager = new MCPManager(createServers());

    try {
      const pool = manager.getPool();
      await manager.gatherTools(['local']);

      const result = await pool.call('local', 'local.echo', { text: 'hello' });
      expect(result.result).toBe('hello');
    } finally {
      await manager.close();
    }
  });

  test('collectAllEnabledTools skips failing servers and logs errors', async () => {
    const failingServer = {
      id: 'broken',
      command: 'node',
      args: ['--bad-command'],
      autoStart: true
    } as MCPServerConfig;

    const manager = new MCPManager([...createServers(), failingServer]);

    try {
      const logger = (manager as any).logger;
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

      const results = await manager.collectAllEnabledTools();
      expect(Object.keys(results)).toEqual(expect.arrayContaining(['local']));
      expect(results.local.map(tool => tool.name)).toEqual(
        expect.arrayContaining(['local.ping'])
      );

      expect(errorSpy).toHaveBeenCalled();
    } finally {
      await manager.close();
    }
  });

  test('streamTool returns async generator with server chunks', async () => {
    const manager = new MCPManager(createServers());

    try {
      await manager.gatherTools(['local']);
      const stream = await manager.streamTool('local', 'local.stream', { chunks: ['a', 'b', 'c'] });
      const received: string[] = [];
      for await (const chunk of stream) {
        received.push(chunk);
      }
      expect(received).toEqual(['a', 'b', 'c']);
    } finally {
      await manager.close();
    }
  });

  test('getCapabilities exposes server-declared capabilities', async () => {
    const manager = new MCPManager(createServers({ capabilities: { streaming: true, version: 1 } }));

    try {
      await manager.gatherTools(['local']);
      const capabilities = await manager.getCapabilities('local');
      expect(capabilities).toMatchObject({ streaming: true, version: 1 });
    } finally {
      await manager.close();
    }
  });

  test('call respects request timeout settings', async () => {
    const manager = new MCPManager(createServers({ requestTimeoutMs: 20 }));

    try {
      await manager.gatherTools(['local']);
      await expect(manager.call('local', 'local.slow', { delayMs: 100 })).rejects.toThrow('Request timeout');
    } finally {
      await manager.close();
    }
  });

  test('listTools resets connection and retries after connection failure', async () => {
    const manager = new MCPManager(createServers());

    const pool = manager.getPool();
    const resetSpy = jest.spyOn(pool, 'resetConnection').mockResolvedValue(undefined);
    const listSpy = jest
      .spyOn(pool, 'listTools')
      .mockRejectedValueOnce(new MCPConnectionError('initial failure'))
      .mockResolvedValueOnce([
        {
          name: 'local.echo',
          description: 'Echo tool',
          parametersJsonSchema: { type: 'object' }
        }
      ]);

    try {
      const tools = await manager.listTools('local', true);

      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(resetSpy).toHaveBeenCalledWith('local');
      expect(tools.map(tool => tool.name)).toEqual(['local.echo']);
    } finally {
      listSpy.mockRestore();
      resetSpy.mockRestore();
      await manager.close();
    }
  });

  test('listTools logs error when retry still fails after reset', async () => {
    const manager = new MCPManager(createServers());
    const pool = manager.getPool();

    const resetSpy = jest.spyOn(pool, 'resetConnection').mockResolvedValue(undefined);
    const listSpy = jest
      .spyOn(pool, 'listTools')
      .mockRejectedValueOnce(new MCPConnectionError('initial failure'))
      .mockRejectedValueOnce('still broken');

    const errorSpy = jest.spyOn((manager as any).logger, 'error').mockImplementation(() => {});

    try {
      await expect(manager.listTools('local', true)).rejects.toEqual('still broken');
      expect(resetSpy).toHaveBeenCalledWith('local');
      expect(errorSpy).toHaveBeenCalledWith(
        'Retry after MCP connection reset failed',
        expect.objectContaining({ server: 'local', error: 'still broken' })
      );
    } finally {
      listSpy.mockRestore();
      resetSpy.mockRestore();
      errorSpy.mockRestore();
      await manager.close();
    }
  });

  test('getServerInfo proxies through manager', async () => {
    const manager = new MCPManager(createServers());
    const pool = manager.getPool();

    const infoSpy = jest.spyOn(pool, 'getServerInfo').mockResolvedValue({ version: '1.2.3' });

    try {
      const info = await manager.getServerInfo('local');
      expect(info).toEqual({ version: '1.2.3' });
      expect(infoSpy).toHaveBeenCalledWith('local');
    } finally {
      infoSpy.mockRestore();
      await manager.close();
    }
  });
});
