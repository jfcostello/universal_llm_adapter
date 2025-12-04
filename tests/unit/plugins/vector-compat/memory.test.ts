import MemoryCompat from '@/plugins/vector-compat/memory.ts';
import { VectorStoreError } from '@/core/errors.ts';
import type { VectorStoreConfig, VectorPoint } from '@/core/types.ts';

function createConfig(): VectorStoreConfig {
  return {
    id: 'test-memory',
    kind: 'memory',
    connection: {}
  };
}

describe('plugins/vector-compat/memory', () => {
  let compat: MemoryCompat;

  beforeEach(async () => {
    compat = new MemoryCompat();
    await compat.connect(createConfig());
  });

  afterEach(async () => {
    await compat.close();
  });

  describe('connect/close', () => {
    test('connects successfully', async () => {
      const newCompat = new MemoryCompat();
      await expect(newCompat.connect(createConfig())).resolves.not.toThrow();
    });

    test('close clears all data', async () => {
      await compat.upsert('test', [{ id: '1', vector: [1, 2] }]);
      await compat.close();

      // Reconnect and verify empty
      await compat.connect(createConfig());
      const exists = await compat.collectionExists('test');
      expect(exists).toBe(false);
    });
  });

  describe('upsert', () => {
    test('inserts new points', async () => {
      const points: VectorPoint[] = [
        { id: '1', vector: [0.1, 0.2], payload: { text: 'hello' } },
        { id: '2', vector: [0.3, 0.4], payload: { text: 'world' } }
      ];

      await compat.upsert('test-collection', points);

      const allPoints = compat.getCollectionPoints('test-collection');
      expect(allPoints).toHaveLength(2);
    });

    test('updates existing points', async () => {
      await compat.upsert('test', [{ id: '1', vector: [0.1, 0.2], payload: { v: 1 } }]);
      await compat.upsert('test', [{ id: '1', vector: [0.5, 0.6], payload: { v: 2 } }]);

      const points = compat.getCollectionPoints('test');
      expect(points).toHaveLength(1);
      expect(points[0].vector).toEqual([0.5, 0.6]);
      expect(points[0].payload).toEqual({ v: 2 });
    });

    test('creates collection if not exists', async () => {
      await compat.upsert('new-collection', [{ id: '1', vector: [1] }]);

      const exists = await compat.collectionExists('new-collection');
      expect(exists).toBe(true);
    });

    test('throws when not connected', async () => {
      const disconnected = new MemoryCompat();

      await expect(disconnected.upsert('test', [])).rejects.toThrow(VectorStoreError);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      // Setup test data with known vectors
      await compat.upsert('test', [
        { id: 'a', vector: [1, 0], payload: { category: 'cat' } },
        { id: 'b', vector: [0, 1], payload: { category: 'dog' } },
        { id: 'c', vector: [0.707, 0.707], payload: { category: 'cat' } }
      ]);
    });

    test('returns similar vectors sorted by score', async () => {
      // Query with vector similar to 'a' [1, 0]
      const results = await compat.query('test', [1, 0], 3);

      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('a'); // Exact match
      expect(results[0].score).toBeCloseTo(1.0, 5);
      expect(results[1].id).toBe('c'); // Second most similar
    });

    test('respects topK limit', async () => {
      const results = await compat.query('test', [1, 0], 1);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a');
    });

    test('filters by payload', async () => {
      const results = await compat.query('test', [1, 0], 10, { filter: { category: 'cat' } });

      expect(results).toHaveLength(2);
      expect(results.every(r => r.payload?.category === 'cat')).toBe(true);
    });

    test('includes payload by default', async () => {
      const results = await compat.query('test', [1, 0], 1);

      expect(results[0].payload).toBeDefined();
      expect(results[0].payload?.category).toBe('cat');
    });

    test('excludes payload when includePayload is false', async () => {
      const results = await compat.query('test', [1, 0], 1, { includePayload: false });

      expect(results[0].payload).toBeUndefined();
    });

    test('includes vector when includeVector is true', async () => {
      const results = await compat.query('test', [1, 0], 1, { includeVector: true });

      expect(results[0].vector).toEqual([1, 0]);
    });

    test('excludes vector by default', async () => {
      const results = await compat.query('test', [1, 0], 1);

      expect(results[0].vector).toBeUndefined();
    });

    test('returns empty array for non-existent collection', async () => {
      const results = await compat.query('nonexistent', [1, 0], 5);

      expect(results).toEqual([]);
    });

    test('handles empty collection', async () => {
      await compat.createCollection('empty', 2);
      const results = await compat.query('empty', [1, 0], 5);

      expect(results).toEqual([]);
    });

    test('throws when not connected', async () => {
      const disconnected = new MemoryCompat();

      await expect(disconnected.query('test', [1, 0], 5)).rejects.toThrow(VectorStoreError);
    });

    test('handles zero vectors correctly', async () => {
      await compat.upsert('zero', [{ id: 'z', vector: [0, 0] }]);
      const results = await compat.query('zero', [1, 0], 1);

      expect(results[0].score).toBe(0);
    });

    test('handles different length vectors gracefully', async () => {
      await compat.upsert('mixed', [{ id: '1', vector: [1, 2, 3] }]);
      const results = await compat.query('mixed', [1, 0], 1);

      // Different lengths should return 0 similarity
      expect(results[0].score).toBe(0);
    });

    test('excludes points where payload is missing when filter is applied', async () => {
      await compat.upsert('test', [{ id: 'no-payload', vector: [0.9, 0.1] }]);
      const results = await compat.query('test', [1, 0], 10, { filter: { category: 'cat' } });

      // Should not include the point without payload
      expect(results.find(r => r.id === 'no-payload')).toBeUndefined();
    });
  });

  describe('deleteByIds', () => {
    test('deletes points by id', async () => {
      await compat.upsert('test', [
        { id: '1', vector: [1] },
        { id: '2', vector: [2] },
        { id: '3', vector: [3] }
      ]);

      await compat.deleteByIds('test', ['1', '3']);

      const points = compat.getCollectionPoints('test');
      expect(points).toHaveLength(1);
      expect(points[0].id).toBe('2');
    });

    test('ignores non-existent ids', async () => {
      await compat.upsert('test', [{ id: '1', vector: [1] }]);

      await expect(compat.deleteByIds('test', ['nonexistent'])).resolves.not.toThrow();
    });

    test('handles non-existent collection gracefully', async () => {
      await expect(compat.deleteByIds('nonexistent', ['1'])).resolves.not.toThrow();
    });

    test('throws when not connected', async () => {
      const disconnected = new MemoryCompat();

      await expect(disconnected.deleteByIds('test', ['1'])).rejects.toThrow(VectorStoreError);
    });
  });

  describe('collectionExists', () => {
    test('returns true for existing collection', async () => {
      await compat.upsert('exists', [{ id: '1', vector: [1] }]);

      const exists = await compat.collectionExists('exists');
      expect(exists).toBe(true);
    });

    test('returns false for non-existent collection', async () => {
      const exists = await compat.collectionExists('nonexistent');
      expect(exists).toBe(false);
    });

    test('throws when not connected', async () => {
      const disconnected = new MemoryCompat();

      await expect(disconnected.collectionExists('test')).rejects.toThrow(VectorStoreError);
    });
  });

  describe('createCollection', () => {
    test('creates new collection', async () => {
      await compat.createCollection('new', 128);

      const exists = await compat.collectionExists('new');
      expect(exists).toBe(true);
    });

    test('does not throw if collection already exists', async () => {
      await compat.createCollection('dup', 128);
      await expect(compat.createCollection('dup', 128)).resolves.not.toThrow();
    });

    test('throws when not connected', async () => {
      const disconnected = new MemoryCompat();

      await expect(disconnected.createCollection('test', 128)).rejects.toThrow(VectorStoreError);
    });
  });

  describe('deleteCollection', () => {
    test('deletes existing collection', async () => {
      await compat.createCollection('to-delete', 128);
      expect(await compat.collectionExists('to-delete')).toBe(true);

      await compat.deleteCollection('to-delete');
      expect(await compat.collectionExists('to-delete')).toBe(false);
    });

    test('does not throw if collection does not exist', async () => {
      await expect(compat.deleteCollection('nonexistent')).resolves.not.toThrow();
    });

    test('throws when not connected', async () => {
      const disconnected = new MemoryCompat();
      await expect(disconnected.deleteCollection('test')).rejects.toThrow(VectorStoreError);
    });
  });

  describe('listCollections', () => {
    test('lists all collections', async () => {
      await compat.createCollection('col1', 128);
      await compat.createCollection('col2', 128);

      const collections = await compat.listCollections();
      expect(collections).toContain('col1');
      expect(collections).toContain('col2');
    });

    test('returns empty array when no collections', async () => {
      const collections = await compat.listCollections();
      expect(collections).toEqual([]);
    });

    test('throws when not connected', async () => {
      const disconnected = new MemoryCompat();
      await expect(disconnected.listCollections()).rejects.toThrow(VectorStoreError);
    });
  });

  describe('utility methods', () => {
    test('getCollectionPoints returns all points', async () => {
      await compat.upsert('test', [
        { id: '1', vector: [1] },
        { id: '2', vector: [2] }
      ]);

      const points = compat.getCollectionPoints('test');
      expect(points).toHaveLength(2);
    });

    test('getCollectionPoints returns empty for non-existent collection', () => {
      const points = compat.getCollectionPoints('nonexistent');
      expect(points).toEqual([]);
    });

    test('clear removes all data', async () => {
      await compat.upsert('test1', [{ id: '1', vector: [1] }]);
      await compat.upsert('test2', [{ id: '2', vector: [2] }]);

      compat.clear();

      expect(await compat.collectionExists('test1')).toBe(false);
      expect(await compat.collectionExists('test2')).toBe(false);
    });
  });
});
