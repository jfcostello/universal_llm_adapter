/**
 * Live test for embedding operations via CLI/server transport.
 *
 * Required environment variables:
 * - OPENROUTER_API_KEY
 *
 * Run with:
 * - CLI: `npm run test:live:openrouter -- --transport=cli --testPathPattern=15-embeddings`
 * - Server: `npm run test:live:openrouter -- --transport=server --testPathPattern=15-embeddings`
 */

import { runEmbeddingCoordinator } from '@tests/helpers/node-cli.ts';

const runLive = process.env.LLM_LIVE === '1';
const hasKey = Boolean(process.env.OPENROUTER_API_KEY);
const describeLive = runLive && hasKey ? describe : describe.skip;

const pluginsPath = './plugins';

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function runEmbedding(spec: any): Promise<any> {
  const result = await runEmbeddingCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: process.env
  });

  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim());
}

describeLive('15-embeddings (transported)', () => {
  test('embeds single text successfully', async () => {
    const result = await runEmbedding({
      operation: 'embed',
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: { text: 'Hello, world! This is a test of the embedding API.' }
    });

    expect(result.success).toBe(true);
    expect(result.vectors).toBeDefined();
    expect(result.vectors.length).toBe(1);
    expect(result.vectors[0].length).toBeGreaterThan(100);
    expect(result.model).toBeDefined();
    expect(result.dimensions).toBeGreaterThan(0);
  }, 30000);

  test('embeds batch of texts successfully', async () => {
    const texts = [
      'The quick brown fox jumps over the lazy dog.',
      'Machine learning is a subset of artificial intelligence.',
      'TypeScript adds static typing to JavaScript.'
    ];

    const result = await runEmbedding({
      operation: 'embed',
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: { texts }
    });

    expect(result.success).toBe(true);
    expect(result.vectors).toBeDefined();
    expect(result.vectors.length).toBe(3);
    const dim = result.vectors[0].length;
    for (const vec of result.vectors) {
      expect(vec.length).toBe(dim);
    }
  }, 30000);

  test('similar texts have similar embeddings', async () => {
    const result = await runEmbedding({
      operation: 'embed',
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        texts: [
          'I love programming in TypeScript.',
          'TypeScript is my favorite programming language.',
          'The weather is sunny today.'
        ]
      }
    });

    const sim01 = cosineSimilarity(result.vectors[0], result.vectors[1]);
    const sim02 = cosineSimilarity(result.vectors[0], result.vectors[2]);
    const sim12 = cosineSimilarity(result.vectors[1], result.vectors[2]);

    expect(sim01).toBeGreaterThan(sim02);
    expect(sim01).toBeGreaterThan(sim12);
  }, 30000);

  test('dimensions operation returns a positive value', async () => {
    const result = await runEmbedding({
      operation: 'dimensions',
      provider: 'openrouter-embeddings'
    });

    expect(result.success).toBe(true);
    expect(result.dimensions).toBeGreaterThan(0);
  }, 10000);

  test('validate operation returns true for configured provider', async () => {
    const result = await runEmbedding({
      operation: 'validate',
      provider: 'openrouter-embeddings'
    });

    expect(result.success).toBe(true);
    expect(result.valid).toBe(true);
  }, 30000);

  test('fallback works when first provider is invalid', async () => {
    const result = await runEmbedding({
      operation: 'embed',
      embeddingPriority: [
        { provider: 'nonexistent-provider' },
        { provider: 'openrouter-embeddings' }
      ],
      input: { text: 'Test fallback behavior' }
    });

    expect(result.success).toBe(true);
    expect(result.vectors).toBeDefined();
    expect(result.vectors.length).toBe(1);
  }, 30000);
});
