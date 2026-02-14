import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import {
  executeVectorSearch,
  formatVectorSearchResults,
  VectorSearchArgs,
  VectorSearchHandlerContext,
  VectorSearchResult
} from '@/modules/vector/index.ts';
import { VectorContextConfig, VectorQueryResult } from '@/kernel/index.ts';
import { PluginRegistry } from '@/kernel/index.ts';

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
      defaultCollection: 'test-collection',
      defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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
          defaultCollection: 'store-default',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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
          defaultCollection: 'test',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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
          defaultCollection: 'test',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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
          defaultCollection: 'test',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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

    test('returns error when vector store compat is unavailable', async () => {
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
          defaultCollection: 'test',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
        }),
        getVectorStoreCompat: jest.fn().mockRejectedValue(new Error('No compat available'))
      } as unknown as PluginRegistry;

      const embeddingManager = createMockEmbeddingManager();

      const context: VectorSearchHandlerContext = {
        vectorConfig: config,
        registry,
        embeddingManager
      };

      const result = await executeVectorSearch(args, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not available');
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
          defaultCollection: 'default',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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

    describe('queryPriority failure-only fallback', () => {
      test('falls back to next candidate when first candidate embedding fails', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['store1'],
          mode: 'tool',
          queryPriority: [
            { collection: 'collection-1', embeddingPriority: [{ provider: 'emb1' }] },
            { collection: 'collection-2', embeddingPriority: [{ provider: 'emb2' }] }
          ] as any
        } as any;

        const embeddingManager = {
          embed: jest.fn().mockImplementation(async (_query: string, priority: Array<{ provider: string }>) => {
            if (priority[0]?.provider === 'emb1') {
              throw new Error('candidate-1-embed-failed');
            }
            return {
              vectors: [[0.2, 0.4]],
              model: 'model-2',
              dimensions: 2
            };
          })
        } as any;

        const compat = {
          query: jest.fn().mockResolvedValue([
            { id: 'doc2', score: 0.95, payload: { text: 'candidate-2' } }
          ])
        };
        const vectorManager = {
          getCompat: jest.fn().mockResolvedValue(compat),
          closeAll: jest.fn()
        } as any;

        const registry = {
          getVectorStore: jest.fn().mockResolvedValue({
            id: 'store1',
            kind: 'memory',
            defaultCollection: 'default-collection'
          })
        } as unknown as PluginRegistry;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry,
          embeddingManager,
          vectorManager
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(true);
        expect(embeddingManager.embed).toHaveBeenCalledTimes(2);
        expect(compat.query).toHaveBeenCalledTimes(1);
        expect(compat.query).toHaveBeenCalledWith(
          'collection-2',
          expect.any(Array),
          expect.any(Number),
          expect.any(Object)
        );
      });

      test('falls back to next candidate when first candidate query fails', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['store1'],
          mode: 'tool',
          queryPriority: [
            { collection: 'collection-1', embeddingPriority: [{ provider: 'emb1' }] },
            { collection: 'collection-2', embeddingPriority: [{ provider: 'emb2' }] }
          ] as any
        } as any;

        const embeddingManager = createMockEmbeddingManager();
        const compat = {
          query: jest.fn().mockImplementation(async (collection: string) => {
            if (collection === 'collection-1') {
              throw new Error('candidate-1-query-failed');
            }
            return [{ id: 'doc2', score: 0.9, payload: { text: 'candidate-2' } }];
          })
        };
        const vectorManager = {
          getCompat: jest.fn().mockResolvedValue(compat),
          closeAll: jest.fn()
        } as any;

        const registry = {
          getVectorStore: jest.fn().mockResolvedValue({
            id: 'store1',
            kind: 'memory',
            defaultCollection: 'default-collection'
          })
        } as unknown as PluginRegistry;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry,
          embeddingManager,
          vectorManager
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(true);
        expect(compat.query).toHaveBeenCalledTimes(2);
        expect(compat.query).toHaveBeenNthCalledWith(
          1,
          'collection-1',
          expect.any(Array),
          expect.any(Number),
          expect.any(Object)
        );
        expect(compat.query).toHaveBeenNthCalledWith(
          2,
          'collection-2',
          expect.any(Array),
          expect.any(Number),
          expect.any(Object)
        );
      });

      test('does not fall back when first candidate query succeeds with empty results', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['store1'],
          mode: 'tool',
          queryPriority: [
            { collection: 'collection-1', embeddingPriority: [{ provider: 'emb1' }] },
            { collection: 'collection-2', embeddingPriority: [{ provider: 'emb2' }] }
          ] as any
        } as any;

        const embeddingManager = createMockEmbeddingManager();
        const compat = {
          query: jest.fn().mockImplementation(async (collection: string) => {
            if (collection === 'collection-1') return [];
            return [{ id: 'doc2', score: 0.9, payload: { text: 'should-not-be-used' } }];
          })
        };
        const vectorManager = {
          getCompat: jest.fn().mockResolvedValue(compat),
          closeAll: jest.fn()
        } as any;

        const registry = {
          getVectorStore: jest.fn().mockResolvedValue({
            id: 'store1',
            kind: 'memory',
            defaultCollection: 'default-collection'
          })
        } as unknown as PluginRegistry;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry,
          embeddingManager,
          vectorManager
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(true);
        expect(result.results).toEqual([]);
        expect(compat.query).toHaveBeenCalledTimes(1);
        expect(compat.query).toHaveBeenCalledWith(
          'collection-1',
          expect.any(Array),
          expect.any(Number),
          expect.any(Object)
        );
      });

      test('does not fall back when first candidate results are filtered to empty', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['store1'],
          mode: 'tool',
          scoreThreshold: 0.9,
          queryPriority: [
            { collection: 'collection-1', embeddingPriority: [{ provider: 'emb1' }] },
            { collection: 'collection-2', embeddingPriority: [{ provider: 'emb2' }] }
          ] as any
        } as any;

        const embeddingManager = createMockEmbeddingManager();
        const compat = {
          query: jest.fn().mockImplementation(async (collection: string) => {
            if (collection === 'collection-1') {
              return [{ id: 'doc-low', score: 0.2, payload: { text: 'low-score' } }];
            }
            return [{ id: 'doc2', score: 0.95, payload: { text: 'should-not-be-used' } }];
          })
        };
        const vectorManager = {
          getCompat: jest.fn().mockResolvedValue(compat),
          closeAll: jest.fn()
        } as any;

        const registry = {
          getVectorStore: jest.fn().mockResolvedValue({
            id: 'store1',
            kind: 'memory',
            defaultCollection: 'default-collection'
          })
        } as unknown as PluginRegistry;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry,
          embeddingManager,
          vectorManager
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(true);
        expect(result.results).toEqual([]);
        expect(compat.query).toHaveBeenCalledTimes(1);
      });

      test('stops store fallback when first store query succeeds with empty results for a candidate', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['store1', 'store2'],
          mode: 'tool',
          queryPriority: [
            {
              stores: ['store1', 'store2'],
              collection: 'collection-1',
              embeddingPriority: [{ provider: 'emb1' }]
            }
          ] as any
        } as any;

        const embeddingManager = createMockEmbeddingManager();
        const store1Compat = {
          query: jest.fn().mockResolvedValue([])
        };
        const store2Compat = {
          query: jest.fn().mockResolvedValue([
            { id: 'doc-store2', score: 0.99, payload: { text: 'should-not-be-used' } }
          ])
        };
        const vectorManager = {
          getCompat: jest.fn().mockImplementation(async (storeId: string) => {
            if (storeId === 'store1') return store1Compat;
            if (storeId === 'store2') return store2Compat;
            return null;
          }),
          closeAll: jest.fn()
        } as any;

        const registry = {
          getVectorStore: jest.fn().mockImplementation(async (storeId: string) => ({
            id: storeId,
            kind: 'memory',
            defaultCollection: `${storeId}-default`
          }))
        } as unknown as PluginRegistry;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry,
          embeddingManager,
          vectorManager
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(true);
        expect(result.results).toEqual([]);
        expect(store1Compat.query).toHaveBeenCalledTimes(1);
        expect(store2Compat.query).not.toHaveBeenCalled();
      });

      test('ignores tool args store and collection when queryPriority is active', async () => {
        const args: VectorSearchArgs = {
          query: 'test query',
          store: 'llm-store-override',
          collection: 'llm-collection-override'
        };

        const config: VectorContextConfig = {
          stores: ['store1'],
          mode: 'tool',
          queryPriority: [
            {
              stores: ['store2'],
              collection: 'candidate-collection',
              embeddingPriority: [{ provider: 'emb2' }]
            }
          ] as any
        } as any;

        const embeddingManager = createMockEmbeddingManager();
        const compat = {
          query: jest.fn().mockResolvedValue([
            { id: 'doc2', score: 0.99, payload: { text: 'ok' } }
          ])
        };
        const vectorManager = {
          getCompat: jest.fn().mockImplementation(async (storeId: string) => {
            if (storeId === 'store2') return compat;
            return null;
          }),
          closeAll: jest.fn()
        } as any;

        const registry = {
          getVectorStore: jest.fn().mockImplementation(async (storeId: string) => ({
            id: storeId,
            kind: 'memory',
            defaultCollection: `${storeId}-default`
          }))
        } as unknown as PluginRegistry;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry,
          embeddingManager,
          vectorManager
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(true);
        expect(result.effectiveParams.store).toBe('store2');
        expect(result.effectiveParams.collection).toBe('candidate-collection');
        expect(vectorManager.getCompat).toHaveBeenCalledWith('store2');
        expect(compat.query).toHaveBeenCalledWith(
          'candidate-collection',
          expect.any(Array),
          expect.any(Number),
          expect.any(Object)
        );
      });

      test('uses locks.store over queryPriority candidate stores', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['fallback-store'],
          mode: 'tool',
          locks: {
            store: 'locked-store'
          },
          queryPriority: [
            {
              stores: ['candidate-store'],
              collection: 'candidate-collection',
              embeddingPriority: [{ provider: 'emb-a' }]
            }
          ] as any
        } as any;

        const embeddingManager = createMockEmbeddingManager();
        const lockedCompat = {
          query: jest.fn().mockResolvedValue([
            { id: 'doc-locked', score: 0.91, payload: { text: 'locked-store-result' } }
          ])
        };
        const vectorManager = {
          getCompat: jest.fn().mockImplementation(async (storeId: string) => {
            if (storeId === 'locked-store') return lockedCompat;
            return null;
          }),
          closeAll: jest.fn()
        } as any;

        const registry = {
          getVectorStore: jest.fn().mockImplementation(async (storeId: string) => ({
            id: storeId,
            kind: 'memory',
            defaultCollection: `${storeId}-default`
          }))
        } as unknown as PluginRegistry;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry,
          embeddingManager,
          vectorManager
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(true);
        expect(result.effectiveParams.store).toBe('locked-store');
        expect(vectorManager.getCompat).toHaveBeenCalledWith('locked-store');
        expect(lockedCompat.query).toHaveBeenCalledWith(
          'candidate-collection',
          expect.any(Array),
          expect.any(Number),
          expect.any(Object)
        );
      });

      test('fails closed when queryPriority is used with locks.collection', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['store1'],
          mode: 'tool',
          locks: {
            collection: 'locked-collection'
          },
          queryPriority: [
            { collection: 'candidate-collection', embeddingPriority: [{ provider: 'emb1' }] }
          ] as any
        } as any;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry: createMockRegistry(),
          embeddingManager: createMockEmbeddingManager(),
          vectorManager: createMockVectorManager()
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('queryPriority');
        expect(result.error).toContain('locks.collection');
      });

      test('fails closed when queryPriority candidate is missing required fields', async () => {
        const args: VectorSearchArgs = {
          query: 'test query'
        };

        const config: VectorContextConfig = {
          stores: ['store1'],
          mode: 'tool',
          queryPriority: [
            {
              stores: ['store1'],
              collection: 'candidate-collection'
            }
          ] as any
        } as any;

        const context: VectorSearchHandlerContext = {
          vectorConfig: config,
          registry: createMockRegistry(),
          embeddingManager: createMockEmbeddingManager(),
          vectorManager: createMockVectorManager()
        };

        const result = await executeVectorSearch(args, context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('queryPriority');
        expect(result.error).toContain('embeddingPriority');
      });
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

  describe('formatVectorSearchResults with resultFormat config', () => {
    test('uses custom resultFormat from config', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.95, payload: { text: 'Default text', full_specs: 'Full specifications here' } },
          { id: 'doc2', score: 0.87, payload: { text: 'Another text', full_specs: 'More specifications' } }
        ],
        query: 'test query',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        resultFormat: '{{payload.full_specs}}'
      };

      const formatted = formatVectorSearchResults(result, config);

      expect(formatted).toContain('Found 2 results');
      expect(formatted).toContain('Full specifications here');
      expect(formatted).toContain('More specifications');
      // Should NOT contain the default text field
      expect(formatted).not.toContain('Default text');
      expect(formatted).not.toContain('Another text');
    });

    test('uses resultFormat with score and id placeholders', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'vehicle-123', score: 0.99, payload: { name: 'Honda Civic' } }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        resultFormat: '[ID: {{id}}] {{payload.name}} (relevance: {{score}})'
      };

      const formatted = formatVectorSearchResults(result, config);

      expect(formatted).toContain('ID: vehicle-123');
      expect(formatted).toContain('Honda Civic');
      expect(formatted).toContain('relevance: 0.99');
    });

    test('uses nested payload fields in resultFormat', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          {
            id: 'doc1',
            score: 0.9,
            payload: {
              text: 'Simple text',
              metadata: {
                category: 'technology',
                author: 'John Doe'
              }
            }
          }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        resultFormat: '{{payload.metadata.category}} by {{payload.metadata.author}}: {{payload.text}}'
      };

      const formatted = formatVectorSearchResults(result, config);

      expect(formatted).toContain('technology by John Doe: Simple text');
    });

    test('falls back to default behavior when config has no resultFormat', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.95, payload: { text: 'Default text content' } }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool'
        // No resultFormat specified - should use default behavior (payload.text)
      };

      const formatted = formatVectorSearchResults(result, config);

      // Should use default behavior: payload.text with score
      expect(formatted).toContain('Found 1 results');
      expect(formatted).toContain('Default text content');
      expect(formatted).toContain('0.950');
    });

    test('falls back to default format when no config provided', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.95, payload: { text: 'Default text content' } }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      // No config provided - should use default behavior
      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('Found 1 results');
      expect(formatted).toContain('Default text content');
      expect(formatted).toContain('0.950');
    });

    test('handles missing payload fields gracefully in resultFormat', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.9, payload: { text: 'Some text' } }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        resultFormat: '{{payload.nonexistent_field}} - {{payload.text}}'
      };

      const formatted = formatVectorSearchResults(result, config);

      // Missing fields should render as empty string, not throw
      expect(formatted).toContain('Found 1 results');
      expect(formatted).toContain(' - Some text');
    });

    test('handles null/undefined values in nested payload paths', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.9, payload: { metadata: null } as any }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        resultFormat: '{{payload.metadata.category}}'
      };

      const formatted = formatVectorSearchResults(result, config);

      // Should not throw, should render empty for null path
      expect(formatted).toContain('Found 1 results');
    });

    test('preserves backward compatibility with JSON stringify fallback for missing text', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.9, payload: { category: 'tech', author: 'jane' } }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      // No config - should use default behavior which JSON stringifies when no text field
      const formatted = formatVectorSearchResults(result);

      expect(formatted).toContain('Found 1 results');
      // Without text field and no custom format, should JSON stringify the payload
      expect(formatted).toContain('category');
      expect(formatted).toContain('tech');
    });

    test('handles undefined payload with custom resultFormat', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          { id: 'doc1', score: 0.9, payload: undefined }
        ],
        query: 'test',
        effectiveParams: {
          store: 'docs',
          collection: 'test',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        resultFormat: '{{payload.text}} - {{id}}'
      };

      const formatted = formatVectorSearchResults(result, config);

      // Should not throw, should render empty for missing payload fields
      expect(formatted).toContain('Found 1 results');
      expect(formatted).toContain(' - doc1');
    });

    test('uses resultFormat for complex vehicle specs scenario (issue reproduction)', () => {
      const result: VectorSearchResult = {
        success: true,
        results: [
          {
            id: 'vehicle-2024-elantra',
            score: 1.0,
            payload: {
              text: '2024 Hyundai Elantra Essential',
              full_specs: '[VEHICLE] 2024 Hyundai Elantra Essential\n[INTERIOR]\nInterior Color: Black\nSeats: 5'
            }
          },
          {
            id: 'vehicle-2023-elantra',
            score: 0.981,
            payload: {
              text: '2023 Hyundai Elantra Essential',
              full_specs: '[VEHICLE] 2023 Hyundai Elantra Essential\n[INTERIOR]\nInterior Color: Grey\nSeats: 5'
            }
          }
        ],
        query: 'Hyundai Elantra specs',
        effectiveParams: {
          store: 'docs',
          collection: 'vehicles',
          topK: 5
        }
      };

      const config: VectorContextConfig = {
        stores: ['docs'],
        mode: 'tool',
        resultFormat: '{{payload.full_specs}}'
      };

      const formatted = formatVectorSearchResults(result, config);

      expect(formatted).toContain('Found 2 results');
      expect(formatted).toContain('[VEHICLE] 2024 Hyundai Elantra Essential');
      expect(formatted).toContain('[INTERIOR]');
      expect(formatted).toContain('Interior Color: Black');
      expect(formatted).toContain('[VEHICLE] 2023 Hyundai Elantra Essential');
      expect(formatted).toContain('Interior Color: Grey');
      // Should NOT contain just the text field
      expect(formatted).not.toMatch(/\[1\].*2024 Hyundai Elantra Essential\n\[2\]/);
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
          kind: 'memory',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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
          defaultCollection: 'test',
          defaultEmbeddingPriority: [{ provider: 'test-embeddings' }]
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
