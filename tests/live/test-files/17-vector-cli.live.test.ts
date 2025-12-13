/**
 * Live tests for vector operations via CLI/server transport.
 *
 * Required environment variables:
 * - QDRANT_CLOUD_URL
 * - QDRANT_API_KEY
 * - OPENROUTER_API_KEY
 *
 * Run with:
 * - CLI: `npm run test:live:openrouter -- --transport=cli --testPathPattern=17-vector-cli`
 * - Server: `npm run test:live:openrouter -- --transport=server --testPathPattern=17-vector-cli`
 */

import { runEmbeddingCoordinator, runVectorCoordinator } from '@tests/helpers/node-cli.ts';

const runLive = process.env.LLM_LIVE === '1';
const required = ['QDRANT_CLOUD_URL', 'QDRANT_API_KEY', 'OPENROUTER_API_KEY'];
const missing = required.filter(key => !process.env[key]);
const describeLive = runLive && missing.length === 0 ? describe : describe.skip;

const pluginsPath = './plugins';
const testCollection = `test-cli-${Date.now()}`;

async function runEmbedding(spec: any): Promise<any> {
  const result = await runEmbeddingCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: process.env
  });
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim());
}

async function runVector(spec: any): Promise<any> {
  const result = await runVectorCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: process.env
  });
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim());
}

async function runVectorStream(spec: any): Promise<any[]> {
  const result = await runVectorCoordinator({
    args: ['stream', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: process.env
  });
  expect(result.code).toBe(0);
  const lines = result.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

describeLive('17-vector-cli (transported)', () => {
  let dimensions = 0;

  beforeAll(async () => {
    if (missing.length > 0) {
      console.warn(`Missing environment variables: ${missing.join(', ')}`);
      return;
    }

    const dimsRes = await runEmbedding({
      operation: 'dimensions',
      provider: 'openrouter-embeddings'
    });
    expect(dimsRes.success).toBe(true);
    dimensions = Number(dimsRes.dimensions);
    expect(dimensions).toBeGreaterThan(0);

    const createRes = await runVector({
      operation: 'collections',
      store: 'qdrant-cloud',
      input: {
        collectionOp: 'create',
        collectionName: testCollection,
        dimensions,
        payloadIndexes: [
          { field: 'category', type: 'keyword' },
          { field: 'source', type: 'keyword' }
        ]
      }
    });
    expect(createRes.success).toBe(true);
  }, 120000);

  afterAll(async () => {
    if (missing.length > 0) return;

    try {
      await runVector({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: { collectionOp: 'delete', collectionName: testCollection }
      });

      const existsRes = await runVector({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: { collectionOp: 'exists', collectionName: testCollection }
      });
      expect(existsRes.exists).toBe(false);
    } catch (error: any) {
      console.warn('Cleanup warning:', error?.message ?? String(error));
    }
  }, 60000);

  describe('embed operation', () => {
    test('embeds and upserts chunks', async () => {
      const result = await runVector({
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: testCollection,
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
      expect(result.dimensions).toBe(dimensions);
    }, 120000);

    test('streams progress for batch embed', async () => {
      const texts = Array.from(
        { length: 10 },
        (_, i) => `Document ${i + 1}: Sample content for testing batch operations.`
      );

      const events = await runVectorStream({
        operation: 'embed',
        store: 'qdrant-cloud',
        collection: testCollection,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: { texts },
        settings: { batchSize: 3 }
      });

      const progressEvents = events.filter(e => e.type === 'progress');
      const doneEvent = events.find(e => e.type === 'done');
      const errorEvents = events.filter(e => e.type === 'error');

      expect(errorEvents).toHaveLength(0);
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(doneEvent).toBeDefined();
    }, 180000);
  });

  describe('query operation', () => {
    test('queries with text and retrieves similar documents', async () => {
      await new Promise(resolve => setTimeout(resolve, 1500));

      const result = await runVector({
        operation: 'query',
        store: 'qdrant-cloud',
        collection: testCollection,
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
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBeLessThanOrEqual(3);
      if (result.results.length > 0) {
        expect(result.results[0]).toHaveProperty('id');
        expect(result.results[0]).toHaveProperty('score');
        expect(result.results[0]).toHaveProperty('payload');
      }
    }, 90000);

    test('applies metadata filter', async () => {
      const result = await runVector({
        operation: 'query',
        store: 'qdrant-cloud',
        collection: testCollection,
        embeddingPriority: [{ provider: 'openrouter-embeddings' }],
        input: {
          query: 'machine learning',
          topK: 10,
          filter: { category: 'ml' }
        },
        settings: {
          includePayload: true
        }
      });

      expect(result.success).toBe(true);
      for (const r of result.results ?? []) {
        expect(r.payload?.category).toBe('ml');
      }
    }, 90000);
  });
});

