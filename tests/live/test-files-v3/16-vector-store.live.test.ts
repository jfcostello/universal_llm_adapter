import fs from 'fs';
import path from 'path';
import { runEmbeddingOnce, runVectorOnce } from '@tests/helpers/live-v3.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '16-vector-store';

const STORE_ID = 'qdrant-cloud';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readOpenRouterEmbeddingProvider(): { id: string; dimensions?: number } {
  const raw = fs.readFileSync(path.join(process.cwd(), 'plugins', 'embeddings', 'openrouter.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return { id: String(parsed.id), dimensions: typeof parsed.dimensions === 'number' ? parsed.dimensions : undefined };
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  const embedding = readOpenRouterEmbeddingProvider();
  const collection = `v3_${TEST_FILE}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const dimensions = embedding.dimensions ?? 1536;

  afterAll(async () => {
    try {
      await runVectorOnce({
        testFileBase: TEST_FILE,
        testName: 'cleanup_delete_collection',
        spec: {
          operation: 'collections',
          store: STORE_ID,
          input: {
            collectionOp: 'delete',
            collectionName: collection
          }
        }
      });

      const { response: existsRes } = await runVectorOnce({
        testFileBase: TEST_FILE,
        testName: 'cleanup_exists_collection',
        spec: {
          operation: 'collections',
          store: STORE_ID,
          input: {
            collectionOp: 'exists',
            collectionName: collection
          }
        }
      });

      if (existsRes && typeof existsRes.exists === 'boolean') {
        expect(existsRes.exists).toBe(false);
      }
    } catch (error: any) {
      // Cleanup should never fail the suite; log for diagnostics.
      console.warn('Vector cleanup warning:', error?.message ?? String(error));
    }
  }, 60_000);

  test('collections: create + exists', async () => {
    const { result: createResult, response: createRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'collections_create',
      spec: {
        operation: 'collections',
        store: STORE_ID,
        input: {
          collectionOp: 'create',
          collectionName: collection,
          dimensions,
          payloadIndexes: [
            { field: 'category', type: 'keyword' },
            { field: 'relevance', type: 'keyword' }
          ]
        }
      }
    });

    expect(createResult.code).toBe(0);
    expect(createRes?.success).toBe(true);
    expect(createRes?.operation).toBe('collections');

    const { result: existsResult, response: existsRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'collections_exists',
      spec: {
        operation: 'collections',
        store: STORE_ID,
        input: {
          collectionOp: 'exists',
          collectionName: collection
        }
      }
    });

    expect(existsResult.code).toBe(0);
    expect(existsRes?.success).toBe(true);
    expect(existsRes?.exists).toBe(true);
  }, 120_000);

  test('embed + query (text) + query (vector) + filter/includePayload/scoreThreshold + delete-by-id', async () => {
    const docs = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        text: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
        metadata: { category: 'javascript', relevance: 'high' }
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        text: 'Python is a high-level programming language known for its simplicity.',
        metadata: { category: 'other', relevance: 'low' }
      },
      {
        id: '33333333-3333-3333-3333-333333333333',
        text: 'Machine learning is a method of data analysis that automates analytical model building.',
        metadata: { category: 'other', relevance: 'high' }
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        text: 'JavaScript runs in web browsers and is essential for frontend development.',
        metadata: { category: 'javascript', relevance: 'high' }
      }
    ];

    const { result: embedResult, response: embedRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'embed_seed',
      spec: {
        operation: 'embed',
        store: STORE_ID,
        collection,
        embeddingPriority: [{ provider: embedding.id }],
        input: {
          chunks: docs.map(d => ({
            id: d.id,
            text: d.text,
            metadata: d.metadata
          }))
        }
      }
    });

    expect(embedResult.code).toBe(0);
    expect(embedRes?.success).toBe(true);
    expect(embedRes?.operation).toBe('embed');
    expect(embedRes?.embedded).toBe(docs.length);
    expect(embedRes?.upserted).toBe(docs.length);
    expect(embedRes?.dimensions).toBe(dimensions);

    // Allow eventual consistency for the external store.
    await sleep(1500);

    const textQuery = 'Which language adds types to JavaScript?';
    const { result: queryTextResult, response: queryTextRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'query_text',
      spec: {
        operation: 'query',
        store: STORE_ID,
        collection,
        embeddingPriority: [{ provider: embedding.id }],
        input: {
          query: textQuery,
          topK: 3
        }
      }
    });

    expect(queryTextResult.code).toBe(0);
    expect(queryTextRes?.success).toBe(true);
    expect(queryTextRes?.operation).toBe('query');
    expect(Array.isArray(queryTextRes?.results)).toBe(true);
    expect(queryTextRes?.results?.length).toBeGreaterThan(0);
    expect(queryTextRes?.results?.every((r: any) => typeof r.id === 'string' || typeof r.id === 'number')).toBe(true);
    expect(queryTextRes?.results?.every((r: any) => typeof r.score === 'number')).toBe(true);

    const topIds = (queryTextRes?.results ?? []).map((r: any) => String(r.id));
    expect(topIds).toContain('11111111-1111-1111-1111-111111111111');

    const { result: embedQueryResult, response: embedQueryRes } = await runEmbeddingOnce({
      testFileBase: TEST_FILE,
      testName: 'embed_query_vector',
      spec: {
        operation: 'embed',
        embeddingPriority: [{ provider: embedding.id }],
        input: { text: textQuery }
      }
    });

    expect(embedQueryResult.code).toBe(0);
    expect(embedQueryRes?.success).toBe(true);
    const queryVector = embedQueryRes?.vectors?.[0];
    expect(Array.isArray(queryVector)).toBe(true);
    expect(queryVector?.length).toBe(dimensions);

    const { result: queryVecResult, response: queryVecRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'query_vector',
      spec: {
        operation: 'query',
        store: STORE_ID,
        collection,
        input: {
          vector: queryVector,
          topK: 3
        }
      }
    });

    expect(queryVecResult.code).toBe(0);
    expect(queryVecRes?.success).toBe(true);
    expect(queryVecRes?.operation).toBe('query');
    expect(Array.isArray(queryVecRes?.results)).toBe(true);
    expect(queryVecRes?.results?.length).toBeGreaterThan(0);

    // Filter + includePayload
    const { result: queryFilterResult, response: queryFilterRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'query_filter_payload',
      spec: {
        operation: 'query',
        store: STORE_ID,
        collection,
        embeddingPriority: [{ provider: embedding.id }],
        settings: { includePayload: true },
        input: {
          query: 'programming language',
          topK: 10,
          filter: { category: 'javascript' }
        }
      }
    });

    expect(queryFilterResult.code).toBe(0);
    expect(queryFilterRes?.success).toBe(true);
    for (const r of queryFilterRes?.results ?? []) {
      expect(r?.payload && typeof r.payload === 'object').toBe(true);
      expect(r.payload.category).toBe('javascript');
    }

    // Score thresholding is enforced deterministically by the adapter. Results may be empty.
    const threshold = 0.1;
    const { result: queryThresholdResult, response: queryThresholdRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'query_score_threshold',
      spec: {
        operation: 'query',
        store: STORE_ID,
        collection,
        embeddingPriority: [{ provider: embedding.id }],
        input: {
          query: 'machine learning',
          topK: 10,
          scoreThreshold: threshold
        }
      }
    });

    expect(queryThresholdResult.code).toBe(0);
    expect(queryThresholdRes?.success).toBe(true);
    for (const r of queryThresholdRes?.results ?? []) {
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(threshold);
    }

    // Delete-by-id removes a known chunk from subsequent query results.
    const deleteId = '33333333-3333-3333-3333-333333333333';

    const { result: deleteResult, response: deleteRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'delete_by_id',
      spec: {
        operation: 'delete',
        store: STORE_ID,
        collection,
        input: { ids: [deleteId] }
      }
    });

    expect(deleteResult.code).toBe(0);
    expect(deleteRes?.success).toBe(true);
    expect(deleteRes?.operation).toBe('delete');

    await sleep(1000);

    const { result: afterDeleteResult, response: afterDeleteRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'query_after_delete',
      spec: {
        operation: 'query',
        store: STORE_ID,
        collection,
        embeddingPriority: [{ provider: embedding.id }],
        input: {
          query: 'machine learning data analysis',
          topK: 10
        }
      }
    });

    expect(afterDeleteResult.code).toBe(0);
    expect(afterDeleteRes?.success).toBe(true);
    const idsAfterDelete = (afterDeleteRes?.results ?? []).map((r: any) => String(r.id));
    expect(idsAfterDelete).not.toContain(deleteId);
  }, 240_000);
});
