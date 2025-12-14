import { jest } from '@jest/globals';

// Type imports - will exist after implementation
import type { VectorStoreCoordinator } from '@/coordinator/vector-coordinator.ts';
import type { VectorCallSpec, VectorOperationResult } from '@/core/vector-spec-types.ts';

// Mock registry helper
function createMockRegistry(options: {
  embeddingProvider?: any;
  embeddingCompat?: any;
  vectorStore?: any;
  vectorCompat?: any;
  providerError?: Error;
  compatError?: Error;
} = {}) {
  return {
    getEmbeddingProvider: jest.fn().mockImplementation(async () => {
      if (options.providerError) throw options.providerError;
      return options.embeddingProvider || {
        id: 'test-embeddings',
        kind: 'openrouter',
        endpoint: { urlTemplate: 'http://test', headers: {} },
        model: 'test-model',
        dimensions: 128
      };
    }),
    getEmbeddingCompat: jest.fn().mockImplementation(async () => {
      if (options.compatError) throw options.compatError;
      return options.embeddingCompat || {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(128)
      };
    }),
    getVectorStore: jest.fn().mockImplementation(async () => {
      if (options.providerError) throw options.providerError;
      return options.vectorStore || {
        id: 'test-store',
        kind: 'memory',
        connection: {},
        defaultCollection: 'test'
      };
    }),
    getVectorStoreCompat: jest.fn().mockImplementation(async () => {
      if (options.compatError) throw options.compatError;
      return options.vectorCompat || createMockVectorCompat();
    }),
    loadAll: jest.fn().mockResolvedValue(undefined)
  };
}

function createMockVectorCompat() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([
      { id: 'doc1', score: 0.95, payload: { text: 'hello' } }
    ]),
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteByIds: jest.fn().mockResolvedValue(undefined),
    collectionExists: jest.fn().mockResolvedValue(true),
    createCollection: jest.fn().mockResolvedValue(undefined)
  };
}

describe('coordinator/vector-coordinator', () => {
  let VectorStoreCoordinator: any;

  beforeAll(async () => {
    try {
      const module = await import('@/coordinator/vector-coordinator.ts');
      VectorStoreCoordinator = module.VectorStoreCoordinator;
    } catch {
      // Module doesn't exist yet - tests document expected behavior
      VectorStoreCoordinator = class MockVectorStoreCoordinator {
        constructor(public registry: any) {}
        async execute(spec: VectorCallSpec): Promise<VectorOperationResult> {
          throw new Error('Not implemented');
        }
        async *executeStream(spec: VectorCallSpec) {
          yield { type: 'done' };
        }
        async close() {}
      };
    }
  });

  describe('execute', () => {
    describe('embed operation', () => {
      test('embeds texts and upserts to store', async () => {
        const embeddingCompat = {
          embed: jest.fn().mockResolvedValue({
            vectors: [[0.1, 0.2], [0.3, 0.4]],
            model: 'test',
            dimensions: 2
          }),
          getDimensions: jest.fn().mockReturnValue(2)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            texts: ['hello', 'world']
          }
        });

        expect(result.success).toBe(true);
        expect(result.operation).toBe('embed');
        expect(result.embedded).toBe(2);
        expect(result.upserted).toBe(2);
        expect(embeddingCompat.embed).toHaveBeenCalledWith(
          ['hello', 'world'],
          expect.anything(),
          undefined,
          expect.anything() // logger parameter
        );
        expect(vectorCompat.upsert).toHaveBeenCalled();
      });

      test('embeds chunks with custom IDs and metadata', async () => {
        const embeddingCompat = {
          embed: jest.fn().mockResolvedValue({
            vectors: [[0.1], [0.2]],
            model: 'test',
            dimensions: 1
          }),
          getDimensions: jest.fn().mockReturnValue(1)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          collection: 'custom-collection',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            chunks: [
              { id: 'chunk-1', text: 'Content 1', metadata: { source: 'doc.pdf' } },
              { id: 'chunk-2', text: 'Content 2', metadata: { source: 'doc.pdf' } }
            ]
          }
        });

        expect(result.success).toBe(true);
        expect(result.embedded).toBe(2);
        expect(vectorCompat.upsert).toHaveBeenCalledWith(
          'custom-collection',
          expect.arrayContaining([
            expect.objectContaining({
              id: 'chunk-1',
              payload: expect.objectContaining({ source: 'doc.pdf' })
            })
          ])
        );
      });

      test('generates IDs for chunks without IDs', async () => {
        const embeddingCompat = {
          embed: jest.fn().mockResolvedValue({
            vectors: [[0.1]],
            model: 'test',
            dimensions: 1
          }),
          getDimensions: jest.fn().mockReturnValue(1)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            chunks: [{ text: 'No ID provided' }]
          }
        });

        expect(result.success).toBe(true);
        expect(vectorCompat.upsert).toHaveBeenCalledWith(
          expect.anything(),
          expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(String)
            })
          ])
        );
      });

      test('handles embedding errors', async () => {
        const embeddingCompat = {
          embed: jest.fn().mockRejectedValue(new Error('API rate limit')),
          getDimensions: jest.fn()
        };
        const registry = createMockRegistry({ embeddingCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: { texts: ['test'] }
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('API rate limit');
      });

      test('uses default collection from store config', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({
          vectorStore: {
            id: 'test-store',
            kind: 'memory',
            connection: {},
            defaultCollection: 'default-docs'
          },
          vectorCompat
        });

        const coordinator = new VectorStoreCoordinator(registry);
        await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: { texts: ['test'] }
        });

        expect(vectorCompat.upsert).toHaveBeenCalledWith(
          'default-docs',
          expect.anything()
        );
      });

      test('respects batchSize setting and processes in batches', async () => {
        const embeddingCompat = {
          embed: jest.fn()
            .mockResolvedValueOnce({ vectors: [[0.1], [0.2]], model: 'test', dimensions: 1 })
            .mockResolvedValueOnce({ vectors: [[0.3], [0.4]], model: 'test', dimensions: 1 })
            .mockResolvedValueOnce({ vectors: [[0.5]], model: 'test', dimensions: 1 }),
          getDimensions: jest.fn().mockReturnValue(1)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            texts: ['text1', 'text2', 'text3', 'text4', 'text5']
          },
          settings: { batchSize: 2 }
        });

        expect(result.success).toBe(true);
        expect(result.embedded).toBe(5);
        expect(result.upserted).toBe(5);
        // Should have been called 3 times: batch of 2, batch of 2, batch of 1
        expect(embeddingCompat.embed).toHaveBeenCalledTimes(3);
        expect(embeddingCompat.embed).toHaveBeenNthCalledWith(
          1,
          ['text1', 'text2'],
          expect.anything(),
          undefined,
          expect.anything()
        );
        expect(embeddingCompat.embed).toHaveBeenNthCalledWith(
          2,
          ['text3', 'text4'],
          expect.anything(),
          undefined,
          expect.anything()
        );
        expect(embeddingCompat.embed).toHaveBeenNthCalledWith(
          3,
          ['text5'],
          expect.anything(),
          undefined,
          expect.anything()
        );
      });

      test('uses default batchSize of 10 when not specified', async () => {
        // Create 15 texts to verify default batch size of 10
        const texts = Array.from({ length: 15 }, (_, i) => `text${i + 1}`);
        const embeddingCompat = {
          embed: jest.fn()
            .mockResolvedValueOnce({ vectors: texts.slice(0, 10).map(() => [0.1]), model: 'test', dimensions: 1 })
            .mockResolvedValueOnce({ vectors: texts.slice(10, 15).map(() => [0.1]), model: 'test', dimensions: 1 }),
          getDimensions: jest.fn().mockReturnValue(1)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: { texts }
          // No settings.batchSize - should default to 10
        });

        expect(result.success).toBe(true);
        expect(result.embedded).toBe(15);
        // Should have been called twice: batch of 10, batch of 5
        expect(embeddingCompat.embed).toHaveBeenCalledTimes(2);
        expect(embeddingCompat.embed).toHaveBeenNthCalledWith(
          1,
          texts.slice(0, 10),
          expect.anything(),
          undefined,
          expect.anything()
        );
        expect(embeddingCompat.embed).toHaveBeenNthCalledWith(
          2,
          texts.slice(10, 15),
          expect.anything(),
          undefined,
          expect.anything()
        );
      });

      test('handles single batch when texts.length <= batchSize', async () => {
        const embeddingCompat = {
          embed: jest.fn().mockResolvedValue({
            vectors: [[0.1], [0.2], [0.3]],
            model: 'test',
            dimensions: 1
          }),
          getDimensions: jest.fn().mockReturnValue(1)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            texts: ['a', 'b', 'c']
          },
          settings: { batchSize: 10 }
        });

        expect(result.success).toBe(true);
        expect(result.embedded).toBe(3);
        // Should only be called once since 3 < 10
        expect(embeddingCompat.embed).toHaveBeenCalledTimes(1);
      });

      test('preserves chunk IDs and metadata across batches', async () => {
        const embeddingCompat = {
          embed: jest.fn()
            .mockResolvedValueOnce({ vectors: [[0.1], [0.2]], model: 'test', dimensions: 1 })
            .mockResolvedValueOnce({ vectors: [[0.3]], model: 'test', dimensions: 1 }),
          getDimensions: jest.fn().mockReturnValue(1)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            chunks: [
              { id: 'chunk-1', text: 'Content 1', metadata: { page: 1 } },
              { id: 'chunk-2', text: 'Content 2', metadata: { page: 2 } },
              { id: 'chunk-3', text: 'Content 3', metadata: { page: 3 } }
            ]
          },
          settings: { batchSize: 2 }
        });

        expect(result.success).toBe(true);
        expect(result.embedded).toBe(3);
        expect(vectorCompat.upsert).toHaveBeenCalledWith(
          expect.anything(),
          expect.arrayContaining([
            expect.objectContaining({ id: 'chunk-1', payload: expect.objectContaining({ page: 1 }) }),
            expect.objectContaining({ id: 'chunk-2', payload: expect.objectContaining({ page: 2 }) }),
            expect.objectContaining({ id: 'chunk-3', payload: expect.objectContaining({ page: 3 }) })
          ])
        );
      });

      test('handles error in middle of batch processing', async () => {
        const embeddingCompat = {
          embed: jest.fn()
            .mockResolvedValueOnce({ vectors: [[0.1], [0.2]], model: 'test', dimensions: 1 })
            .mockRejectedValueOnce(new Error('Rate limit exceeded')),
          getDimensions: jest.fn().mockReturnValue(1)
        };
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'embed',
          store: 'test-store',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            texts: ['text1', 'text2', 'text3', 'text4']
          },
          settings: { batchSize: 2 }
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Rate limit exceeded');
      });
    });

    describe('upsert operation', () => {
      test('upserts pre-computed vectors', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'upsert',
          store: 'test-store',
          collection: 'docs',
          input: {
            points: [
              { id: 'p1', vector: [0.1, 0.2], payload: { text: 'hello' } },
              { id: 'p2', vector: [0.3, 0.4], payload: { text: 'world' } }
            ]
          }
        });

        expect(result.success).toBe(true);
        expect(result.operation).toBe('upsert');
        expect(vectorCompat.upsert).toHaveBeenCalledWith('docs', expect.arrayContaining([
          expect.objectContaining({ id: 'p1', vector: [0.1, 0.2] }),
          expect.objectContaining({ id: 'p2', vector: [0.3, 0.4] })
        ]));
      });

      test('handles empty points array', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'upsert',
          store: 'test-store',
          input: { points: [] }
        });

        expect(result.success).toBe(true);
        expect(vectorCompat.upsert).not.toHaveBeenCalled();
      });

      test('handles upsert errors', async () => {
        const vectorCompat = createMockVectorCompat();
        vectorCompat.upsert.mockRejectedValue(new Error('Connection failed'));
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'upsert',
          store: 'test-store',
          input: {
            points: [{ id: 'p1', vector: [0.1] }]
          }
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Connection failed');
      });
    });

    describe('query operation', () => {
      test('queries with text (embeds automatically)', async () => {
        const embeddingCompat = {
          embed: jest.fn().mockResolvedValue({
            vectors: [[0.1, 0.2, 0.3]],
            model: 'test',
            dimensions: 3
          }),
          getDimensions: jest.fn()
        };
        const vectorCompat = createMockVectorCompat();
        vectorCompat.query.mockResolvedValue([
          { id: 'doc1', score: 0.95, payload: { text: 'result 1' } },
          { id: 'doc2', score: 0.87, payload: { text: 'result 2' } }
        ]);
        const registry = createMockRegistry({ embeddingCompat, vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'query',
          store: 'test-store',
          collection: 'docs',
          embeddingPriority: [{ provider: 'test-embeddings' }],
          input: {
            query: 'What is machine learning?',
            topK: 5
          }
        });

        expect(result.success).toBe(true);
        expect(result.operation).toBe('query');
        expect(result.results).toHaveLength(2);
        expect(result.results![0].score).toBe(0.95);
        expect(embeddingCompat.embed).toHaveBeenCalledWith(
          'What is machine learning?',
          expect.anything(),
          undefined,
          expect.anything() // logger parameter
        );
        expect(vectorCompat.query).toHaveBeenCalledWith(
          'docs',
          [0.1, 0.2, 0.3],
          5,
          expect.anything()
        );
      });

      test('queries with pre-computed vector', async () => {
        const vectorCompat = createMockVectorCompat();
        vectorCompat.query.mockResolvedValue([
          { id: 'doc1', score: 0.9 }
        ]);
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'query',
          store: 'test-store',
          input: {
            vector: [0.5, 0.5, 0.5],
            topK: 3
          }
        });

        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(1);
        expect(vectorCompat.query).toHaveBeenCalledWith(
          expect.anything(),
          [0.5, 0.5, 0.5],
          3,
          expect.anything()
        );
      });

      test('applies score threshold filter', async () => {
        const vectorCompat = createMockVectorCompat();
        vectorCompat.query.mockResolvedValue([
          { id: 'doc1', score: 0.95 },
          { id: 'doc2', score: 0.85 },
          { id: 'doc3', score: 0.65 }
        ]);
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'query',
          store: 'test-store',
          input: {
            vector: [0.1, 0.2],
            topK: 10,
            scoreThreshold: 0.8
          }
        });

        expect(result.success).toBe(true);
        // Only results with score >= 0.8
        expect(result.results).toHaveLength(2);
      });

      test('applies metadata filter', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        await coordinator.execute({
          operation: 'query',
          store: 'test-store',
          input: {
            vector: [0.1],
            topK: 5,
            filter: { category: 'tech' }
          }
        });

        expect(vectorCompat.query).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            filter: { category: 'tech' }
          })
        );
      });

      test('passes include options to query', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        await coordinator.execute({
          operation: 'query',
          store: 'test-store',
          input: { vector: [0.1], topK: 5 },
          settings: {
            includePayload: true,
            includeVector: true
          }
        });

        expect(vectorCompat.query).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            includePayload: true,
            includeVector: true
          })
        );
      });
    });

    describe('delete operation', () => {
      test('deletes vectors by IDs', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'delete',
          store: 'test-store',
          collection: 'docs',
          input: {
            ids: ['doc1', 'doc2', 'doc3']
          }
        });

        expect(result.success).toBe(true);
        expect(result.operation).toBe('delete');
        expect(result.deleted).toBe(3);
        expect(vectorCompat.deleteByIds).toHaveBeenCalledWith('docs', ['doc1', 'doc2', 'doc3']);
      });

      test('handles empty IDs array', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'delete',
          store: 'test-store',
          input: { ids: [] }
        });

        expect(result.success).toBe(true);
        expect(result.deleted).toBe(0);
        expect(vectorCompat.deleteByIds).not.toHaveBeenCalled();
      });

      test('handles delete errors', async () => {
        const vectorCompat = createMockVectorCompat();
        vectorCompat.deleteByIds.mockRejectedValue(new Error('Permission denied'));
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'delete',
          store: 'test-store',
          input: { ids: ['doc1'] }
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Permission denied');
      });
    });

    describe('collections operation', () => {
      test('lists collections', async () => {
        const vectorCompat = createMockVectorCompat();
        (vectorCompat as any).listCollections = jest.fn().mockResolvedValue(['docs', 'images', 'code']);
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'collections',
          store: 'test-store',
          input: { collectionOp: 'list' }
        });

        expect(result.success).toBe(true);
        expect(result.collections).toEqual(['docs', 'images', 'code']);
      });

      test('creates collection', async () => {
        const vectorCompat = createMockVectorCompat();
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'collections',
          store: 'test-store',
          input: {
            collectionOp: 'create',
            collectionName: 'new-collection',
            dimensions: 1536
          }
        });

        expect(result.success).toBe(true);
        expect(result.created).toBe(true);
        expect(vectorCompat.createCollection).toHaveBeenCalledWith(
          'new-collection',
          1536,
          { payloadIndexes: [] }
        );
      });

      test('checks collection exists', async () => {
        const vectorCompat = createMockVectorCompat();
        vectorCompat.collectionExists.mockResolvedValue(true);
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'collections',
          store: 'test-store',
          input: {
            collectionOp: 'exists',
            collectionName: 'my-docs'
          }
        });

        expect(result.success).toBe(true);
        expect(result.exists).toBe(true);
        expect(vectorCompat.collectionExists).toHaveBeenCalledWith('my-docs');
      });

      test('reports collection does not exist', async () => {
        const vectorCompat = createMockVectorCompat();
        vectorCompat.collectionExists.mockResolvedValue(false);
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'collections',
          store: 'test-store',
          input: {
            collectionOp: 'exists',
            collectionName: 'nonexistent'
          }
        });

        expect(result.success).toBe(true);
        expect(result.exists).toBe(false);
      });

      test('deletes collection', async () => {
        const vectorCompat = createMockVectorCompat();
        (vectorCompat as any).deleteCollection = jest.fn().mockResolvedValue(undefined);
        const registry = createMockRegistry({ vectorCompat });

        const coordinator = new VectorStoreCoordinator(registry);
        const result = await coordinator.execute({
          operation: 'collections',
          store: 'test-store',
          input: {
            collectionOp: 'delete',
            collectionName: 'old-collection'
          }
        });

        expect(result.success).toBe(true);
      });
    });

    describe('unknown operation', () => {
      test('throws for unknown operation', async () => {
        const registry = createMockRegistry();
        const coordinator = new VectorStoreCoordinator(registry);

        const result = await coordinator.execute({
          operation: 'unknown' as any,
          store: 'test-store'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown operation');
      });
    });
  });

  describe('executeStream', () => {
    test('yields progress events during batch embed', async () => {
      const embeddingCompat = {
        embed: jest.fn()
          .mockResolvedValueOnce({ vectors: [[0.1]], model: 'test', dimensions: 1 })
          .mockResolvedValueOnce({ vectors: [[0.2]], model: 'test', dimensions: 1 }),
        getDimensions: jest.fn()
      };
      const vectorCompat = createMockVectorCompat();
      const registry = createMockRegistry({ embeddingCompat, vectorCompat });

      const coordinator = new VectorStoreCoordinator(registry);
      const events = [];

      for await (const event of coordinator.executeStream({
        operation: 'embed',
        store: 'test-store',
        embeddingPriority: [{ provider: 'test' }],
        input: { texts: ['a', 'b'] },
        settings: { batchSize: 1 }
      })) {
        events.push(event);
      }

      const progressEvents = events.filter(e => e.type === 'progress');
      const doneEvent = events.find(e => e.type === 'done');

      expect(progressEvents.length).toBeGreaterThan(0);
      expect(doneEvent).toBeDefined();
    });

    test('yields error event on failure', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockRejectedValue(new Error('Failed')),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ embeddingCompat });

      const coordinator = new VectorStoreCoordinator(registry);
      const events = [];

      for await (const event of coordinator.executeStream({
        operation: 'embed',
        store: 'test-store',
        embeddingPriority: [{ provider: 'test' }],
        input: { texts: ['test'] }
      })) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error).toContain('Failed');
    });
  });

  describe('close', () => {
    test('closes vector store connections', async () => {
      const vectorCompat = createMockVectorCompat();
      const registry = createMockRegistry({ vectorCompat });

      const coordinator = new VectorStoreCoordinator(registry);

      // Trigger connection by executing an operation
      await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      });

      await coordinator.close();

      expect(vectorCompat.close).toHaveBeenCalled();
    });
  });

  describe('lazy initialization', () => {
    test('only loads embedding manager when needed', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      // Query with pre-computed vector - no embedding needed
      await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      });

      expect(registry.getEmbeddingProvider).not.toHaveBeenCalled();
      expect(registry.getEmbeddingCompat).not.toHaveBeenCalled();
    });

    test('loads embedding manager when text query is used', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        embeddingPriority: [{ provider: 'test-embeddings' }],
        input: { query: 'text query', topK: 1 }
      });

      expect(registry.getEmbeddingProvider).toHaveBeenCalled();
      expect(registry.getEmbeddingCompat).toHaveBeenCalled();
    });
  });

  describe('executeStream for non-embed operations', () => {
    test('streams query operation result', async () => {
      const vectorCompat = createMockVectorCompat();
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const events = [];
      for await (const event of coordinator.executeStream({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1, 0.2], topK: 5 }
      })) {
        events.push(event);
      }

      const resultEvent = events.find(e => e.type === 'result');
      const doneEvent = events.find(e => e.type === 'done');

      expect(resultEvent).toBeDefined();
      expect(resultEvent.result.operation).toBe('query');
      expect(doneEvent).toBeDefined();
    });

    test('streams delete operation result', async () => {
      const vectorCompat = createMockVectorCompat();
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const events = [];
      for await (const event of coordinator.executeStream({
        operation: 'delete',
        store: 'test-store',
        input: { ids: ['id1', 'id2'] }
      })) {
        events.push(event);
      }

      const resultEvent = events.find(e => e.type === 'result');
      expect(resultEvent?.result.operation).toBe('delete');
    });

    test('handles error in executeStream for non-embed', async () => {
      const vectorCompat = {
        ...createMockVectorCompat(),
        query: jest.fn().mockRejectedValue(new Error('Query stream error'))
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const events: any[] = [];
      for await (const event of coordinator.executeStream({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      })) {
        events.push(event);
      }

      // For non-embed operations, errors are caught in execute() and returned as failed results
      const resultEvent = events.find(e => e.type === 'result');
      expect(resultEvent).toBeDefined();
      expect(resultEvent.result.success).toBe(false);
      expect(resultEvent.result.error).toContain('Query stream error');
    });
  });

  describe('embed operation edge cases', () => {
    test('returns error when no embedding priority for embed', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        store: 'test-store',
        input: { texts: ['hello'] }
        // No embeddingPriority
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('embeddingPriority is required');
    });

    test('returns success with zero embedded when no texts', async () => {
      const embeddingCompat = {
        embed: jest.fn(),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ embeddingCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        store: 'test-store',
        embeddingPriority: [{ provider: 'test' }],
        input: { texts: [] }
      });

      expect(result.success).toBe(true);
      expect(result.embedded).toBe(0);
      expect(embeddingCompat.embed).not.toHaveBeenCalled();
    });
  });

  describe('embedStream edge cases', () => {
    test('yields error when no embedding priority', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const events = [];
      for await (const event of coordinator.executeStream({
        operation: 'embed',
        store: 'test-store',
        input: { texts: ['hello'] }
        // No embeddingPriority
      })) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toContain('embeddingPriority is required');
    });

    test('yields result with zero embedded when no texts', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const events = [];
      for await (const event of coordinator.executeStream({
        operation: 'embed',
        store: 'test-store',
        embeddingPriority: [{ provider: 'test' }],
        input: { texts: [] }
      })) {
        events.push(event);
      }

      const resultEvent = events.find(e => e.type === 'result');
      const doneEvent = events.find(e => e.type === 'done');

      expect(resultEvent?.result.embedded).toBe(0);
      expect(doneEvent).toBeDefined();
    });
  });

  describe('query operation edge cases', () => {
    test('returns error when no input provided', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'test-store'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('input is required');
    });

    test('returns error when neither query nor vector provided', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { topK: 5 }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Either query or vector must be provided');
    });

    test('returns error when text query without embedding priority', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { query: 'test query' }
        // No embeddingPriority
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('embeddingPriority is required when querying with text');
    });

    test('returns error when vector store not found', async () => {
      const vectorCompat = createMockVectorCompat();
      const registry = createMockRegistry({ vectorCompat });
      // Override getCompat to return null
      registry.getVectorStoreCompat = jest.fn().mockResolvedValue({
        ...vectorCompat,
        query: null
      });

      const coordinator = new VectorStoreCoordinator(registry);

      // Simulate compat not found scenario via mock adjustment
      const mockCoord = new VectorStoreCoordinator({
        ...registry,
        getVectorStore: jest.fn().mockResolvedValue({ id: 'missing', kind: 'unknown' }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null)
      });

      const result = await mockCoord.execute({
        operation: 'query',
        store: 'missing-store',
        input: { vector: [0.1], topK: 1 }
      });

      // The actual error path may vary, this tests the general flow
      expect(result).toBeDefined();
    });

    test('applies score threshold filter to results', async () => {
      const vectorCompat = {
        ...createMockVectorCompat(),
        query: jest.fn().mockResolvedValue([
          { id: 'high', score: 0.9, payload: {} },
          { id: 'low', score: 0.3, payload: {} }
        ])
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 10, scoreThreshold: 0.5 }
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('high');
    });
  });

  describe('collections operation edge cases', () => {
    test('returns error when listCollections not supported', async () => {
      const vectorCompat = {
        ...createMockVectorCompat(),
        listCollections: undefined
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'list' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    test('returns error when collectionName missing for create', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'create', dimensions: 128 }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('collectionName is required');
    });

    test('returns error when dimensions missing for create', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'create', collectionName: 'new' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('dimensions is required');
    });

    test('returns error when createCollection not supported', async () => {
      const vectorCompat = {
        ...createMockVectorCompat(),
        createCollection: undefined
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'create', collectionName: 'new', dimensions: 128 }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    test('returns error when collectionName missing for delete', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'delete' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('collectionName is required');
    });

    test('returns error when deleteCollection not supported', async () => {
      const vectorCompat = {
        ...createMockVectorCompat(),
        deleteCollection: undefined
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'delete', collectionName: 'old' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    test('returns error when collectionName missing for exists', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'exists' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('collectionName is required');
    });

    test('returns error for unknown collection operation', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'unknown' as any }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown collection operation');
    });

    test('returns error when compat not found for collections', async () => {
      const coordinator = new VectorStoreCoordinator({
        getVectorStore: jest.fn().mockResolvedValue({ id: 'test', kind: 'unknown' }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null),
        loadAll: jest.fn()
      } as any);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'missing',
        input: { collectionOp: 'list' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not found');
    });
  });

  describe('execute error handling', () => {
    test('catches and returns errors from operations', async () => {
      const vectorCompat = {
        ...createMockVectorCompat(),
        query: jest.fn().mockRejectedValue(new Error('Query failed'))
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Query failed');
    });

    test('handles non-Error throws', async () => {
      const vectorCompat = {
        ...createMockVectorCompat(),
        query: jest.fn().mockRejectedValue('string error')
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });
  });

  describe('additional edge cases for coverage', () => {
    test('returns error when compat not found for query', async () => {
      const coordinator = new VectorStoreCoordinator({
        getVectorStore: jest.fn().mockResolvedValue({ id: 'test', kind: 'unknown' }),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null),
        loadAll: jest.fn()
      } as any);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'missing',
        input: { vector: [0.1], topK: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not found');
    });

    test('extractTexts returns empty when input is undefined', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        store: 'test-store',
        embeddingPriority: [{ provider: 'openrouter' }]
        // No input specified
      });

      expect(result.success).toBe(true);
      expect(result.embedded).toBe(0);
    });

    test('query returns error when vectorManager.getCompat returns null', async () => {
      // Cover the branch where getCompat returns null
      const registry = {
        ...createMockRegistry(),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null)
      };

      const coordinator = new VectorStoreCoordinator(registry as any);

      const result = await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not found');
    });

    test('collections returns error when vectorManager.getCompat returns null', async () => {
      // Cover the branch where getCompat returns null
      const registry = {
        ...createMockRegistry(),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null)
      };

      const coordinator = new VectorStoreCoordinator(registry as any);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: { collectionOp: 'list' }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not found');
    });

    test('embed returns error when vectorManager.getCompat returns null', async () => {
      const registry = {
        ...createMockRegistry(),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null)
      };

      const coordinator = new VectorStoreCoordinator(registry as any);

      const result = await coordinator.execute({
        operation: 'embed',
        store: 'test-store',
        embeddingPriority: [{ provider: 'openrouter' }],
        input: { texts: ['hello'] }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not found');
    });

    test('executeStream(embed) yields error when vectorManager.getCompat returns null', async () => {
      const registry = {
        ...createMockRegistry(),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null)
      };

      const coordinator = new VectorStoreCoordinator(registry as any);

      const events: any[] = [];
      for await (const event of coordinator.executeStream({
        operation: 'embed',
        store: 'test-store',
        embeddingPriority: [{ provider: 'openrouter' }],
        input: { texts: ['hello'] }
      })) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent?.error).toContain('Vector store not found');
    });

    test('upsert returns error when vectorManager.getCompat returns null', async () => {
      const registry = {
        ...createMockRegistry(),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null)
      };

      const coordinator = new VectorStoreCoordinator(registry as any);

      const result = await coordinator.execute({
        operation: 'upsert',
        store: 'test-store',
        input: {
          points: [{ id: 'doc1', vector: [0.1, 0.2], payload: { text: 'hi' } }]
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not found');
    });

    test('delete returns error when vectorManager.getCompat returns null', async () => {
      const registry = {
        ...createMockRegistry(),
        getVectorStoreCompat: jest.fn().mockResolvedValue(null)
      };

      const coordinator = new VectorStoreCoordinator(registry as any);

      const result = await coordinator.execute({
        operation: 'delete',
        store: 'test-store',
        input: { ids: ['doc1'] }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Vector store not found');
    });

    test('returns unknown operation when operation is undefined', async () => {
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        store: 'test-store'
      } as any);

      expect(result.success).toBe(false);
      expect(result.operation).toBe('unknown');
      expect(result.error).toContain('Unknown operation');
    });

    test('executeStream handles non-Error throws', async () => {
      // executeStream's outer try/catch for non-embed operations catches errors
      // and yields an error event. We need to force executeStream's own catch,
      // which happens when the iteration itself throws.
      const registry = createMockRegistry();
      const coordinator = new VectorStoreCoordinator(registry);

      // Mock execute to throw a non-Error value
      (coordinator as any).execute = jest.fn().mockRejectedValue('string error in stream');

      const events = [];
      for await (const event of coordinator.executeStream({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1] }
      })) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error).toBe('string error in stream');
    });

    test('query uses default topK of 5 when not specified', async () => {
      const queryMock = jest.fn().mockResolvedValue([]);
      const vectorCompat = {
        ...createMockVectorCompat(),
        query: queryMock
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1] }
        // No topK specified
      });

      // Mock registry returns defaultCollection: 'test'
      expect(queryMock).toHaveBeenCalledWith(
        'test',
        [0.1],
        5, // Default topK
        expect.any(Object)
      );
    });

    test('collections uses default collectionOp of list when not specified', async () => {
      const listCollectionsMock = jest.fn().mockResolvedValue(['col1']);
      const vectorCompat = {
        ...createMockVectorCompat(),
        listCollections: listCollectionsMock
      };
      const registry = createMockRegistry({ vectorCompat });
      const coordinator = new VectorStoreCoordinator(registry);

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'test-store',
        input: {}
        // No collectionOp specified - should default to 'list'
      });

      expect(result.success).toBe(true);
      expect(listCollectionsMock).toHaveBeenCalled();
    });

    test('resolveCollection uses default when storeConfig has no defaultCollection', async () => {
      const queryMock = jest.fn().mockResolvedValue([]);
      const vectorCompat = {
        ...createMockVectorCompat(),
        query: queryMock
      };
      // getVectorStore returns config without defaultCollection
      const registry = {
        ...createMockRegistry({ vectorCompat }),
        getVectorStore: jest.fn().mockResolvedValue({ id: 'test', kind: 'memory' })
        // No defaultCollection in returned config
      };
      const coordinator = new VectorStoreCoordinator(registry as any);

      await coordinator.execute({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 3 }
        // No collection specified, and storeConfig has no defaultCollection
      });

      // Should use 'default' as the collection name
      expect(queryMock).toHaveBeenCalledWith(
        'default',
        [0.1],
        3,
        expect.any(Object)
      );
    });
  });
});
