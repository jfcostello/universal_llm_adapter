import { jest } from '@jest/globals';
import { MCPManager } from '@/managers/mcp-manager.ts';

const servers = [
  { id: 'auto', autoStart: true } as any,
  { id: 'manual', autoStart: false } as any
];

function createManager(toolsByServer: Record<string, any[]>) {
  const manager = new MCPManager(servers as any);
  const pool = {
    listTools: jest.fn(async (serverId: string) => toolsByServer[serverId] || []),
    close: jest.fn().mockResolvedValue(undefined)
  };
  (manager as any).pool = pool;
  (manager as any).logger = { error: jest.fn(), debug: jest.fn() };
  return { manager, pool };
}

describe('managers/mcp-manager', () => {
  test('lists enabled servers and caches tool results', async () => {
    const tools = {
      auto: [
        { name: 'auto.tool', description: 'tool', parametersJsonSchema: {} }
      ]
    };

    const { manager, pool } = createManager(tools);

    expect(manager.listEnabledServers()).toEqual(['auto']);

    const first = await manager.listTools('auto');
    expect(first).toHaveLength(1);
    expect(pool.listTools).toHaveBeenCalledTimes(1);

    await manager.listTools('auto');
    expect(pool.listTools).toHaveBeenCalledTimes(1);

    await manager.listTools('auto', true);
    expect(pool.listTools).toHaveBeenCalledTimes(2);
  });

  test('gatherTools deduplicates names and handles errors', async () => {
    const tools = {
      auto: [
        { name: 'shared.tool', description: '', parametersJsonSchema: {} }
      ],
      manual: [
        { name: 'shared.tool', description: 'from manual', parametersJsonSchema: {} }
      ]
    };

    const { manager, pool } = createManager(tools);
    pool.listTools = jest
      .fn()
      .mockResolvedValueOnce(tools.auto)
      .mockRejectedValueOnce(new Error('failed'));

    const [collected, active] = await manager.gatherTools(['auto', 'manual']);
    expect(collected).toHaveLength(1);
    expect(active).toEqual(['auto']);
    expect((manager as any).logger.error).toHaveBeenCalled();
  });

  test('gatherTools skips servers that return no tools', async () => {
    const tools = {
      auto: [],
      extra: [{ name: 'tool', description: '', parametersJsonSchema: {} }]
    };

    const { manager, pool } = createManager(tools);
    pool.listTools = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(tools.extra);

    const [collected, active] = await manager.gatherTools(['auto', 'extra']);
    expect(collected).toEqual([{ name: 'tool', description: '', parametersJsonSchema: {} }]);
    expect(active).toEqual(['extra']);
  });

  test('close drains pool and clears cache', async () => {
    const tools = { auto: [{ name: 'tool', description: '', parametersJsonSchema: {} }] };
    const { manager, pool } = createManager(tools);

    await manager.listTools('auto');
    expect(pool.listTools).toHaveBeenCalledTimes(1);

    await manager.close();
    expect(pool.close).toHaveBeenCalled();

    pool.listTools.mockResolvedValueOnce([{ name: 'tool-2', description: '', parametersJsonSchema: {} }]);
    const refreshed = await manager.listTools('auto');
    expect(refreshed[0].name).toBe('tool-2');
    expect(pool.listTools).toHaveBeenCalledTimes(2);
  });

  test('discoverTools refreshes cache and collectAllEnabledTools logs errors', async () => {
    const servers = [
      { id: 'auto', autoStart: true },
      { id: 'second', autoStart: true }
    ] as any;
    const manager = new MCPManager(servers);
    const pool = {
      listTools: jest
        .fn()
        .mockResolvedValueOnce([{ name: 'tool-a', description: '', parametersJsonSchema: {} }])
        .mockRejectedValueOnce(new Error('boom')),
      close: jest.fn()
    } as any;
    (manager as any).pool = pool;
    (manager as any).logger = { error: jest.fn(), debug: jest.fn() };

    await manager.discoverTools('auto');
    expect(pool.listTools).toHaveBeenCalledWith('auto');

    const collected = await manager.collectAllEnabledTools();
    expect(collected.auto).toHaveLength(1);
    expect((manager as any).logger.error).toHaveBeenCalled();
  });
});
