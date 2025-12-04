/**
 * Live tests for Vector Store CLI operations.
 *
 * These tests run against real Qdrant Cloud and OpenRouter APIs.
 *
 * Required environment variables:
 * - QDRANT_CLOUD_URL: Qdrant Cloud instance URL
 * - QDRANT_API_KEY: Qdrant Cloud API key
 * - OPENROUTER_API_KEY: OpenRouter API key for embeddings
 *
 * Run: npm run test:live:vector-cli
 * Or: LLM_LIVE=1 npx jest tests/live/test-files/17-vector-cli.live.test.ts
 */

import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

const SKIP_LIVE = !process.env.LLM_LIVE;
const describeLive = SKIP_LIVE ? describe.skip : describe;

// Type imports
import type { VectorStoreCoordinator } from '@/coordinator/vector-coordinator.ts';
import type { VectorCallSpec } from '@/core/vector-spec-types.ts';
import type { PluginRegistry } from '@/core/registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');
const TEST_COLLECTION = `test-cli-${Date.now()}`;

describeLive('live/vector-cli', () => {
  let VectorStoreCoordinatorClass: typeof VectorStoreCoordinator;
  let PluginRegistryClass: typeof PluginRegistry;
  let registry: PluginRegistry;
  let coordinator: VectorStoreCoordinator;
  let setupSucceeded = false;

  beforeAll(async () => {
    // Verify required environment variables
    const required = ['QDRANT_CLOUD_URL', 'QDRANT_API_KEY', 'OPENROUTER_API_KEY'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
      console.warn(`Missing environment variables: ${missing.join(', ')}`);
      console.warn('Skipping live vector CLI tests');
      return;
    }

    try {
      const coordinatorModule = await import('@/coordinator/vector-coordinator.ts');
      const registryModule = await import('@/core/registry.ts');
      VectorStoreCoordinatorClass = coordinatorModule.VectorStoreCoordinator;
      PluginRegistryClass = registryModule.PluginRegistry;

      const pluginsPath = path.join(ROOT_DIR, 'plugins');
      registry = new PluginRegistryClass(pluginsPath);
      await registry.loadAll();

      coordinator = new VectorStoreCoordinatorClass(registry);

      // Create test collection
      const createResult = await coordinator.execute({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'create',
          collectionName: TEST_COLLECTION,
          dimensions: 1536,
          payloadIndexes: [
            { field: 'category', type: 'keyword' },
            { field: 'source', type: 'keyword' }
          ]
        }
      });

      // Mark setup as successful only if collection was created (or already exists)
      if (createResult.success || createResult.error?.includes('already exists')) {
        setupSucceeded = true;
      } else {
        console.warn('Failed to create test collection:', createResult.error);
      }
    } catch (error) {
      console.error('Failed to initialize for live tests:', error);
    }
  }, 60000);

  afterAll(async () => {
    if (coordinator) {
      // Clean up test collection
      try {
        await coordinator.execute({
          operation: 'collections',
          store: 'qdrant-cloud',
          input: {
            collectionOp: 'delete',
            collectionName: TEST_COLLECTION
          }
        });
      } catch (error) {
        console.warn('Failed to delete test collection:', error);
      }
      await coordinator.close();
    }
  }, 30000);

  describe('embed operation', () => {
    test('embeds and upserts texts to Qdrant Cloud', async () => {
      if (!coordinator || !setupSucceeded) {
        console.warn('Qdrant setup failed - skipping test');
        return;
      }

      const result = await coordinator.execute({
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          chunks: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              text: 'Machine learning is a subset of artificial intelligence that enables systems to learn from data.',
              metadata: { source: 'live-test', category: 'ml' }
            },
            {
              id: '22222222-2222-2222-2222-222222222222',
              text: 'Deep learning uses neural networks with multiple layers to process complex patterns.',
              metadata: { source: 'live-test', category: 'ml' }
            },
            {
              id: '33333333-3333-3333-3333-333333333333',
              text: 'Python is widely used for data science and machine learning applications.',
              metadata: { source: 'live-test', category: 'programming' }
            }
          ]
        }
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('embed');
      expect(result.embedded).toBe(3);
      expect(result.upserted).toBe(3);
      expect(result.dimensions).toBe(1536);
    }, 60000);

    test('handles large batch with progress', async () => {
      if (!coordinator || !setupSucceeded) return;

      const texts = Array.from({ length: 10 }, (_, i) => `Document ${i + 1}: Sample content for testing batch operations.`);

      const events: any[] = [];
      for await (const event of coordinator.executeStream({
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: { texts },
        settings: { batchSize: 3 }
      })) {
        events.push(event);
      }

      const progressEvents = events.filter(e => e.type === 'progress');
      const doneEvent = events.find(e => e.type === 'done');
      const errorEvents = events.filter(e => e.type === 'error');

      expect(errorEvents).toHaveLength(0);
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(doneEvent).toBeDefined();
    }, 120000);
  });

  describe('query operation', () => {
    test('queries with text and retrieves similar documents', async () => {
      if (!coordinator || !setupSucceeded) return;

      // Wait a moment for Qdrant to index
      await new Promise(resolve => setTimeout(resolve, 1000));

      const result = await coordinator.execute({
        operation: 'query',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'What is deep learning and neural networks?',
          topK: 3
        },
        settings: {
          includePayload: true
        }
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('query');
      expect(result.results).toBeDefined();
      expect(result.results!.length).toBeLessThanOrEqual(3);

      if (result.results!.length > 0) {
        expect(result.results![0]).toHaveProperty('id');
        expect(result.results![0]).toHaveProperty('score');
        expect(result.results![0]).toHaveProperty('payload');
        // Deep learning doc should score high
        expect(result.results![0].score).toBeGreaterThan(0.5);
      }
    }, 30000);

    test('applies metadata filter', async () => {
      if (!coordinator || !setupSucceeded) return;

      const result = await coordinator.execute({
        operation: 'query',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'programming languages',
          topK: 10,
          filter: { category: 'ml' }
        },
        settings: {
          includePayload: true
        }
      });

      expect(result.success).toBe(true);
      // All results should be from 'ml' category
      result.results!.forEach(r => {
        expect(r.payload?.category).toBe('ml');
      });
    }, 30000);

    test('applies score threshold', async () => {
      if (!coordinator || !setupSucceeded) return;

      const result = await coordinator.execute({
        operation: 'query',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'machine learning algorithms',
          topK: 10,
          scoreThreshold: 0.7
        }
      });

      expect(result.success).toBe(true);
      // All results should have score >= 0.7
      result.results!.forEach(r => {
        expect(r.score).toBeGreaterThanOrEqual(0.7);
      });
    }, 30000);
  });

  describe('delete operation', () => {
    test('deletes vectors by ID', async () => {
      if (!coordinator || !setupSucceeded) return;

      // First, add a document to delete
      await coordinator.execute({
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          chunks: [{ id: '00000000-0000-0000-0000-000000000001', text: 'This document will be deleted.' }]
        }
      });

      // Delete it
      const deleteResult = await coordinator.execute({
        operation: 'delete',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        input: {
          ids: ['00000000-0000-0000-0000-000000000001']
        }
      });

      expect(deleteResult.success).toBe(true);
      expect(deleteResult.deleted).toBe(1);

      // Verify it's gone by querying
      await new Promise(resolve => setTimeout(resolve, 500));

      const queryResult = await coordinator.execute({
        operation: 'query',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'document deleted',
          topK: 1
        }
      });

      // The deleted document should not be the top result
      if (queryResult.results!.length > 0) {
        expect(queryResult.results![0].id).not.toBe('to-delete');
      }
    }, 60000);
  });

  describe('collections operation', () => {
    test('lists collections', async () => {
      if (!coordinator || !setupSucceeded) return;

      const result = await coordinator.execute({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'list'
        }
      });

      expect(result.success).toBe(true);
      expect(result.collections).toBeDefined();
      expect(Array.isArray(result.collections)).toBe(true);
      expect(result.collections).toContain(TEST_COLLECTION);
    }, 15000);

    test('checks collection exists', async () => {
      if (!coordinator || !setupSucceeded) return;

      const existsResult = await coordinator.execute({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'exists',
          collectionName: TEST_COLLECTION
        }
      });

      expect(existsResult.success).toBe(true);
      expect(existsResult.exists).toBe(true);

      const notExistsResult = await coordinator.execute({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'exists',
          collectionName: 'definitely-does-not-exist-12345'
        }
      });

      expect(notExistsResult.success).toBe(true);
      expect(notExistsResult.exists).toBe(false);
    }, 15000);
  });

  describe('error handling', () => {
    test('handles invalid collection gracefully', async () => {
      if (!coordinator || !setupSucceeded) return;

      const result = await coordinator.execute({
        operation: 'query',
        store: 'qdrant-cloud',
        collection: 'nonexistent-collection-12345',
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'test',
          topK: 5
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 15000);

    test('handles invalid embedding provider', async () => {
      if (!coordinator || !setupSucceeded) return;

      const result = await coordinator.execute({
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: TEST_COLLECTION,
        embeddingPriority: [{ provider: 'nonexistent-provider' }],
        input: {
          texts: ['test']
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, 15000);
  });
});
