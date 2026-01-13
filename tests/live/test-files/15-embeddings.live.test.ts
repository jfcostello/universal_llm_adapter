import fs from 'fs';
import path from 'path';
import { runEmbeddingOnce } from '@tests/helpers/live.ts';
import { invalidPriorityEntry } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '15-embeddings';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function readOpenRouterEmbeddingProvider(): { id: string; dimensions?: number } {
  const raw = fs.readFileSync(path.join(process.cwd(), 'plugins', 'embeddings', 'openrouter.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return { id: String(parsed.id), dimensions: typeof parsed.dimensions === 'number' ? parsed.dimensions : undefined };
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('embed single input (fallback) → one vector + dimensions', async () => {
    const embedding = readOpenRouterEmbeddingProvider();

    const { result, response } = await runEmbeddingOnce({
      testFileBase: TEST_FILE,
      testName: 'single_fallback',
      spec: {
        operation: 'embed',
        embeddingPriority: [
          { provider: invalidPriorityEntry.provider, model: invalidPriorityEntry.model },
          { provider: embedding.id }
        ],
        input: { text: 'Hello, world! This is a conformance test.' }
      }
    });

    expect(result.code).toBe(0);
    expect(response?.success).toBe(true);
    expect(response?.operation).toBe('embed');
    expect(Array.isArray(response?.vectors)).toBe(true);
    expect(response?.vectors?.length).toBe(1);
    expect(typeof response?.model).toBe('string');
    expect(typeof response?.dimensions).toBe('number');
    expect(response?.dimensions).toBeGreaterThan(0);
    expect(response?.vectors?.[0]?.length).toBe(response?.dimensions);
  }, 120_000);

  test('embed batch → similarity(similar) > similarity(dissimilar)', async () => {
    const embedding = readOpenRouterEmbeddingProvider();

    const { result, response } = await runEmbeddingOnce({
      testFileBase: TEST_FILE,
      testName: 'batch_similarity',
      spec: {
        operation: 'embed',
        embeddingPriority: [{ provider: embedding.id }],
        input: {
          texts: [
            'I enjoy writing TypeScript.',
            'TypeScript is my favorite language to write.',
            'The weather is sunny today.'
          ]
        }
      }
    });

    expect(result.code).toBe(0);
    expect(response?.success).toBe(true);
    expect(response?.operation).toBe('embed');
    expect(Array.isArray(response?.vectors)).toBe(true);
    expect(response?.vectors?.length).toBe(3);
    expect(response?.vectors?.[0]?.length).toBeGreaterThan(0);

    const [v0, v1, v2] = response!.vectors;
    const sim01 = cosineSimilarity(v0, v1);
    const sim02 = cosineSimilarity(v0, v2);
    const sim12 = cosineSimilarity(v1, v2);

    expect(sim01).toBeGreaterThan(sim02);
    expect(sim01).toBeGreaterThan(sim12);
  }, 180_000);

  test('dimensions operation returns a positive integer (matches config when available)', async () => {
    const embedding = readOpenRouterEmbeddingProvider();

    const { result, response } = await runEmbeddingOnce({
      testFileBase: TEST_FILE,
      testName: 'dimensions',
      spec: {
        operation: 'dimensions',
        provider: embedding.id
      }
    });

    expect(result.code).toBe(0);
    expect(response?.success).toBe(true);
    expect(response?.operation).toBe('dimensions');
    expect(typeof response?.dimensions).toBe('number');
    expect(response?.dimensions).toBeGreaterThan(0);

    if (embedding.dimensions) {
      expect(response?.dimensions).toBe(embedding.dimensions);
    }
  }, 60_000);

  test('validate operation returns structured validity result', async () => {
    const embedding = readOpenRouterEmbeddingProvider();

    const { result, response } = await runEmbeddingOnce({
      testFileBase: TEST_FILE,
      testName: 'validate',
      spec: {
        operation: 'validate',
        provider: embedding.id
      }
    });

    expect(result.code).toBe(0);
    expect(response?.success).toBe(true);
    expect(response?.operation).toBe('validate');
    expect(response?.valid).toBe(true);
  }, 120_000);
});
