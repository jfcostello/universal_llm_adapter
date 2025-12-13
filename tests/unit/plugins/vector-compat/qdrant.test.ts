import { jest } from '@jest/globals';
import QdrantCompat from '@/plugins/vector-compat/qdrant.ts';
import { VectorStoreConnectionError, VectorStoreError } from '@/core/errors.ts';
import type { VectorStoreConfig } from '@/core/types.ts';

const ORIGINAL_ID_KEY = '__llm_adapter_original_id';
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createConfig(overrides: Partial<VectorStoreConfig['connection']> = {}): VectorStoreConfig {
  return {
    id: 'test-qdrant',
    kind: 'qdrant',
    connection: {
      host: 'localhost',
      port: 6333,
      ...overrides
    }
  };
}

function createMockClient() {
  return {
    getCollections: jest.fn().mockResolvedValue({ collections: [] }),
    search: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    createCollection: jest.fn(),
    createPayloadIndex: jest.fn(),
    deleteCollection: jest.fn()
  };
}

describe('plugins/vector-compat/qdrant', () => {
  let compat: QdrantCompat;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockClientFactory: jest.Mock;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClientFactory = jest.fn(() => mockClient);
    compat = new QdrantCompat(mockClientFactory);
  });

  describe('connect', () => {
    test('connects with local host:port config', async () => {
      await compat.connect(createConfig());

      expect(mockClientFactory).toHaveBeenCalledWith({
        host: 'localhost',
        port: 6333
      });
      expect(mockClient.getCollections).toHaveBeenCalled();
    });

    test('connects with cloud url:apiKey config', async () => {
      await compat.connect(createConfig({
        host: undefined,
        port: undefined,
        url: 'https://cloud.qdrant.io',
        apiKey: 'secret-key'
      }));

      expect(mockClientFactory).toHaveBeenCalledWith({
        url: 'https://cloud.qdrant.io',
        apiKey: 'secret-key'
      });
    });

    test('uses default port 6333 when not specified', async () => {
      await compat.connect(createConfig({ host: 'myhost', port: undefined }));

      expect(mockClientFactory).toHaveBeenCalledWith({
        host: 'myhost',
        port: 6333
      });
    });

    test('throws VectorStoreConnectionError on invalid config', async () => {
      await expect(compat.connect({
        id: 'bad',
        kind: 'qdrant',
        connection: {}
      })).rejects.toThrow(VectorStoreConnectionError);
    });

    test('throws VectorStoreConnectionError on connection failure', async () => {
      mockClient.getCollections.mockRejectedValue(new Error('Connection refused'));

      await expect(compat.connect(createConfig())).rejects.toThrow(VectorStoreConnectionError);
    });
  });

  describe('close', () => {
    test('clears client reference', async () => {
      await compat.connect(createConfig());
      await compat.close();

      // Should throw because client is null
      await expect(compat.query('test', [1], 1)).rejects.toThrow('Not connected');
    });
  });

	  describe('query', () => {
	    beforeEach(async () => {
	      await compat.connect(createConfig());
	    });

	    test('searches with basic parameters', async () => {
      mockClient.search.mockResolvedValue([
        { id: '1', score: 0.95, payload: { text: 'hello' } },
        { id: '2', score: 0.85, payload: { text: 'world' } }
      ]);

      const results = await compat.query('my-collection', [0.1, 0.2], 5);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: '1',
        score: 0.95,
        payload: { text: 'hello' },
        vector: undefined
      });
	      expect(mockClient.search).toHaveBeenCalledWith('my-collection', {
	        vector: [0.1, 0.2],
	        limit: 5,
	        with_payload: true,
	        with_vector: false
	      });
	    });

	    test('maps stored original id from payload onto result.id', async () => {
	      mockClient.search.mockResolvedValue([
	        {
	          id: '550e8400-e29b-41d4-a716-446655440000',
	          score: 0.9,
	          payload: { [ORIGINAL_ID_KEY]: 'fact-1', text: 'hello', topic: 'technology' }
	        }
	      ]);

	      const results = await compat.query('test', [1], 1);

	      expect(results[0].id).toBe('fact-1');
	      expect(results[0].payload).toEqual({ text: 'hello', topic: 'technology' });
	    });

	    test('includes vector when requested', async () => {
	      mockClient.search.mockResolvedValue([
	        { id: '1', score: 0.9, vector: [0.1, 0.2] }
	      ]);

      const results = await compat.query('test', [1], 1, { includeVector: true });

      expect(results[0].vector).toEqual([0.1, 0.2]);
      expect(mockClient.search).toHaveBeenCalledWith('test', expect.objectContaining({
        with_vector: true
      }));
    });

    test('excludes payload when requested', async () => {
      mockClient.search.mockResolvedValue([
        { id: '1', score: 0.9 }
      ]);

      await compat.query('test', [1], 1, { includePayload: false });

      expect(mockClient.search).toHaveBeenCalledWith('test', expect.objectContaining({
        with_payload: false
      }));
    });

    test('converts simple filter to Qdrant format', async () => {
      mockClient.search.mockResolvedValue([]);

      await compat.query('test', [1], 1, { filter: { category: 'tech' } });

      expect(mockClient.search).toHaveBeenCalledWith('test', expect.objectContaining({
        filter: {
          must: [{ key: 'category', match: { value: 'tech' } }]
        }
      }));
    });

    test('converts dot-notation filter to nested Qdrant format', async () => {
      mockClient.search.mockResolvedValue([]);

      await compat.query('test', [1], 1, { filter: { 'metadata.category': 'tech' } as any });

      expect(mockClient.search).toHaveBeenCalledWith('test', expect.objectContaining({
        filter: {
          must: [
            {
              nested: {
                path: 'metadata',
                filter: {
                  must: [{ key: 'metadata.category', match: { value: 'tech' } }]
                }
              }
            }
          ]
        }
      }));
    });

    test('passes through Qdrant-native filter format', async () => {
      mockClient.search.mockResolvedValue([]);
      const nativeFilter = {
        must: [{ key: 'status', match: { value: 'active' } }],
        should: [{ key: 'priority', match: { value: 'high' } }]
      };

      await compat.query('test', [1], 1, { filter: nativeFilter });

      expect(mockClient.search).toHaveBeenCalledWith('test', expect.objectContaining({
        filter: nativeFilter
      }));
    });

    test('skips null/undefined values in filter', async () => {
      mockClient.search.mockResolvedValue([]);

      await compat.query('test', [1], 1, { filter: { a: 'value', b: null, c: undefined } as any });

      expect(mockClient.search).toHaveBeenCalledWith('test', expect.objectContaining({
        filter: {
          must: [{ key: 'a', match: { value: 'value' } }]
        }
      }));
    });

    test('handles empty filter object', async () => {
      mockClient.search.mockResolvedValue([]);

      await compat.query('test', [1], 1, { filter: {} });

      // Empty filter should not add filter to search params
      expect(mockClient.search).toHaveBeenCalledWith('test', expect.not.objectContaining({
        filter: expect.anything()
      }));
    });

    test('throws VectorStoreError on search failure', async () => {
      mockClient.search.mockRejectedValue(new Error('Search failed'));

      await expect(compat.query('test', [1], 1)).rejects.toThrow(VectorStoreError);
    });

    test('throws when not connected', async () => {
      const disconnected = new QdrantCompat(mockClientFactory);

      await expect(disconnected.query('test', [1], 1)).rejects.toThrow('Not connected');
    });
  });

	  describe('upsert', () => {
	    beforeEach(async () => {
	      await compat.connect(createConfig());
	    });

	    test('upserts points with correct format', async () => {
	      mockClient.upsert.mockResolvedValue({});

	      await compat.upsert('my-collection', [
	        { id: 'p1', vector: [0.1, 0.2], payload: { text: 'hello' } },
	        { id: 'p2', vector: [0.3, 0.4] }
	      ]);

	      expect(mockClient.upsert).toHaveBeenCalledWith('my-collection', expect.objectContaining({ wait: true }));
	      const payload = mockClient.upsert.mock.calls[0][1] as any;
	      expect(payload.points).toHaveLength(2);

	      expect(payload.points[0].id).toMatch(UUID_V4_REGEX);
	      expect(payload.points[0].id).not.toBe('p1');
	      expect(payload.points[0].vector).toEqual([0.1, 0.2]);
	      expect(payload.points[0].payload).toEqual(
	        expect.objectContaining({ text: 'hello', [ORIGINAL_ID_KEY]: 'p1' })
	      );

	      expect(payload.points[1].id).toMatch(UUID_V4_REGEX);
	      expect(payload.points[1].id).not.toBe('p2');
	      expect(payload.points[1].vector).toEqual([0.3, 0.4]);
	      expect(payload.points[1].payload).toEqual(expect.objectContaining({ [ORIGINAL_ID_KEY]: 'p2' }));
	    });

	    test('passes through UUID ids without storing original id', async () => {
	      mockClient.upsert.mockResolvedValue({});
	      const uuid = '550e8400-e29b-41d4-a716-446655440000';

	      await compat.upsert('my-collection', [{ id: uuid, vector: [0.1], payload: { text: 'hello' } }]);

	      const payload = mockClient.upsert.mock.calls[0][1] as any;
	      expect(payload.points).toHaveLength(1);
	      expect(payload.points[0].id).toBe(uuid);
	      expect(payload.points[0].payload).toEqual({ text: 'hello' });
	    });

	    test('converts numeric string ids to numbers', async () => {
	      mockClient.upsert.mockResolvedValue({});

	      await compat.upsert('my-collection', [{ id: '123', vector: [0.1] }]);

	      const payload = mockClient.upsert.mock.calls[0][1] as any;
	      expect(payload.points).toHaveLength(1);
	      expect(payload.points[0].id).toBe(123);
	      expect(payload.points[0].payload).toEqual({});
	    });

	    test('throws VectorStoreError on upsert failure', async () => {
	      mockClient.upsert.mockRejectedValue(new Error('Upsert failed'));

	      await expect(compat.upsert('test', [{ id: '1', vector: [1] }])).rejects.toThrow(VectorStoreError);
    });

    test('throws when not connected', async () => {
      const disconnected = new QdrantCompat(mockClientFactory);

      await expect(disconnected.upsert('test', [])).rejects.toThrow('Not connected');
    });
  });

	  describe('deleteByIds', () => {
	    beforeEach(async () => {
	      await compat.connect(createConfig());
	    });

	    test('deletes points by ID', async () => {
	      mockClient.delete.mockResolvedValue({});

	      await compat.deleteByIds('my-collection', ['id1', 'id2']);

	      expect(mockClient.delete).toHaveBeenCalledWith('my-collection', expect.objectContaining({ wait: true }));
	      const payload = mockClient.delete.mock.calls[0][1] as any;
	      expect(payload.points).toHaveLength(2);
	      expect(payload.points[0]).toMatch(UUID_V4_REGEX);
	      expect(payload.points[1]).toMatch(UUID_V4_REGEX);
	    });

	    test('throws VectorStoreError on delete failure', async () => {
	      mockClient.delete.mockRejectedValue(new Error('Delete failed'));

      await expect(compat.deleteByIds('test', ['1'])).rejects.toThrow(VectorStoreError);
    });

    test('throws when not connected', async () => {
      const disconnected = new QdrantCompat(mockClientFactory);

      await expect(disconnected.deleteByIds('test', ['1'])).rejects.toThrow('Not connected');
    });
  });

  describe('collectionExists', () => {
    beforeEach(async () => {
      await compat.connect(createConfig());
    });

    test('returns true when collection exists', async () => {
      mockClient.getCollections.mockResolvedValue({
        collections: [{ name: 'existing' }, { name: 'other' }]
      });

      const exists = await compat.collectionExists('existing');

      expect(exists).toBe(true);
    });

    test('returns false when collection does not exist', async () => {
      mockClient.getCollections.mockResolvedValue({
        collections: [{ name: 'other' }]
      });

      const exists = await compat.collectionExists('nonexistent');

      expect(exists).toBe(false);
    });

    test('throws VectorStoreError on failure', async () => {
      mockClient.getCollections.mockRejectedValue(new Error('Failed'));

      await expect(compat.collectionExists('test')).rejects.toThrow(VectorStoreError);
    });

    test('throws when not connected', async () => {
      const disconnected = new QdrantCompat(mockClientFactory);

      await expect(disconnected.collectionExists('test')).rejects.toThrow('Not connected');
    });
  });

  describe('createCollection', () => {
    beforeEach(async () => {
      await compat.connect(createConfig());
    });

    test('creates collection with default Cosine distance', async () => {
      mockClient.createCollection.mockResolvedValue({});

      await compat.createCollection('new-collection', 128);

      expect(mockClient.createCollection).toHaveBeenCalledWith('new-collection', {
        vectors: {
          size: 128,
          distance: 'Cosine'
        }
      });
    });

    test('creates collection with custom distance metric', async () => {
      mockClient.createCollection.mockResolvedValue({});

      await compat.createCollection('new-collection', 256, { distance: 'Euclid' });

      expect(mockClient.createCollection).toHaveBeenCalledWith('new-collection', {
        vectors: {
          size: 256,
          distance: 'Euclid'
        }
      });
    });

    test('throws VectorStoreError on creation failure', async () => {
      mockClient.createCollection.mockRejectedValue(new Error('Create failed'));

      await expect(compat.createCollection('test', 128)).rejects.toThrow(VectorStoreError);
    });

    test('throws when not connected', async () => {
      const disconnected = new QdrantCompat(mockClientFactory);

      await expect(disconnected.createCollection('test', 128)).rejects.toThrow('Not connected');
    });

    test('creates payload indexes when provided', async () => {
      mockClient.createCollection.mockResolvedValue({});
      mockClient.createPayloadIndex.mockResolvedValue({});

      await compat.createCollection('new-collection', 128, {
        payloadIndexes: [
          { field: 'category', type: 'keyword' },
          { field: 'flag', type: 'boolean' }
        ]
      });

      expect(mockClient.createPayloadIndex).toHaveBeenCalledTimes(2);
      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('new-collection', {
        field_name: 'category',
        field_schema: 'keyword'
      });
      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('new-collection', {
        field_name: 'flag',
        field_schema: 'bool'
      });
    });
  });

  describe('list/delete collections', () => {
    beforeEach(async () => {
      await compat.connect(createConfig());
    });

    test('lists collections', async () => {
      mockClient.getCollections.mockResolvedValue({ collections: [{ name: 'one' }, { name: 'two' }] });

      const res = await compat.listCollections();
      expect(res).toEqual(['one', 'two']);
    });

    test('lists collections when API returns empty payload', async () => {
      mockClient.getCollections.mockResolvedValue({});
      const res = await compat.listCollections();
      expect(res).toEqual([]);
    });

    test('deletes collection', async () => {
      await compat.deleteCollection('to-drop');
      expect(mockClient.deleteCollection).toHaveBeenCalledWith('to-drop');
    });
  });

  describe('constructor', () => {
    test('uses default client factory when none provided', () => {
      // This should not throw - creates default factory
      const defaultCompat = new QdrantCompat();
      expect(defaultCompat).toBeInstanceOf(QdrantCompat);
    });

    test('default factory tries to create real QdrantClient', async () => {
      const defaultCompat = new QdrantCompat();
      // This will fail because no real Qdrant server, but proves the factory executes
      try {
        await defaultCompat.connect(createConfig());
      } catch (error: any) {
        // Expected to fail - just verifying the default factory code path executes
        expect(error).toBeInstanceOf(VectorStoreConnectionError);
      }
    });
  });

  describe('logging', () => {
    const createMockLogger = () => ({
      logEmbeddingRequest: jest.fn(),
      logEmbeddingResponse: jest.fn(),
      logVectorRequest: jest.fn(),
      logVectorResponse: jest.fn()
    });

    test('setLogger stores logger for later use', async () => {
      const mockLogger = createMockLogger();

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());

      // Logger should be called during connect
      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'connect',
          store: 'test-qdrant'
        })
      );
      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'connect',
          store: 'test-qdrant'
        })
      );
    });

    test('logs query operations with results', async () => {
      const mockLogger = createMockLogger();
      mockClient.search.mockResolvedValue([
        { id: '1', score: 0.95, payload: { text: 'hello' } }
      ]);

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await compat.query('test-collection', [0.1, 0.2], 5);

      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith({
        operation: 'query',
        store: 'test-qdrant',
        collection: 'test-collection',
        params: expect.objectContaining({
          vectorDimensions: 2,
          topK: 5
        })
      });

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith({
        operation: 'query',
        store: 'test-qdrant',
        collection: 'test-collection',
        result: expect.objectContaining({
          count: 1,
          topScore: 0.95,
          ids: ['1']
        }),
        duration: expect.any(Number)
      });
    });

    test('logs query failure', async () => {
      const mockLogger = createMockLogger();
      mockClient.search.mockRejectedValue(new Error('Search failed'));

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await expect(compat.query('test', [1], 1)).rejects.toThrow();

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'query',
          result: expect.objectContaining({
            error: 'Search failed'
          })
        })
      );
    });

    test('logs upsert operations', async () => {
      const mockLogger = createMockLogger();
      mockClient.upsert.mockResolvedValue({});

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await compat.upsert('test-collection', [
        { id: 'p1', vector: [0.1, 0.2], payload: { text: 'hello' } }
      ]);

      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith({
        operation: 'upsert',
        store: 'test-qdrant',
        collection: 'test-collection',
        params: expect.objectContaining({
          pointCount: 1,
          ids: ['p1'],
          vectorDimensions: 2
        })
      });

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'upsert',
          result: expect.objectContaining({ success: true })
        })
      );
    });

    test('logs upsert failure', async () => {
      const mockLogger = createMockLogger();
      mockClient.upsert.mockRejectedValue(new Error('Upsert failed'));

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await expect(compat.upsert('test', [{ id: '1', vector: [1] }])).rejects.toThrow();

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'upsert',
          result: expect.objectContaining({
            error: 'Upsert failed'
          })
        })
      );
    });

    test('logs delete operations', async () => {
      const mockLogger = createMockLogger();
      mockClient.delete.mockResolvedValue({});

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await compat.deleteByIds('test-collection', ['id1', 'id2']);

      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith({
        operation: 'delete',
        store: 'test-qdrant',
        collection: 'test-collection',
        params: { ids: ['id1', 'id2'], idCount: 2 }
      });

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'delete',
          result: expect.objectContaining({ success: true })
        })
      );
    });

    test('logs delete failure', async () => {
      const mockLogger = createMockLogger();
      mockClient.delete.mockRejectedValue(new Error('Delete failed'));

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await expect(compat.deleteByIds('test', ['1'])).rejects.toThrow();

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'delete',
          result: expect.objectContaining({
            error: 'Delete failed'
          })
        })
      );
    });

    test('logs createCollection operations', async () => {
      const mockLogger = createMockLogger();
      mockClient.createCollection.mockResolvedValue({});

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await compat.createCollection('new-collection', 128);

      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith({
        operation: 'createCollection',
        store: 'test-qdrant',
        collection: 'new-collection',
        params: { dimensions: 128, distance: 'Cosine', payloadIndexes: 0 }
      });

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'createCollection',
          result: expect.objectContaining({ success: true })
        })
      );
    });

    test('logs createCollection failure', async () => {
      const mockLogger = createMockLogger();
      mockClient.createCollection.mockRejectedValue(new Error('Create failed'));

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await expect(compat.createCollection('test', 128)).rejects.toThrow();

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'createCollection',
          result: expect.objectContaining({
            error: 'Create failed'
          })
        })
      );
    });

    test('logs connect failure', async () => {
      const mockLogger = createMockLogger();
      mockClient.getCollections.mockRejectedValue(new Error('Connection refused'));

      const newCompat = new QdrantCompat(mockClientFactory);
      newCompat.setLogger(mockLogger);

      await expect(newCompat.connect(createConfig())).rejects.toThrow();

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'connect',
          result: expect.objectContaining({
            error: 'Connection refused'
          })
        })
      );
    });

    test('logs connect with cloud URL config', async () => {
      const mockLogger = createMockLogger();

      compat.setLogger(mockLogger);
      await compat.connect(createConfig({
        host: undefined,
        port: undefined,
        url: 'https://cloud.qdrant.io',
        apiKey: 'secret-key'
      }));

      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith({
        operation: 'connect',
        store: 'test-qdrant',
        params: expect.objectContaining({
          url: 'https://cloud.qdrant.io',
          hasApiKey: true
        })
      });
    });

    test('logs connect with URL containing credentials (redacted)', async () => {
      const mockLogger = createMockLogger();

      compat.setLogger(mockLogger);
      await compat.connect(createConfig({
        host: undefined,
        port: undefined,
        url: 'https://user:password@cloud.qdrant.io'
      }));

      // The URL with credentials should be redacted
      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith({
        operation: 'connect',
        store: 'test-qdrant',
        params: expect.objectContaining({
          url: 'https://***:***@cloud.qdrant.io'
        })
      });
    });

    test('logs query with filter when logger present', async () => {
      const mockLogger = createMockLogger();
      mockClient.search.mockResolvedValue([]);

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();

      await compat.query('test', [0.1], 5, { filter: { status: 'active' } });

      expect(mockLogger.logVectorRequest).toHaveBeenCalledWith({
        operation: 'query',
        store: 'test-qdrant',
        collection: 'test',
        params: expect.objectContaining({
          filter: { status: 'active' }
        })
      });
    });

    test('logs query without results correctly', async () => {
      const mockLogger = createMockLogger();
      mockClient.search.mockResolvedValue([]);

      compat.setLogger(mockLogger);
      await compat.connect(createConfig());
      mockLogger.logVectorRequest.mockClear();
      mockLogger.logVectorResponse.mockClear();

      await compat.query('test', [0.1], 5);

      expect(mockLogger.logVectorResponse).toHaveBeenCalledWith({
        operation: 'query',
        store: 'test-qdrant',
        collection: 'test',
        result: expect.objectContaining({
          count: 0
        }),
        duration: expect.any(Number)
      });
    });
  });

  describe('createPayloadIndex', () => {
    beforeEach(async () => {
      await compat.connect(createConfig());
    });

    test('creates keyword index', async () => {
      mockClient.createPayloadIndex.mockResolvedValue({});

      await compat.createPayloadIndex('col', 'category', 'keyword');

      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('col', {
        field_name: 'category',
        field_schema: 'keyword'
      });
    });

    test('throws VectorStoreError on failure', async () => {
      mockClient.createPayloadIndex.mockRejectedValue(new Error('boom'));

      await expect(compat.createPayloadIndex('col', 'field', 'keyword'))
        .rejects.toThrow(VectorStoreError);
    });
  });
});
