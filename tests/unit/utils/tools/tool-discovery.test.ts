import { describe, expect, jest, test } from '@jest/globals';
import { collectTools, shouldCreateVectorSearchTool, createVectorSearchTool } from '@/utils/tools/tool-discovery.ts';
import { LLMCallSpec, UnifiedTool, VectorContextConfig } from '@/core/types.ts';
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

  describe('shouldCreateVectorSearchTool', () => {
    test('returns true for tool mode', () => {
      expect(shouldCreateVectorSearchTool('tool')).toBe(true);
    });

    test('returns true for both mode', () => {
      expect(shouldCreateVectorSearchTool('both')).toBe(true);
    });

    test('returns false for auto mode', () => {
      expect(shouldCreateVectorSearchTool('auto')).toBe(false);
    });

    test('returns false for undefined mode', () => {
      expect(shouldCreateVectorSearchTool(undefined)).toBe(false);
    });
  });

  describe('createVectorSearchTool', () => {
    test('creates tool with default name and description', () => {
      const config: VectorContextConfig = {
        stores: ['qdrant-cloud'],
        mode: 'tool'
      };

      const tool = createVectorSearchTool(config);

      expect(tool.name).toBe('vector_search');
      expect(tool.description).toContain('qdrant-cloud');
      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
      expect(tool.parametersJsonSchema.required).toContain('query');
    });

    test('uses custom tool name when provided', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool',
        toolName: 'semantic_search'
      };

      const tool = createVectorSearchTool(config);

      expect(tool.name).toBe('semantic_search');
    });

    test('uses custom description when provided', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool',
        toolDescription: 'Custom search description'
      };

      const tool = createVectorSearchTool(config);

      expect(tool.description).toBe('Custom search description');
    });

    test('includes topK default in description', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool',
        topK: 10
      };

      const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.topK.description).toContain('10');
    });

    test('includes filter property when filter is not locked', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool'
      };

      const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter.type).toBe('object');
    });

    test('lists all stores in description', () => {
      const config: VectorContextConfig = {
        stores: ['store1', 'store2', 'store3'],
        mode: 'tool'
      };

      const tool = createVectorSearchTool(config);

      expect(tool.description).toContain('store1');
      expect(tool.description).toContain('store2');
      expect(tool.description).toContain('store3');
    });

    // Parameter locking tests
    describe('with locks', () => {
      test('omits store from schema when store is locked', () => {
        const config: VectorContextConfig = {
          stores: ['docs', 'faq'],
          mode: 'tool',
          locks: {
            store: 'docs'
          }
        };

        const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.store).toBeUndefined();
      expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
    });

      test('omits topK from schema when topK is locked', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          locks: {
            topK: 5
          }
        };

        const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.topK).toBeUndefined();
      expect(tool.parametersJsonSchema.properties.store).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
    });

      test('omits both store and topK when both are locked', () => {
        const config: VectorContextConfig = {
          stores: ['docs', 'faq'],
          mode: 'tool',
          locks: {
            store: 'docs',
            topK: 10
          }
        };

        const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.store).toBeUndefined();
      expect(tool.parametersJsonSchema.properties.topK).toBeUndefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
    });

      test('query is always required and never removed by locks', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          locks: {
            store: 'docs',
            topK: 5,
            scoreThreshold: 0.8,
            collection: 'my-collection',
            filter: { type: 'article' }
          }
        };

      const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.required).toContain('query');
      expect(tool.parametersJsonSchema.properties.filter).toBeUndefined();
    });

      test('empty locks object does not affect schema', () => {
        const config: VectorContextConfig = {
          stores: ['docs', 'faq'],
          mode: 'tool',
          locks: {}
        };

        const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.store).toBeDefined();
      expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
    });

      test('undefined locks does not affect schema', () => {
        const config: VectorContextConfig = {
          stores: ['docs', 'faq'],
          mode: 'tool'
          // No locks field
        };

        const tool = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.store).toBeDefined();
      expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
    });

      test('store description excludes locked store', () => {
        const config: VectorContextConfig = {
          stores: ['docs', 'faq', 'support'],
          mode: 'tool',
          locks: {
            store: 'docs'
          }
        };

        const tool = createVectorSearchTool(config);

        // Store is locked, so no store field in schema
        expect(tool.parametersJsonSchema.properties.store).toBeUndefined();
        // But description should still mention it's searching docs
        expect(tool.description).toContain('docs');
      });

      test('scoreThreshold lock does not affect schema (not a schema param)', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          locks: {
            scoreThreshold: 0.8
          }
        };

        const tool = createVectorSearchTool(config);

        // scoreThreshold is not in the schema anyway, so all params remain
      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.store).toBeDefined();
      expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
    });

      test('collection lock does not affect schema (not a schema param)', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          locks: {
            collection: 'my-collection'
          }
        };

        const tool = createVectorSearchTool(config);

        // collection is not in the schema anyway
        expect(tool.parametersJsonSchema.properties.query).toBeDefined();
        expect(tool.parametersJsonSchema.properties.store).toBeDefined();
        expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
      });

      test('filter lock does not affect schema (not a schema param)', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          locks: {
            filter: { category: 'tech' }
          }
        };

        const tool = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.query).toBeDefined();
        expect(tool.parametersJsonSchema.properties.store).toBeDefined();
        expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
        expect(tool.parametersJsonSchema.properties.filter).toBeUndefined();
      });
    });
  });

  test('collectTools creates vector_search tool when vectorContext.mode is tool', async () => {
    const spec = {
      messages: [],
      llmPriority: [],
      settings: {},
      vectorContext: {
        stores: ['qdrant-cloud'],
        mode: 'tool'
      }
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const result = await collectTools({
      spec,
      registry
    });

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('vector_search');
  });

  test('collectTools creates vector_search tool when vectorContext.mode is both', async () => {
    const spec = {
      messages: [],
      llmPriority: [],
      settings: {},
      vectorContext: {
        stores: ['memory'],
        mode: 'both',
        toolName: 'context_search'
      }
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const result = await collectTools({
      spec,
      registry
    });

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('context_search');
  });

  test('collectTools does not create vector_search tool when mode is auto', async () => {
    const spec = {
      messages: [],
      llmPriority: [],
      settings: {},
      vectorContext: {
        stores: ['memory'],
        mode: 'auto'
      }
    } as unknown as LLMCallSpec;

    const registry = {
      getTool: jest.fn()
    } as unknown as PluginRegistry;

    const result = await collectTools({
      spec,
      registry
    });

    expect(result.tools).toHaveLength(0);
  });
});
