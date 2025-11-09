import { describe, expect, jest, test } from '@jest/globals';
import { collectTools } from '@/utils/tools/tool-discovery.ts';
import { LLMCallSpec, UnifiedTool } from '@/core/types.ts';
import { PluginRegistry } from '@/core/registry.ts';
import { MCPManager } from '@/managers/mcp-manager.ts';

describe('utils/tools/tool-discovery', () => {
  test('collectTools merges spec, function, and MCP tools with sanitized names', async () => {
    const spec = {
      messages: [],
      llmPriority: [],
      settings: {},
      tools: [
        {
          name: 'Echo Service',
          description: 'Echo tool',
          parametersJsonSchema: { type: 'object' }
        }
      ],
      functionToolNames: ['weather/forecast'],
      mcpServers: ['server-1']
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn((name: string) => {
        if (name === 'weather/forecast') {
          return {
            name,
            description: 'Weather forecast',
            parametersJsonSchema: { type: 'object' }
          };
        }
        throw new Error(`Unexpected tool reference ${name}`);
      })
    } as unknown as PluginRegistry;

    const mcpTools: UnifiedTool[] = [
      {
        name: 'server-1.search-docs',
        description: 'Search docs',
        parametersJsonSchema: { type: 'object' }
      }
    ];

    const mcpManager = {
      gatherTools: jest.fn(async () => [mcpTools, ['server-1']])
    } as unknown as MCPManager;

    const result = await collectTools({
      spec,
      registry,
      mcpManager
    });

    expect(result.mcpServers).toEqual(['server-1']);
    expect(result.tools.map(tool => tool.name)).toEqual([
      'Echo_Service',
      'weather_forecast',
      'server-1_search-docs'
    ]);

    expect(result.toolNameMap).toEqual({
      Echo_Service: 'Echo Service',
      weather_forecast: 'weather/forecast',
      'server-1_search-docs': 'server-1.search-docs'
    });
  });

  test('collectTools falls back to latest user message when vector query missing', async () => {
    const spec = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Earlier answer' }]
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Find a summarizer tool' }]
        }
      ],
      llmPriority: [],
      settings: {},
      vectorPriority: ['memory']
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const vectorTool: UnifiedTool = {
      name: 'memory.summarize',
      description: 'Summarize content',
      parametersJsonSchema: { type: 'object' }
    };

    const vectorManager = {
      queryWithPriority: jest.fn(async (priority: string[], query: string) => {
        expect(priority).toEqual(['memory']);
        expect(query).toBe('Find a summarizer tool');
        return { results: [vectorTool] };
      })
    } as any;

    const result = await collectTools({
      spec,
      registry,
      vectorManager: vectorManager as any
    });

    expect(result.tools.map(tool => tool.name)).toEqual(['memory_summarize']);
    expect(result.toolNameMap.memory_summarize).toBe('memory.summarize');
  });

  test('collectTools skips vector lookup when no query can be derived', async () => {
    const spec = {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
      ],
      vectorPriority: ['memory']
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const vectorManager = {
      queryWithPriority: jest.fn()
    };

    const result = await collectTools({
      spec,
      registry,
      vectorManager: vectorManager as any
    });

    expect(vectorManager.queryWithPriority).not.toHaveBeenCalled();
    expect(result.tools).toEqual([]);
  });

  test('collectTools ignores invalid vector results', async () => {
    const spec = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Suggest a tool' }] }
      ],
      vectorPriority: ['memory']
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const vectorManager = {
      queryWithPriority: jest.fn(async () => ({
        results: [{ unexpected: true }]
      }))
    };

    const result = await collectTools({
      spec,
      registry,
      vectorManager: vectorManager as any
    });

    expect(result.tools).toEqual([]);
  });

  test('collectTools skips vector lookup when no query source exists', async () => {
    const spec = {
      vectorPriority: ['memory']
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const vectorManager = {
      queryWithPriority: jest.fn()
    };

    await collectTools({
      spec,
      registry,
      vectorManager: vectorManager as any
    });

    expect(vectorManager.queryWithPriority).not.toHaveBeenCalled();
  });

  test('collectTools ignores null vector payloads safely', async () => {
    const spec = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Need a tool' }] }
      ],
      vectorPriority: ['memory']
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const vectorManager = {
      queryWithPriority: jest.fn(async () => ({ results: [null] }))
    };

    const result = await collectTools({
      spec,
      registry,
      vectorManager: vectorManager as any
    });

    expect(result.tools).toEqual([]);
  });

  test('collectTools ignores vector results whose tool payload is not an object', async () => {
    const spec = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Need another tool' }] }
      ],
      vectorPriority: ['memory']
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const vectorManager = {
      queryWithPriority: jest.fn(async () => ({ results: [{ tool: 'invalid' }] }))
    };

    const result = await collectTools({
      spec,
      registry,
      vectorManager: vectorManager as any
    });

    expect(result.tools).toEqual([]);
  });
});
