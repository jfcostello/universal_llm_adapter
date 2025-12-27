import { jest } from '@jest/globals';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import { Role } from '@/kernel/index.ts';

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

  test('prepareMessages inlines base64 text-like documents as plain text', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const base64 = Buffer.from('Hello world', 'utf-8').toString('base64');

    const spec = {
      messages: [
        {
          role: Role.USER,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: base64 },
              mimeType: 'text/plain',
              filename: 'note.txt'
            }
          ]
        }
      ],
      llmPriority: [{ provider: 'p', model: 'm' }],
      settings: {}
    } as any;

    const prepared = (coordinator as any).prepareMessages(spec);
    const firstPart = prepared[0].content[0] as any;
    expect(firstPart.type).toBe('text');
    expect(String(firstPart.text)).toContain('Document (note.txt; text/plain):');
    expect(String(firstPart.text)).toContain('Hello world');
  });

  test('prepareMessages preserves non-text documents as document parts', async () => {
    const registry = createRegistryStub();
    const coordinator = new LLMCoordinator(registry);

    const base64 = Buffer.from('%PDF-1.7', 'utf-8').toString('base64');

    const spec = {
      messages: [
        {
          role: Role.USER,
          content: [
            {
              type: 'document',
              source: { type: 'base64', data: base64 },
              mimeType: 'application/pdf',
              filename: 'doc.pdf'
            }
          ]
        }
      ],
      llmPriority: [{ provider: 'p', model: 'm' }],
      settings: {}
    } as any;

    const prepared = (coordinator as any).prepareMessages(spec);
    const firstPart = prepared[0].content[0] as any;
    expect(firstPart.type).toBe('document');
    expect(firstPart.source.type).toBe('base64');
    expect(firstPart.mimeType).toBe('application/pdf');
    expect(firstPart.filename).toBe('doc.pdf');
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
