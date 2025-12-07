import { jest, describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { VectorContextConfig, VectorQueryResult } from '@/core/types.ts';
import { PluginRegistry } from '@/core/registry.ts';

let ToolCoordinator: typeof import('@/utils/tools/tool-coordinator.ts').ToolCoordinator;

// Mock the vector-search-handler module
const mockExecuteVectorSearch = jest.fn();
const mockFormatVectorSearchResults = jest.fn();

beforeAll(async () => {
  // Mock the vector-search-handler
  await (jest as any).unstable_mockModule('@/utils/tools/vector-search-handler.ts', () => ({
    executeVectorSearch: mockExecuteVectorSearch,
    formatVectorSearchResults: mockFormatVectorSearchResults
  }));

  ({ ToolCoordinator } = await import('@/utils/tools/tool-coordinator.ts'));
});

describe('utils/tools/tool-coordinator vector search integration', () => {
  const mockRegistry = {
    getVectorStore: jest.fn().mockResolvedValue({
      id: 'test-store',
      kind: 'memory',
      defaultCollection: 'test-collection'
    }),
    getVectorStoreCompat: jest.fn().mockResolvedValue({
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([])
    })
  } as unknown as PluginRegistry;

  afterEach(() => {
    mockExecuteVectorSearch.mockReset();
    mockFormatVectorSearchResults.mockReset();
  });

  describe('isVectorSearchTool', () => {
    test('returns false when no vectorContext configured', () => {
      const coordinator = new ToolCoordinator([]);
      const result = (coordinator as any).isVectorSearchTool('vector_search');
      expect(result).toBe(false);
    });

    test('returns false when mode is auto (no tool created)', () => {
      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'auto'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      const result = (coordinator as any).isVectorSearchTool('vector_search');
      expect(result).toBe(false);
    });

    test('returns true when mode is tool and name matches default', () => {
      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      const result = (coordinator as any).isVectorSearchTool('vector_search');
      expect(result).toBe(true);
    });

    test('returns true when mode is both and name matches default', () => {
      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'both'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      const result = (coordinator as any).isVectorSearchTool('vector_search');
      expect(result).toBe(true);
    });

    test('returns true when name matches custom toolName', () => {
      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        toolName: 'search_knowledge'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      expect((coordinator as any).isVectorSearchTool('search_knowledge')).toBe(true);
      expect((coordinator as any).isVectorSearchTool('vector_search')).toBe(false);
    });

    test('returns false when name does not match', () => {
      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      expect((coordinator as any).isVectorSearchTool('other_tool')).toBe(false);
    });
  });

  describe('setVectorContext', () => {
    test('updates vector context and tool name', () => {
      const coordinator = new ToolCoordinator([]);

      expect((coordinator as any).isVectorSearchTool('vector_search')).toBe(false);

      coordinator.setVectorContext({
        stores: ['docs'],
        mode: 'tool',
        toolName: 'custom_search'
      }, mockRegistry);

      expect((coordinator as any).isVectorSearchTool('custom_search')).toBe(true);
      expect((coordinator as any).isVectorSearchTool('vector_search')).toBe(false);
    });

    test('clears vector context when set to undefined', () => {
      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: { stores: ['docs'], mode: 'tool' },
        registry: mockRegistry
      });

      expect((coordinator as any).isVectorSearchTool('vector_search')).toBe(true);

      coordinator.setVectorContext(undefined);

      expect((coordinator as any).isVectorSearchTool('vector_search')).toBe(false);
    });

    test('uses default tool name when config has no toolName', () => {
      const coordinator = new ToolCoordinator([]);

      coordinator.setVectorContext({
        stores: ['docs'],
        mode: 'tool'
        // No toolName specified - should default to 'vector_search'
      }, mockRegistry);

      expect((coordinator as any).isVectorSearchTool('vector_search')).toBe(true);
      expect((coordinator as any).vectorToolName).toBe('vector_search');
    });
  });

  describe('routeAndInvoke with vector_search', () => {
    test('routes vector_search to built-in handler', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [{ id: 'doc1', score: 0.9, payload: { text: 'Result' } }],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'test', topK: 5 }
      });
      mockFormatVectorSearchResults.mockReturnValue('Found 1 results:\n[1] (score: 0.900) Result');

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      const result = await coordinator.routeAndInvoke(
        'vector_search',
        'call-1',
        { query: 'test query', topK: 5, filter: { topic: 'llm' } },
        { provider: 'openrouter', model: 'gpt-4' }
      );

      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        { query: 'test query', topK: 5, store: undefined, filter: { topic: 'llm' } },
        expect.objectContaining({
          vectorConfig: config,
          registry: mockRegistry
        })
      );
      expect(result).toEqual({ result: 'Found 1 results:\n[1] (score: 0.900) Result' });
    });

    test('passes locks to handler', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'locked-store', collection: 'test', topK: 3 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const config: VectorContextConfig = {
        stores: ['docs', 'faq'],
        mode: 'tool',
        locks: {
          store: 'locked-store',
          topK: 3
        }
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      await coordinator.routeAndInvoke(
        'vector_search',
        'call-2',
        { query: 'test', store: 'faq', topK: 100, filter: { should: 'ignore' } }, // LLM tries to override
        { provider: 'openrouter', model: 'gpt-4' }
      );

      // Handler should receive the full config including locks
      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          vectorConfig: expect.objectContaining({
            locks: { store: 'locked-store', topK: 3 }
          })
        })
      );
    });

    test('falls back to regular routing when not vector_search', async () => {
      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const processRoute = {
        id: 'echo',
        match: { type: 'exact', pattern: 'echo' },
        invoke: { kind: 'module', module: './tests/fixtures/modules/echo.mjs' }
      };

      const coordinator = new ToolCoordinator([processRoute as any], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      // This should NOT go to vector search handler
      const timeoutSpy = jest
        .spyOn(coordinator as any, 'createTimeout')
        .mockImplementation(() => new Promise<never>(() => {}));
      const loadModuleSpy = jest
        .spyOn(coordinator as any, 'loadModule')
        .mockResolvedValue({
          handle: () => ({ result: 'echoed' })
        });

      const result = await coordinator.routeAndInvoke(
        'echo',
        'call-3',
        { text: 'hello' },
        { provider: 'openrouter', model: 'gpt-4' }
      );

      timeoutSpy.mockRestore();
      loadModuleSpy.mockRestore();

      expect(mockExecuteVectorSearch).not.toHaveBeenCalled();
      expect(result).toEqual({ result: 'echoed' });
    });

    test('throws error when vector_search called without registry', async () => {
      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config
        // No registry!
      });

      await expect(
        coordinator.routeAndInvoke(
          'vector_search',
          'call-4',
          { query: 'test' },
          { provider: 'openrouter', model: 'gpt-4' }
        )
      ).rejects.toThrow('Vector search not configured');
    });

    test('logs with no locks when locks is undefined', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'test', topK: 5 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
        // No locks property
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
      });

      const mockLogger = {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
      };

      await coordinator.routeAndInvoke(
        'vector_search',
        'call-5',
        { query: 'test' },
        { provider: 'openrouter', model: 'gpt-4', logger: mockLogger as any }
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Invoking built-in vector_search handler',
        expect.objectContaining({
          hasLocks: false,
          lockedParams: []
        })
      );
    });

    test('translates aliased args to canonical names', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'test', topK: 10 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      // Alias map: max_results -> topK, search_query -> query
      const aliasMap = {
        search_query: 'query',
        max_results: 'topK',
        store: 'store',
        filter: 'filter'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry,
        vectorSearchAliasMap: aliasMap
      });

      await coordinator.routeAndInvoke(
        'vector_search',
        'call-alias',
        { search_query: 'translated query', max_results: 10 }, // Using aliased names
        { provider: 'openrouter', model: 'gpt-4' }
      );

      // Should receive canonical names
      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'translated query',
          topK: 10
        }),
        expect.any(Object)
      );
    });

    test('canonical names still work with alias map', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'test', topK: 5 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const aliasMap = {
        search_query: 'query',
        max_results: 'topK'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry,
        vectorSearchAliasMap: aliasMap
      });

      // Using canonical name directly (not in alias map as key)
      await coordinator.routeAndInvoke(
        'vector_search',
        'call-canonical',
        { query: 'canonical query', store: 'docs' },
        { provider: 'openrouter', model: 'gpt-4' }
      );

      // Should pass through unchanged
      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'canonical query',
          store: 'docs'
        }),
        expect.any(Object)
      );
    });

    test('mixed aliased and canonical args work together', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'test', topK: 15 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const aliasMap = {
        search_query: 'query',
        limit: 'topK',
        store: 'store'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry,
        vectorSearchAliasMap: aliasMap
      });

      await coordinator.routeAndInvoke(
        'vector_search',
        'call-mixed',
        { search_query: 'mixed test', limit: 15, filter: { type: 'doc' } }, // mix of aliased and canonical
        { provider: 'openrouter', model: 'gpt-4' }
      );

      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'mixed test',
          topK: 15,
          filter: { type: 'doc' }
        }),
        expect.any(Object)
      );
    });

    test('works without alias map (backwards compatible)', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'test', topK: 5 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry
        // No aliasMap
      });

      await coordinator.routeAndInvoke(
        'vector_search',
        'call-no-alias',
        { query: 'no alias', topK: 5 },
        { provider: 'openrouter', model: 'gpt-4' }
      );

      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'no alias',
          topK: 5
        }),
        expect.any(Object)
      );
    });

    test('setVectorContext updates alias map', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'test', topK: 5 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: { stores: ['docs'], mode: 'tool' },
        registry: mockRegistry
      });

      // Update with alias map
      const newAliasMap = {
        q: 'query',
        results: 'topK'
      };

      coordinator.setVectorContext(
        { stores: ['docs'], mode: 'tool' },
        mockRegistry,
        newAliasMap
      );

      await coordinator.routeAndInvoke(
        'vector_search',
        'call-updated',
        { q: 'updated alias', results: 3 },
        { provider: 'openrouter', model: 'gpt-4' }
      );

      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'updated alias',
          topK: 3
        }),
        expect.any(Object)
      );
    });

    test('translates collection and scoreThreshold aliases', async () => {
      mockExecuteVectorSearch.mockResolvedValue({
        success: true,
        results: [],
        query: 'test',
        effectiveParams: { store: 'docs', collection: 'products', topK: 5 }
      });
      mockFormatVectorSearchResults.mockReturnValue('No results found');

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const aliasMap = {
        query: 'query',
        category: 'collection',
        min_score: 'scoreThreshold'
      };

      const coordinator = new ToolCoordinator([], undefined, {
        vectorContext: config,
        registry: mockRegistry,
        vectorSearchAliasMap: aliasMap
      });

      await coordinator.routeAndInvoke(
        'vector_search',
        'call-new-params',
        { query: 'test', category: 'products', min_score: 0.8 },
        { provider: 'openrouter', model: 'gpt-4' }
      );

      expect(mockExecuteVectorSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          collection: 'products',
          scoreThreshold: 0.8
        }),
        expect.any(Object)
      );
    });
  });
});
