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

      const { tool, aliasMap } = createVectorSearchTool(config);

      expect(tool.name).toBe('vector_search');
      expect(tool.description).toContain('qdrant-cloud');
      expect(tool.parametersJsonSchema.properties.query).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
      expect(tool.parametersJsonSchema.required).toContain('query');
      // Verify alias map has canonical names
      expect(aliasMap.query).toBe('query');
      expect(aliasMap.topK).toBe('topK');
    });

    test('uses custom tool name when provided', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool',
        toolName: 'semantic_search'
      };

      const { tool } = createVectorSearchTool(config);

      expect(tool.name).toBe('semantic_search');
    });

    test('uses custom description when provided', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool',
        toolDescription: 'Custom search description'
      };

      const { tool } = createVectorSearchTool(config);

      expect(tool.description).toBe('Custom search description');
    });

    test('includes topK default in description', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool',
        topK: 10
      };

      const { tool } = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.topK.description).toContain('10');
    });

    test('includes filter property when filter is not locked', () => {
      const config: VectorContextConfig = {
        stores: ['memory'],
        mode: 'tool'
      };

      const { tool } = createVectorSearchTool(config);

      expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
      expect(tool.parametersJsonSchema.properties.filter.type).toBe('object');
    });

    test('lists all stores in description', () => {
      const config: VectorContextConfig = {
        stores: ['store1', 'store2', 'store3'],
        mode: 'tool'
      };

      const { tool } = createVectorSearchTool(config);

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

        const { tool, aliasMap } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.query).toBeDefined();
        expect(tool.parametersJsonSchema.properties.store).toBeUndefined();
        expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
        expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
        // Locked param should not be in alias map
        expect(aliasMap.store).toBeUndefined();
      });

      test('omits topK from schema when topK is locked', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          locks: {
            topK: 5
          }
        };

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

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

        const { tool } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.query).toBeDefined();
        expect(tool.parametersJsonSchema.properties.store).toBeDefined();
        expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
        expect(tool.parametersJsonSchema.properties.filter).toBeUndefined();
      });
    });

    // Schema overrides tests
    describe('with toolSchemaOverrides', () => {
      test('renames parameter using name override', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {
            params: {
              topK: { name: 'max_results' }
            }
          }
        };

        const { tool, aliasMap } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.max_results).toBeDefined();
        expect(tool.parametersJsonSchema.properties.topK).toBeUndefined();
        expect(aliasMap.max_results).toBe('topK');
      });

      test('overrides parameter description', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {
            params: {
              query: { description: 'Your search terms' }
            }
          }
        };

        const { tool } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.query.description).toBe('Your search terms');
      });

      test('overrides tool description via toolSchemaOverrides', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolDescription: 'Original description',
          toolSchemaOverrides: {
            toolDescription: 'Overridden description'
          }
        };

        const { tool } = createVectorSearchTool(config);

        expect(tool.description).toBe('Overridden description');
      });

      test('hides normally-exposed param with expose=false', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {
            params: {
              store: { expose: false }
            }
          }
        };

        const { tool, aliasMap } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.store).toBeUndefined();
        expect(aliasMap.store).toBeUndefined();
      });

      test('exposes collection with expose=true', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          collection: 'my-collection',
          toolSchemaOverrides: {
            params: {
              collection: { expose: true }
            }
          }
        };

        const { tool, aliasMap } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.collection).toBeDefined();
        expect(aliasMap.collection).toBe('collection');
      });

      test('exposes scoreThreshold with expose=true and custom name', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          scoreThreshold: 0.7,
          toolSchemaOverrides: {
            params: {
              scoreThreshold: { expose: true, name: 'min_score' }
            }
          }
        };

        const { tool, aliasMap } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.min_score).toBeDefined();
        expect(tool.parametersJsonSchema.properties.scoreThreshold).toBeUndefined();
        expect(aliasMap.min_score).toBe('scoreThreshold');
      });

      test('multiple overrides work together', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {
            toolDescription: 'Custom search',
            params: {
              query: { name: 'search_query', description: 'What to search for' },
              topK: { name: 'limit', description: 'Max results' },
              store: { expose: false },
              collection: { expose: true, name: 'category' }
            }
          }
        };

        const { tool, aliasMap } = createVectorSearchTool(config);

        expect(tool.description).toBe('Custom search');
        expect(tool.parametersJsonSchema.properties.search_query).toBeDefined();
        expect(tool.parametersJsonSchema.properties.search_query.description).toBe('What to search for');
        expect(tool.parametersJsonSchema.properties.limit).toBeDefined();
        expect(tool.parametersJsonSchema.properties.store).toBeUndefined();
        expect(tool.parametersJsonSchema.properties.category).toBeDefined();
        expect(aliasMap.search_query).toBe('query');
        expect(aliasMap.limit).toBe('topK');
        expect(aliasMap.category).toBe('collection');
      });

      test('locked param stays hidden even with expose=true override', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          locks: {
            store: 'docs'
          },
          toolSchemaOverrides: {
            params: {
              store: { expose: true, name: 'data_source' }
            }
          }
        };

        const { tool, aliasMap } = createVectorSearchTool(config);

        // Store is locked, so it should not appear in schema regardless of override
        expect(tool.parametersJsonSchema.properties.store).toBeUndefined();
        expect(tool.parametersJsonSchema.properties.data_source).toBeUndefined();
        expect(aliasMap.data_source).toBeUndefined();
        expect(aliasMap.store).toBeUndefined();
      });

      test('throws error on duplicate exposed names', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {
            params: {
              topK: { name: 'query' }, // Conflicts with default query name
              query: {} // Uses default name 'query'
            }
          }
        };

        expect(() => createVectorSearchTool(config)).toThrow(/Duplicate exposed parameter name/);
      });

      test('query alias is used in required array', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {
            params: {
              query: { name: 'search_terms' }
            }
          }
        };

        const { tool } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.required).toContain('search_terms');
        expect(tool.parametersJsonSchema.required).not.toContain('query');
      });

      test('empty overrides object does not affect schema', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {}
        };

        const { tool, aliasMap } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.query).toBeDefined();
        expect(tool.parametersJsonSchema.properties.topK).toBeDefined();
        expect(tool.parametersJsonSchema.properties.store).toBeDefined();
        expect(tool.parametersJsonSchema.properties.filter).toBeDefined();
        expect(aliasMap.query).toBe('query');
      });

      test('scoreThreshold description without default value', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          // No scoreThreshold set
          toolSchemaOverrides: {
            params: {
              scoreThreshold: { expose: true }
            }
          }
        };

        const { tool } = createVectorSearchTool(config);

        expect(tool.parametersJsonSchema.properties.scoreThreshold).toBeDefined();
        expect(tool.parametersJsonSchema.properties.scoreThreshold.description).toBe('Minimum similarity score (0-1)');
      });

      test('uses canonical query name in required when query is aliased but hidden', () => {
        const config: VectorContextConfig = {
          stores: ['docs'],
          mode: 'tool',
          toolSchemaOverrides: {
            params: {
              query: { name: 'search_terms', expose: false } // Hide query with an alias
            }
          }
        };

        const { tool } = createVectorSearchTool(config);

        // Since query is hidden, required should fall back to canonical 'query'
        // though in practice this is an edge case (hiding query would break the tool)
        expect(tool.parametersJsonSchema.required).toContain('query');
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
