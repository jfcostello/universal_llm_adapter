/**
 * Live test for vector store operations via CLI/server transport.
 *
 * Required environment variables:
 * - QDRANT_CLOUD_URL
 * - QDRANT_API_KEY
 * - OPENROUTER_API_KEY
 *
 * Run with:
 * - CLI: `npm run test:live:openrouter -- --transport=cli --testPathPattern=16-vector-store`
 * - Server: `npm run test:live:openrouter -- --transport=server --testPathPattern=16-vector-store`
 */

import { runEmbeddingCoordinator, runVectorCoordinator } from '@tests/helpers/node-cli.ts';

const runLive = process.env.LLM_LIVE === '1';
const hasQdrantConfig = Boolean(process.env.QDRANT_CLOUD_URL && process.env.QDRANT_API_KEY);
const hasEmbeddingKey = Boolean(process.env.OPENROUTER_API_KEY);
const describeLive = runLive && hasQdrantConfig && hasEmbeddingKey ? describe : describe.skip;

const pluginsPath = './plugins';
const testCollection = `test_collection_${Date.now()}`;

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

describeLive('16-vector-store (transported)', () => {
  let dimensions = 0;

  beforeAll(async () => {
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
        payloadIndexes: [{ field: 'category', type: 'keyword' }]
      }
    });
    expect(createRes.success).toBe(true);
  }, 120000);

  afterAll(async () => {
    try {
      await runVector({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'delete',
          collectionName: testCollection
        }
      });

      const existsRes = await runVector({
        operation: 'collections',
        store: 'qdrant-cloud',
        input: {
          collectionOp: 'exists',
          collectionName: testCollection
        }
      });

      expect(existsRes.exists).toBe(false);
    } catch (error: any) {
      console.warn('Cleanup warning:', error?.message ?? String(error));
    }
  }, 60000);

  test('embeds and upserts documents', async () => {
    const documents = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        text: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
        category: 'javascript'
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        text: 'Python is a high-level programming language known for its simplicity.',
        category: 'other'
      },
      {
        id: '33333333-3333-3333-3333-333333333333',
        text: 'Machine learning is a method of data analysis that automates analytical model building.',
        category: 'other'
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        text: 'JavaScript runs in web browsers and is essential for frontend development.',
        category: 'javascript'
      }
    ];

    const res = await runVector({
      operation: 'embed',
      store: 'qdrant-cloud',
      collection: testCollection,
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        chunks: documents.map(d => ({
          id: d.id,
          text: d.text,
          metadata: { category: d.category }
        }))
      }
    });

    expect(res.success).toBe(true);
    expect(res.operation).toBe('embed');
    expect(res.embedded).toBe(4);
    expect(res.upserted).toBe(4);
    expect(res.dimensions).toBe(dimensions);

    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 120000);

  test('queries similar documents', async () => {
    const res = await runVector({
      operation: 'query',
      store: 'qdrant-cloud',
      collection: testCollection,
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        query: 'What programming language adds types to JavaScript?',
        topK: 3
      }
    });

    expect(res.success).toBe(true);
    expect(Array.isArray(res.results)).toBe(true);
    expect(res.results.length).toBeGreaterThan(0);

    const topIds = res.results.map((r: any) => String(r.id));
    expect(topIds).toContain('11111111-1111-1111-1111-111111111111');
  }, 60000);

  test('queries with filter', async () => {
    const res = await runVector({
      operation: 'query',
      store: 'qdrant-cloud',
      collection: testCollection,
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        query: 'programming language',
        topK: 10,
        filter: { category: 'javascript' }
      }
    });

    expect(res.success).toBe(true);
    for (const r of res.results ?? []) {
      expect(r.payload?.category).toBe('javascript');
    }
  }, 60000);

  test('deletes documents by ID', async () => {
    const docId = '33333333-3333-3333-3333-333333333333';

    const before = await runVector({
      operation: 'query',
      store: 'qdrant-cloud',
      collection: testCollection,
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        query: 'machine learning data analysis',
        topK: 10
      }
    });
    const hadDoc = (before.results ?? []).some((r: any) => String(r.id) === docId);
    expect(hadDoc).toBe(true);

    const del = await runVector({
      operation: 'delete',
      store: 'qdrant-cloud',
      collection: testCollection,
      input: { ids: [docId] }
    });
    expect(del.success).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 1000));

    const after = await runVector({
      operation: 'query',
      store: 'qdrant-cloud',
      collection: testCollection,
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        query: 'machine learning data analysis',
        topK: 10
      }
    });
    const stillHasDoc = (after.results ?? []).some((r: any) => String(r.id) === docId);
    expect(stillHasDoc).toBe(false);
  }, 90000);
});

