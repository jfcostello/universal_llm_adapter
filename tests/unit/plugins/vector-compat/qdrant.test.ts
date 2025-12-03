import { jest } from '@jest/globals';
import QdrantCompat from '@/plugins/vector-compat/qdrant.ts';
import { VectorStoreConnectionError, VectorStoreError } from '@/core/errors.ts';
import type { VectorStoreConfig } from '@/core/types.ts';

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
    createCollection: jest.fn()
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

      expect(mockClient.upsert).toHaveBeenCalledWith('my-collection', {
        wait: true,
        points: [
          { id: 'p1', vector: [0.1, 0.2], payload: { text: 'hello' } },
          { id: 'p2', vector: [0.3, 0.4], payload: {} }
        ]
      });
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

      expect(mockClient.delete).toHaveBeenCalledWith('my-collection', {
        wait: true,
        points: ['id1', 'id2']
      });
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
});
