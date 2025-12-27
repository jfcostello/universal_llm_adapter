import fs from 'fs';
import path from 'path';
import { runVectorOnce } from '@tests/helpers/live-v3.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '17-vector-cli';

const STORE_ID = 'qdrant-cloud';

function readOpenRouterEmbeddingProvider(): { id: string; dimensions?: number } {
  const raw = fs.readFileSync(path.join(process.cwd(), 'plugins', 'embeddings', 'openrouter.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return { id: String(parsed.id), dimensions: typeof parsed.dimensions === 'number' ? parsed.dimensions : undefined };
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  const embedding = readOpenRouterEmbeddingProvider();
  const collection = `v3_${TEST_FILE}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const dimensions = embedding.dimensions ?? 1536;

  beforeAll(async () => {
    const { result, response } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'collections_create',
      spec: {
        operation: 'collections',
        store: STORE_ID,
        input: {
          collectionOp: 'create',
          collectionName: collection,
          dimensions
        }
      }
    });

    expect(result.code).toBe(0);
    expect(response?.success).toBe(true);
  }, 120_000);

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
      console.warn('Vector cleanup warning:', error?.message ?? String(error));
    }
  }, 60_000);

  test('stream: embed emits progress events and ends with done + final result', async () => {
    const texts = Array.from(
      { length: 13 },
      (_v, i) => `Document ${i + 1}: Streaming embed progress verification for vector operations.`
    );

    const { result, events, done } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'embed_stream_progress',
      command: 'stream',
      spec: {
        operation: 'embed',
        store: STORE_ID,
        collection,
        embeddingPriority: [{ provider: embedding.id }],
        settings: { batchSize: 4 },
        input: { texts }
      }
    });

    expect(result.code).toBe(0);
    expect(Array.isArray(events)).toBe(true);
    expect(events!.some(e => e?.type === 'progress')).toBe(true);
    expect(done?.type).toBe('done');

    const resultEvent = events!.find(e => e?.type === 'result');
    expect(resultEvent?.result?.success).toBe(true);
    expect(resultEvent?.result?.operation).toBe('embed');
    expect(resultEvent?.result?.embedded).toBe(texts.length);
    expect(resultEvent?.result?.upserted).toBe(texts.length);
  }, 180_000);
});

