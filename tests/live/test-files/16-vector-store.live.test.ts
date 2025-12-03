/**
 * Live test for Qdrant Cloud vector store.
 *
 * Required environment variables:
 * - QDRANT_CLOUD_URL: Your Qdrant Cloud cluster URL (e.g., https://xyz-abc.aws.cloud.qdrant.io:6333)
 * - QDRANT_API_KEY: Your Qdrant API key
 * - OPENROUTER_API_KEY: For embeddings
 *
 * Run with: npm run test:live:vector
 */

import dotenv from 'dotenv';
dotenv.config();

import { VectorStoreManager } from '@/managers/vector-store-manager.ts';
import { EmbeddingManager } from '@/managers/embedding-manager.ts';
import { PluginRegistry } from '@/core/registry.ts';
import QdrantCompat from '@/plugins/vector-compat/qdrant.ts';
import path from 'path';
import type { VectorStoreConfig } from '@/core/types.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = path.join(process.cwd(), 'plugins');

// Test collection name with timestamp to avoid conflicts
const testCollection = `test_collection_${Date.now()}`;

function getQdrantConfig(): VectorStoreConfig {
  return {
    id: 'qdrant-cloud',
    kind: 'qdrant',
    connection: {
      url: process.env.QDRANT_CLOUD_URL || '',
      apiKey: process.env.QDRANT_API_KEY || ''
    },
    defaultCollection: testCollection
  };
}

// Skip if required env vars not set
const hasQdrantConfig = !!(process.env.QDRANT_CLOUD_URL && process.env.QDRANT_API_KEY);
const shouldRun = runLive && hasQdrantConfig;

(shouldRun ? describe : describe.skip)('16-vector-store — Qdrant Cloud', () => {
  let registry: PluginRegistry;
  let embeddingManager: EmbeddingManager;
  let vectorStoreManager: VectorStoreManager;
  let qdrantCompat: QdrantCompat;
  const config = getQdrantConfig();

  beforeAll(async () => {
    if (!hasQdrantConfig) {
      console.log('Skipping: QDRANT_CLOUD_URL and QDRANT_API_KEY must be set');
      return;
    }

    registry = new PluginRegistry(pluginsPath);
    embeddingManager = new EmbeddingManager(registry);

    // Create Qdrant compat and connect
    qdrantCompat = new QdrantCompat();

    try {
      await qdrantCompat.connect(config);
      console.log('Connected to Qdrant Cloud');
    } catch (error: any) {
      console.error('Failed to connect to Qdrant Cloud:', error.message);
      throw error;
    }

    // Create test collection (1536 dimensions for text-embedding-3-small)
    const exists = await qdrantCompat.collectionExists(testCollection);
    if (!exists) {
      await qdrantCompat.createCollection(testCollection, 1536, { distance: 'Cosine' });
      console.log(`Created collection: ${testCollection}`);
    }

    // Set up VectorStoreManager with embedding function
    const embedFn = embeddingManager.createEmbedderFn([{ provider: 'openrouter-embeddings' }]);

    const mockRegistry = {
      getVectorStore: async () => config,
      getVectorStoreCompat: async () => qdrantCompat
    };

    const configs = new Map<string, VectorStoreConfig>();
    configs.set(config.id, config);

    vectorStoreManager = new VectorStoreManager(
      configs,
      new Map(),
      embedFn,
      mockRegistry
    );
  }, 60000);

  afterAll(async () => {
    try {
      if (vectorStoreManager) {
        await vectorStoreManager.closeAll();
        console.log('Closed Qdrant connection');
      }
    } catch (error: any) {
      console.warn('Cleanup warning:', error.message);
    }
  }, 30000);

  test('upserts documents with embeddings', async () => {
    // Generate embeddings for documents
    // Note: Qdrant requires UUIDs or integers for point IDs
    const documents = [
      { id: '11111111-1111-1111-1111-111111111111', text: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.', category: 'javascript' },
      { id: '22222222-2222-2222-2222-222222222222', text: 'Python is a high-level programming language known for its simplicity.', category: 'other' },
      { id: '33333333-3333-3333-3333-333333333333', text: 'Machine learning is a method of data analysis that automates analytical model building.', category: 'other' },
      { id: '44444444-4444-4444-4444-444444444444', text: 'JavaScript runs in web browsers and is essential for frontend development.', category: 'javascript' }
    ];

    const embedResult = await embeddingManager.embed(
      documents.map(d => d.text),
      [{ provider: 'openrouter-embeddings' }]
    );

    const points = documents.map((doc, i) => ({
      id: doc.id,
      vector: embedResult.vectors[i],
      payload: { text: doc.text, category: doc.category }
    }));

    await vectorStoreManager.upsert(config.id, points);

    console.log(`Upserted ${points.length} documents`);
  }, 60000);

  test('queries similar documents', async () => {
    // Query for TypeScript-related content
    const { store, results } = await vectorStoreManager.queryWithPriority(
      [config.id],
      'What programming language adds types to JavaScript?',
      3
    );

    expect(store).toBe(config.id);
    expect(results.length).toBeGreaterThan(0);

    console.log('Query results:');
    for (const result of results) {
      console.log(`  - ${result.id}: score=${result.score.toFixed(4)}, text="${(result.payload?.text as string)?.substring(0, 50)}..."`);
    }

    // The TypeScript document should be in top results
    const topIds = results.map((r: any) => r.id);
    expect(topIds).toContain('11111111-1111-1111-1111-111111111111');
  }, 60000);

  // Note: Filtering requires creating a payload index first in Qdrant Cloud
  // This is a known limitation - filtering works without indexes only on small collections
  test.skip('queries with filter (requires payload index)', async () => {
    // Use Qdrant's native filter format directly
    const { results } = await vectorStoreManager.queryWithPriority(
      [config.id],
      'programming language',
      10,
      { must: [{ key: 'category', match: { value: 'javascript' } }] }
    );

    // All results should be in the javascript category
    for (const result of results) {
      expect(result.payload?.category).toBe('javascript');
    }

    console.log(`Filtered query returned ${results.length} javascript-related results`);
  }, 60000);

  test('deletes documents by ID', async () => {
    const doc3Id = '33333333-3333-3333-3333-333333333333';

    // First verify doc3 exists
    const { results: before } = await vectorStoreManager.queryWithPriority(
      [config.id],
      'machine learning data analysis',
      5
    );

    const hadDoc3 = before.some((r: any) => r.id === doc3Id);
    expect(hadDoc3).toBe(true);

    // Delete doc3
    await vectorStoreManager.deleteByIds(config.id, [doc3Id]);

    // Wait a moment for deletion to propagate
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify doc3 is gone
    const { results: after } = await vectorStoreManager.queryWithPriority(
      [config.id],
      'machine learning data analysis',
      5
    );

    const stillHasDoc3 = after.some((r: any) => r.id === doc3Id);
    expect(stillHasDoc3).toBe(false);

    console.log('Successfully deleted doc3');
  }, 60000);

  test('getCompat returns underlying compat for advanced operations', async () => {
    const compat = await vectorStoreManager.getCompat(config.id);

    expect(compat).toBe(qdrantCompat);

    // Use compat for collection check
    const exists = await compat!.collectionExists(testCollection);
    expect(exists).toBe(true);

    const notExists = await compat!.collectionExists('nonexistent_collection_xyz');
    expect(notExists).toBe(false);
  }, 30000);
});

// Full RAG flow test
(shouldRun ? describe : describe.skip)('16-vector-store — Full RAG Flow', () => {
  test('end-to-end RAG: embed, store, query, retrieve', async () => {
    const registry = new PluginRegistry(pluginsPath);
    const embeddingManager = new EmbeddingManager(registry);
    const qdrantCompat = new QdrantCompat();

    const config: VectorStoreConfig = getQdrantConfig();
    config.defaultCollection = `rag_test_${Date.now()}`;

    try {
      // Connect
      await qdrantCompat.connect(config);

      // Create collection
      await qdrantCompat.createCollection(config.defaultCollection!, 1536);

      // Prepare documents
      const documents = [
        'The Eiffel Tower is a wrought-iron lattice tower in Paris, France.',
        'The Great Wall of China is a series of fortifications made of stone and brick.',
        'The Colosseum is an ancient amphitheater in Rome, Italy.',
        'Mount Everest is the highest mountain in the world, located in the Himalayas.'
      ];

      // Embed documents
      const embedResult = await embeddingManager.embed(
        documents,
        [{ provider: 'openrouter-embeddings' }]
      );

      // Store in Qdrant (using UUIDs for point IDs)
      const uuids = [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'dddddddd-dddd-dddd-dddd-dddddddddddd'
      ];
      const points = documents.map((text, i) => ({
        id: uuids[i],
        vector: embedResult.vectors[i],
        payload: { text, index: i }
      }));

      await qdrantCompat.upsert(config.defaultCollection!, points);

      // Query for relevant context
      const queryEmbedding = await embeddingManager.embed(
        'What landmark is in Paris?',
        [{ provider: 'openrouter-embeddings' }]
      );

      const results = await qdrantCompat.query(
        config.defaultCollection!,
        queryEmbedding.vectors[0],
        2
      );

      console.log('RAG Query Results:');
      for (const result of results) {
        console.log(`  - Score: ${result.score.toFixed(4)}, Text: "${result.payload?.text}"`);
      }

      // The Eiffel Tower document should be the top result
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].payload?.text).toContain('Eiffel Tower');

      console.log('Full RAG flow completed successfully!');
    } finally {
      await qdrantCompat.close();
    }
  }, 120000);
});
