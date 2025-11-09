import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { Role } from '@/core/types.ts';

function createRegistryStub() {
  return {
    getMCPServers: jest.fn().mockReturnValue([]),
    getProcessRoutes: jest.fn().mockReturnValue([]),
    getTool: jest.fn((name: string) => ({
      name,
      description: `${name} description`,
      parametersJsonSchema: { type: 'object', properties: {} }
    })),
    getProvider: jest.fn(),
    getVectorStores: jest.fn().mockReturnValue([])
  } as any;
}

describe('coordinator collect tools and messages', () => {
  test('prepareMessages injects system prompt and preserves originals', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const spec = {
      systemPrompt: 'system message',
      messages: [
        { role: Role.USER, content: [{ type: 'text', text: 'hi' }] }
      ],
      llmPriority: [{ provider: 'p', model: 'm' }],
      settings: {}
    } as any;

    const prepared = (coordinator as any).prepareMessages(spec);
    expect(prepared[0]).toEqual({
      role: Role.SYSTEM,
      content: [{ type: 'text', text: 'system message' }]
    });
    expect(prepared[1].content[0].text).toBe('hi');
  });

  test('collectTools sanitizes names and merges spec/tool lists', async () => {
    const registry = createRegistryStub();
    registry.getTool = jest.fn((name: string) => ({
      name,
      description: 'function tool',
      parametersJsonSchema: { type: 'object' }
    }));

    const coordinator = new LLMCoordinator(registry);

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'p', model: 'm' }],
      settings: {},
      tools: [
        { name: 'custom/tool', description: 'desc', parametersJsonSchema: { type: 'object' } }
      ],
      functionToolNames: ['func.tool']
    } as any;

    const [tools, mcpServers, map] = await (coordinator as any).collectTools(spec);

    expect(mcpServers).toEqual([]);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('custom_tool');
    expect(names).toContain('func_tool');
    expect(map.custom_tool).toBe('custom/tool');
    expect(map.func_tool).toBe('func.tool');
  });

  test('collectTools merges MCP tools and preserves server mapping', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    (coordinator as any).mcpManager = {
      gatherTools: jest.fn().mockResolvedValue([
        [
          {
            name: 'server.tool',
            description: 'server tool',
            parametersJsonSchema: { type: 'object' }
          }
        ],
        ['server']
      ])
    };

    const spec = {
      messages: [],
      llmPriority: [{ provider: 'p', model: 'm' }],
      settings: {},
      mcpServers: ['server']
    } as any;

    const [tools, servers, map] = await (coordinator as any).collectTools(spec);

    expect(servers).toEqual(['server']);
    expect(tools[0].name).toBe('server_tool');
    expect(map['server_tool']).toBe('server.tool');
  });
});
