import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import {
  executeVectorSearch,
  formatVectorSearchResults,
  VectorSearchArgs,
  VectorSearchHandlerContext,
  VectorSearchResult
} from '@/utils/tools/vector-search-handler.ts';
import { VectorContextConfig, VectorQueryResult } from '@/core/types.ts';
import { PluginRegistry } from '@/core/registry.ts';

describe('utils/tools/vector-search-handler', () => {
  // Mock implementations
  const mockEmbedResult = {
    vectors: [[0.1, 0.2, 0.3]],
    model: 'test-model',
    dimensions: 3
  };

  const mockQueryResults: VectorQueryResult[] = [
    { id: 'doc1', score: 0.95, payload: { text: 'Result one text' } },
    { id: 'doc2', score: 0.87, payload: { text: 'Result two text' } },
    { id: 'doc3', score: 0.75, payload: { text: 'Result three text' } }
  ];

  const createMockRegistry = () => ({
    getVectorStore: jest.fn().mockResolvedValue({
      id: 'test-store',
      kind: 'memory',
      defaultCollection: 'test-collection'
    }),
    getVectorStoreCompat: jest.fn().mockResolvedValue({
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(mockQueryResults),
      setLogger: jest.fn()
    })
  } as unknown as PluginRegistry);

  const createMockEmbeddingManager = () => ({
    embed: jest.fn().mockResolvedValue(mockEmbedResult)
  } as any);

  const createMockVectorManager = () => ({} as any);

  describe('executeVectorSearch', () => {
    test('executes search with LLM-provided args when no locks', async () => {
      const args: VectorSearchArgs = {
        query: 'test query',
        topK: 5,
        store: 'my-store'
      };

      const config: VectorContextConfig = {
        stores: ['default-store', 'my-store'],
        mode: 'tool'
      };

      const registry = createMockRegistry();
      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.store).toBe('my-store');
      expect(result.effectiveParams.topK).toBe(5);
      expect(result.results).toHaveLength(3);
    });

    test('uses LLM-provided filter when unlocked and overrides config filter', async () => {
      const args: VectorSearchArgs = {
        query: 'test query',
        filter: { category: 'llm' }
      };

      const config: VectorContextConfig = {
        stores: ['default-store'],
        mode: 'tool',
        filter: { category: 'config' }
      };

      const registry = createMockRegistry();
      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.filter).toEqual({ category: 'llm' });
      expect(registry.getVectorStoreCompat).toHaveBeenCalled();
    });

    test('enforces locked store over LLM args', async () => {
      const args: VectorSearchArgs = {
        query: 'test query',
        store: 'llm-requested-store'
      };

      const config: VectorContextConfig = {
        stores: ['store1', 'store2'],
        mode: 'tool',
        locks: {
          store: 'locked-store'
        }
      };

      const registry = createMockRegistry();
      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.store).toBe('locked-store');
      expect(registry.getVectorStore).toHaveBeenCalledWith('locked-store');
    });

    test('enforces locked topK over LLM args', async () => {
      const args: VectorSearchArgs = {
        query: 'test query',
        topK: 100 // LLM tries to request many results
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        locks: {
          topK: 3 // But we lock to 3
        }
      };

      const registry = createMockRegistry();
      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.topK).toBe(3);
    });

    test('enforces locked scoreThreshold', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        locks: {
          scoreThreshold: 0.9 // High threshold
        }
      };

      const registry = createMockRegistry();
      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      // Only doc1 (0.95) should pass the 0.9 threshold
      expect(result.results).toHaveLength(1);
      expect(result.results![0].id).toBe('doc1');
    });

    test('enforces locked collection', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        collection: 'default-collection',
        locks: {
          collection: 'locked-collection'
        }
      };

      const mockCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(mockQueryResults),
        setLogger: jest.fn()
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'docs',
          kind: 'memory',
          defaultCollection: 'store-default'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockCompat)
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.collection).toBe('locked-collection');
      expect(mockCompat.query).toHaveBeenCalledWith(
        'locked-collection',
        expect.any(Array),
        expect.any(Number),
        expect.any(Object)
      );
    });

    test('enforces locked filter', async () => {
      const args: VectorSearchArgs = {
        query: 'test query',
        filter: { type: 'llm', category: 'should-not-apply' }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        filter: { type: 'default' },
        locks: {
          filter: { type: 'locked', category: 'secure' }
        }
      };

      const mockCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(mockQueryResults),
        setLogger: jest.fn()
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'docs',
          kind: 'memory',
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockCompat)
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.filter).toEqual({ type: 'locked', category: 'secure' });
      expect(mockCompat.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          filter: { type: 'locked', category: 'secure' }
        })
      );
    });

    test('falls back to config filter when LLM does not provide one and filter is unlocked', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        filter: { topic: 'default' }
      };

      const mockCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(mockQueryResults),
        setLogger: jest.fn()
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'docs',
          kind: 'memory',
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockCompat)
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.filter).toEqual({ topic: 'default' });
      expect(mockCompat.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(Number),
        expect.objectContaining({
          filter: { topic: 'default' }
        })
      );
    });

    test('uses first store when no store specified and not locked', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
        // No store specified
      };

      const config: VectorContextConfig = {
        stores: ['first-store', 'second-store'],
        mode: 'tool'
      };

      const registry = createMockRegistry();
      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.store).toBe('first-store');
    });

    test('uses config topK when not in args and not locked', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
        // No topK specified
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        topK: 15
      };

      const registry = createMockRegistry();
      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.topK).toBe(15);
    });

    test('handles embedding error gracefully', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const registry = createMockRegistry();
      const embeddingManager = {
        embed: jest.fn().mockRejectedValue(new Error('Embedding failed'))
      } as any;

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Embedding failed');
    });

    test('handles query error gracefully', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'docs',
          kind: 'memory',
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue({
          connect: jest.fn().mockResolvedValue(undefined),
          query: jest.fn().mockRejectedValue(new Error('Query failed')),
          setLogger: jest.fn()
        })
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Query failed');
    });

    test('multiple locks are all enforced', async () => {
      const args: VectorSearchArgs = {
        query: 'test query',
        store: 'llm-store',
        topK: 50
      };

      const config: VectorContextConfig = {
        stores: ['store1', 'store2'],
        mode: 'tool',
        topK: 20,
        scoreThreshold: 0.5,
        locks: {
          store: 'locked-store',
          topK: 5,
          scoreThreshold: 0.8,
          collection: 'locked-collection',
          filter: { secure: true }
        }
      };

      const mockCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(mockQueryResults),
        setLogger: jest.fn()
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'locked-store',
          kind: 'memory',
          defaultCollection: 'default'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockCompat)
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.store).toBe('locked-store');
      expect(result.effectiveParams.topK).toBe(5);
      expect(result.effectiveParams.collection).toBe('locked-collection');
      expect(result.effectiveParams.scoreThreshold).toBe(0.8);
      expect(result.effectiveParams.filter).toEqual({ secure: true });

      // Only 2 results pass the 0.8 threshold (0.95 and 0.87)
      expect(result.results).toHaveLength(2);
    });
  });

  describe('formatVectorSearchResults', () => {
    test('formats successful results', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.95, payload: { text: 'First result' } },
          { id: 'doc2', score: 0.87, payload: { text: 'Second result' } }
        ],
        query: 'test query',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('Found 2 results');
      expect(formatted).toContain('[1]');
      expect(formatted).toContain('0.950');
      expect(formatted).toContain('First result');
      expect(formatted).toContain('[2]');
      expect(formatted).toContain('Second result');
    });

    test('formats error result', () => {
      const result: VectorSearchResult = {
        success: false,
        error: 'Connection failed',
        query: 'test query',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('Vector search failed');
      expect(formatted).toContain('Connection failed');
    });

    test('formats empty results', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [],
        query: 'obscure query',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('No results found');
      expect(formatted).toContain('obscure query');
    });

    test('handles results without text payload', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.9, payload: { category: 'tech', author: 'john' } }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('Found 1 results');
      expect(formatted).toContain('category');
      expect(formatted).toContain('tech');
    });

    test('handles undefined results array', () => {
      const result: VectorSearchResult = {
        success: true,
        results: undefined,
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('No results found');
    });

    test('handles results with null payload', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.9, payload: null as any }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('Found 1 results');
      expect(formatted).toContain('{}');
    });
  });

  describe('branch coverage - edge cases', () => {
    test('uses default collection when store has no defaultCollection', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
        // No collection specified
      };

      const mockCompat = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(mockQueryResults),
        setLogger: jest.fn()
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'docs',
          kind: 'memory'
          // No defaultCollection
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(mockCompat)
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(true);
      expect(result.effectiveParams.collection).toBe('default');
      expect(mockCompat.query).toHaveBeenCalledWith(
        'default',
        expect.any(Array),
        expect.any(Number),
        expect.any(Object)
      );
    });

    test('handles non-Error exceptions', async () => {
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'docs',
          kind: 'memory',
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue({
          connect: jest.fn().mockResolvedValue(undefined),
          query: jest.fn().mockRejectedValue('String error thrown'),
          setLogger: jest.fn()
        })
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('String error thrown');
    });

    test('creates embeddingManager when not provided', async () => {
      // This test would need real registry or more complex mocking
      // For now, we test that it attempts to call the embed function
      const args: VectorSearchArgs = {
        query: 'test query'
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        embeddingPriority: [{ provider: 'test-embeddings' }]
      };

      const registry = {
        getVectorStore: jest.fn().mockResolvedValue({
          id: 'docs',
          kind: 'memory',
          defaultCollection: 'test'
        }),
        getVectorStoreCompat: jest.fn().mockResolvedValue({
          connect: jest.fn().mockResolvedValue(undefined),
          query: jest.fn().mockResolvedValue(mockQueryResults),
          setLogger: jest.fn()
        }),
        getEmbeddingProvider: jest.fn().mockRejectedValue(new Error('No embedding provider'))
      } as unknown as PluginRegistry;

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry
        // No embeddingManager provided - will create one internally
      };

      // This will fail because no real embedding provider, but it tests the branch
      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
