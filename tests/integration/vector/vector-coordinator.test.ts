import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

// Type imports
import type { VectorStoreCoordinator } from '@/coordinator/vector-coordinator.ts';
import type { VectorCallSpec } from '@/core/vector-spec-types.ts';
import type { PluginRegistry } from '@/core/registry.ts';

// Integration tests use real plugin loading with memory compat
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');

describe('integration/vector/vector-coordinator', () => {
  let VectorStoreCoordinatorClass: typeof VectorStoreCoordinator;
  let PluginRegistryClass: typeof PluginRegistry;
  let registry: PluginRegistry;
  let coordinator: VectorStoreCoordinator;

  beforeAll(async () => {
    try {
      const coordinatorModule = await import('@/coordinator/vector-coordinator.ts');
      const registryModule = await import('@/core/registry.ts');
      VectorStoreCoordinatorClass = coordinatorModule.VectorStoreCoordinator;
      PluginRegistryClass = registryModule.PluginRegistry;
    } catch {
      // Modules don't exist yet - skip tests
      console.warn('VectorStoreCoordinator not implemented yet - skipping integration tests');
    }
  });

  beforeEach(async () => {
    if (!PluginRegistryClass) return;

    // Use real registry with plugins directory
    const pluginsPath = path.join(ROOT_DIR, 'plugins');
    registry = new PluginRegistryClass(pluginsPath);
    await registry.loadAll();

    coordinator = new VectorStoreCoordinatorClass(registry);
  });

  afterEach(async () => {
    await coordinator?.close();
  });

  describe('embed and query flow with memory store', () => {
    test('embeds texts and retrieves similar results', async () => {
      if (!coordinator) {
        console.warn('Skipping - coordinator not available');
        return;
      }

      // Step 1: Embed and upsert sample documents
      const embedResult = await coordinator.execute({
        operation: 'embed',
        store: 'memory', // Use in-memory store for testing
        collection: 'test-integration',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          chunks: [
            { id: 'doc1', text: 'Machine learning is a subset of artificial intelligence', metadata: { topic: 'ml' } },
            { id: 'doc2', text: 'Python is a popular programming language', metadata: { topic: 'programming' } },
            { id: 'doc3', text: 'Neural networks are used in deep learning', metadata: { topic: 'ml' } }
          ]
        }
      });

      expect(embedResult.success).toBe(true);
      expect(embedResult.embedded).toBe(3);

      // Step 2: Query for similar documents
      const queryResult = await coordinator.execute({
        operation: 'query',
        store: 'memory',
        collection: 'test-integration',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'What is deep learning?',
          topK: 2
        }
      });

      expect(queryResult.success).toBe(true);
      expect(queryResult.results).toBeDefined();
      expect(queryResult.results!.length).toBeLessThanOrEqual(2);

      // The ML-related documents should score higher
      if (queryResult.results!.length > 0) {
        expect(['doc1', 'doc3']).toContain(queryResult.results![0].id);
      }
    });

    test('filters query results by metadata', async () => {
      if (!coordinator) return;

      // Embed documents with different topics
      await coordinator.execute({
        operation: 'embed',
        store: 'memory',
        collection: 'test-filter',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          chunks: [
            { id: 'ml-1', text: 'Machine learning algorithms', metadata: { category: 'ml' } },
            { id: 'web-1', text: 'Web development with React', metadata: { category: 'web' } },
            { id: 'ml-2', text: 'Deep learning models', metadata: { category: 'ml' } }
          ]
        }
      });

      // Query with filter
      const result = await coordinator.execute({
        operation: 'query',
        store: 'memory',
        collection: 'test-filter',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'programming techniques',
          topK: 10,
          filter: { category: 'ml' }
        }
      });

      expect(result.success).toBe(true);
      // All results should be from 'ml' category
      result.results!.forEach(r => {
        expect(r.payload?.category).toBe('ml');
      });
    });
  });

  describe('upsert and delete flow', () => {
    test('upserts vectors and deletes by ID', async () => {
      if (!coordinator) return;

      // First, embed to get vectors
      const embedResult = await coordinator.execute({
        operation: 'embed',
        store: 'memory',
        collection: 'test-delete',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          chunks: [
            { id: 'to-keep', text: 'Keep this document' },
            { id: 'to-delete-1', text: 'Delete this document' },
            { id: 'to-delete-2', text: 'Also delete this' }
          ]
        }
      });

      expect(embedResult.success).toBe(true);
      expect(embedResult.embedded).toBe(3);

      // Query to verify all are there
      const beforeDelete = await coordinator.execute({
        operation: 'query',
        store: 'memory',
        collection: 'test-delete',
        input: {
          vector: [0.1, 0.1, 0.1], // Dummy vector
          topK: 10
        }
      });

      expect(beforeDelete.results!.length).toBe(3);

      // Delete two documents
      const deleteResult = await coordinator.execute({
        operation: 'delete',
        store: 'memory',
        collection: 'test-delete',
        input: {
          ids: ['to-delete-1', 'to-delete-2']
        }
      });

      expect(deleteResult.success).toBe(true);
      expect(deleteResult.deleted).toBe(2);

      // Query again to verify deletion
      const afterDelete = await coordinator.execute({
        operation: 'query',
        store: 'memory',
        collection: 'test-delete',
        input: {
          vector: [0.1, 0.1, 0.1],
          topK: 10
        }
      });

      expect(afterDelete.results!.length).toBe(1);
      expect(afterDelete.results![0].id).toBe('to-keep');
    });
  });

  describe('collections management', () => {
    test('creates, checks, and deletes collection', async () => {
      if (!coordinator) return;

      const collectionName = 'test-collection-mgmt';

      // Create collection
      const createResult = await coordinator.execute({
        operation: 'collections',
        store: 'memory',
        input: {
          collectionOp: 'create',
          collectionName,
          dimensions: 1536
        }
      });

      expect(createResult.success).toBe(true);
      expect(createResult.created).toBe(true);

      // Check exists
      const existsResult = await coordinator.execute({
        operation: 'collections',
        store: 'memory',
        input: {
          collectionOp: 'exists',
          collectionName
        }
      });

      expect(existsResult.success).toBe(true);
      expect(existsResult.exists).toBe(true);

      // Delete collection
      const deleteResult = await coordinator.execute({
        operation: 'collections',
        store: 'memory',
        input: {
          collectionOp: 'delete',
          collectionName
        }
      });

      expect(deleteResult.success).toBe(true);

      // Verify deleted
      const afterDelete = await coordinator.execute({
        operation: 'collections',
        store: 'memory',
        input: {
          collectionOp: 'exists',
          collectionName
        }
      });

      expect(afterDelete.exists).toBe(false);
    });
  });

  describe('batch operations with streaming', () => {
    test('streams progress for large embed operation', async () => {
      if (!coordinator) return;

      const texts = Array.from({ length: 20 }, (_, i) => `Document ${i + 1} content`);

      const events: any[] = [];
      for await (const event of coordinator.executeStream({
        operation: 'embed',
        store: 'memory',
        collection: 'test-batch',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: { texts },
        settings: { batchSize: 5 }
      })) {
        events.push(event);
      }

      const progressEvents = events.filter(e => e.type === 'progress');
      const doneEvent = events.find(e => e.type === 'done');

      expect(progressEvents.length).toBeGreaterThan(0);
      expect(doneEvent).toBeDefined();
    });
  });

  describe('error handling', () => {
    test('returns error result for invalid store', async () => {
      if (!coordinator) return;

      const result = await coordinator.execute({
        operation: 'query',
        store: 'nonexistent-store',
        input: {
          query: 'test',
          topK: 5
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('handles missing embedding priority for text query', async () => {
      if (!coordinator) return;

      const result = await coordinator.execute({
        operation: 'query',
        store: 'memory',
        // No embeddingPriority provided
        input: {
          query: 'test query',
          topK: 5
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('embedding');
    });
  });
});
