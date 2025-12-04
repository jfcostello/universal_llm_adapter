import { jest } from '@jest/globals';

// Type imports - these will be created in implementation
import type {
  VectorCallSpec,
  VectorOperationInput,
  VectorOperationSettings,
  VectorOperationResult,
  VectorStreamEvent,
  TextChunk
} from '@/core/vector-spec-types.ts';

describe('core/vector-spec-types', () => {
  describe('VectorCallSpec', () => {
    test('accepts valid embed operation spec', () => {
      const spec: VectorCallSpec = {
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: 'documents',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          texts: ['Hello world', 'Test text']
        },
        settings: {
          batchSize: 100
        }
      };

      expect(spec.operation).toBe('embed');
      expect(spec.store).toBe('qdrant-cloud');
      expect(spec.input?.texts).toHaveLength(2);
    });

    test('accepts valid upsert operation spec', () => {
      const spec: VectorCallSpec = {
        operation: 'upsert',
        store: 'qdrant-cloud',
        input: {
          points: [
            { id: 'doc1', vector: [0.1, 0.2, 0.3], payload: { text: 'hello' } }
          ]
        }
      };

      expect(spec.operation).toBe('upsert');
      expect(spec.input?.points).toHaveLength(1);
    });

    test('accepts valid query operation spec', () => {
      const spec: VectorCallSpec = {
        operation: 'query',
        store: 'qdrant-cloud',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'What is machine learning?',
          topK: 5,
          scoreThreshold: 0.7,
          filter: { category: 'tech' }
        },
        settings: {
          includePayload: true,
          includeVector: false
        }
      };

      expect(spec.operation).toBe('query');
      expect(spec.input?.query).toBe('What is machine learning?');
      expect(spec.input?.topK).toBe(5);
    });

    test('accepts valid delete operation spec', () => {
      const spec: VectorCallSpec = {
        operation: 'delete',
        store: 'qdrant-cloud',
        collection: 'documents',
        input: {
          ids: ['doc1', 'doc2', 'doc3']
        }
      };

      expect(spec.operation).toBe('delete');
      expect(spec.input?.ids).toHaveLength(3);
    });

    test('accepts valid collections operation spec', () => {
      const spec: VectorCallSpec = {
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'create',
          collectionName: 'my-docs',
          dimensions: 1536
        }
      };

      expect(spec.operation).toBe('collections');
      expect(spec.input?.collectionOp).toBe('create');
      expect(spec.input?.dimensions).toBe(1536);
    });

    test('accepts metadata for correlation', () => {
      const spec: VectorCallSpec = {
        operation: 'embed',
        store: 'qdrant-cloud',
        input: { texts: ['test'] },
        metadata: {
          correlationId: 'test-123',
          batchId: 'batch-456'
        }
      };

      expect(spec.metadata?.correlationId).toBe('test-123');
    });
  });

  describe('VectorOperationInput', () => {
    test('supports chunks with metadata', () => {
      const input: VectorOperationInput = {
        chunks: [
          { id: 'chunk-1', text: 'Content here', metadata: { source: 'doc.pdf', page: 1 } },
          { text: 'Auto-ID chunk' } // id is optional
        ]
      };

      expect(input.chunks).toHaveLength(2);
      expect(input.chunks![0].metadata?.source).toBe('doc.pdf');
    });

    test('supports file path for auto-chunking', () => {
      const input: VectorOperationInput = {
        file: '/path/to/document.txt'
      };

      expect(input.file).toBe('/path/to/document.txt');
    });

    test('supports pre-computed vectors for upsert', () => {
      const input: VectorOperationInput = {
        points: [
          { id: 'p1', vector: [0.1, 0.2], payload: { text: 'hello' } },
          { id: 'p2', vector: [0.3, 0.4] }
        ]
      };

      expect(input.points).toHaveLength(2);
      expect(input.points![0].vector).toEqual([0.1, 0.2]);
    });

    test('supports pre-computed vector for query', () => {
      const input: VectorOperationInput = {
        vector: [0.1, 0.2, 0.3],
        topK: 10
      };

      expect(input.vector).toHaveLength(3);
      expect(input.topK).toBe(10);
    });

    test('supports all collection operations', () => {
      const listOp: VectorOperationInput = { collectionOp: 'list' };
      const createOp: VectorOperationInput = {
        collectionOp: 'create',
        collectionName: 'new-collection',
        dimensions: 768
      };
      const deleteOp: VectorOperationInput = {
        collectionOp: 'delete',
        collectionName: 'old-collection'
      };
      const existsOp: VectorOperationInput = {
        collectionOp: 'exists',
        collectionName: 'check-collection'
      };

      expect(listOp.collectionOp).toBe('list');
      expect(createOp.collectionOp).toBe('create');
      expect(deleteOp.collectionOp).toBe('delete');
      expect(existsOp.collectionOp).toBe('exists');
    });
  });

  describe('VectorOperationSettings', () => {
    test('supports chunking configuration', () => {
      const settings: VectorOperationSettings = {
        chunkSize: 500,
        chunkOverlap: 50
      };

      expect(settings.chunkSize).toBe(500);
      expect(settings.chunkOverlap).toBe(50);
    });

    test('supports query result configuration', () => {
      const settings: VectorOperationSettings = {
        includePayload: true,
        includeVector: false
      };

      expect(settings.includePayload).toBe(true);
      expect(settings.includeVector).toBe(false);
    });

    test('supports batch size configuration', () => {
      const settings: VectorOperationSettings = {
        batchSize: 50
      };

      expect(settings.batchSize).toBe(50);
    });
  });

  describe('VectorOperationResult', () => {
    test('represents successful embed result', () => {
      const result: VectorOperationResult = {
        operation: 'embed',
        success: true,
        embedded: 10,
        upserted: 10,
        dimensions: 1536
      };

      expect(result.success).toBe(true);
      expect(result.embedded).toBe(10);
    });

    test('represents successful query result', () => {
      const result: VectorOperationResult = {
        operation: 'query',
        success: true,
        results: [
          { id: 'doc1', score: 0.95, payload: { text: 'hello' } },
          { id: 'doc2', score: 0.87, payload: { text: 'world' } }
        ]
      };

      expect(result.results).toHaveLength(2);
      expect(result.results![0].score).toBe(0.95);
    });

    test('represents successful delete result', () => {
      const result: VectorOperationResult = {
        operation: 'delete',
        success: true,
        deleted: 5
      };

      expect(result.deleted).toBe(5);
    });

    test('represents successful collections result', () => {
      const listResult: VectorOperationResult = {
        operation: 'collections',
        success: true,
        collections: ['docs', 'images', 'code']
      };

      const existsResult: VectorOperationResult = {
        operation: 'collections',
        success: true,
        exists: true
      };

      const createResult: VectorOperationResult = {
        operation: 'collections',
        success: true,
        created: true
      };

      expect(listResult.collections).toHaveLength(3);
      expect(existsResult.exists).toBe(true);
      expect(createResult.created).toBe(true);
    });

    test('represents error result', () => {
      const result: VectorOperationResult = {
        operation: 'upsert',
        success: false,
        error: 'Connection failed'
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection failed');
    });
  });

  describe('VectorStreamEvent', () => {
    test('represents progress event', () => {
      const event: VectorStreamEvent = {
        type: 'progress',
        progress: {
          current: 50,
          total: 100,
          message: 'Embedding batch 5 of 10'
        }
      };

      expect(event.type).toBe('progress');
      expect(event.progress?.current).toBe(50);
    });

    test('represents result event', () => {
      const event: VectorStreamEvent = {
        type: 'result',
        result: {
          operation: 'embed',
          success: true,
          embedded: 100
        }
      };

      expect(event.type).toBe('result');
      expect(event.result?.success).toBe(true);
    });

    test('represents error event', () => {
      const event: VectorStreamEvent = {
        type: 'error',
        error: 'Rate limit exceeded'
      };

      expect(event.type).toBe('error');
      expect(event.error).toBe('Rate limit exceeded');
    });

    test('represents done event', () => {
      const event: VectorStreamEvent = {
        type: 'done'
      };

      expect(event.type).toBe('done');
    });
  });

  describe('TextChunk', () => {
    test('requires text field', () => {
      const chunk: TextChunk = {
        text: 'This is the content'
      };

      expect(chunk.text).toBe('This is the content');
    });

    test('supports optional id', () => {
      const chunk: TextChunk = {
        id: 'custom-id',
        text: 'Content'
      };

      expect(chunk.id).toBe('custom-id');
    });

    test('supports optional metadata', () => {
      const chunk: TextChunk = {
        text: 'Content',
        metadata: {
          source: 'document.pdf',
          page: 5,
          section: 'Introduction'
        }
      };

      expect(chunk.metadata?.source).toBe('document.pdf');
      expect(chunk.metadata?.page).toBe(5);
    });
  });
});
