/**
 * Live test for embedding providers.
 *
 * Tests OpenRouter embeddings API with real API calls.
 *
 * Required environment variables:
 * - OPENROUTER_API_KEY: Your OpenRouter API key
 *
 * Run with: LLM_LIVE=1 npm test -- --testPathPattern="15-embeddings"
 */

import { EmbeddingManager } from '@/managers/embedding-manager.ts';
import { PluginRegistry } from '@/core/registry.ts';
import path from 'path';

const runLive = process.env.LLM_LIVE === '1';
const runServerTransport = String(process.env.LLM_LIVE_TRANSPORT || 'cli').toLowerCase() === 'server';
const pluginsPath = path.join(process.cwd(), 'plugins');

((runLive && !runServerTransport) ? describe : describe.skip)('15-embeddings — OpenRouter', () => {
  let registry: PluginRegistry;
  let embeddingManager: EmbeddingManager;

  beforeAll(async () => {
    registry = new PluginRegistry(pluginsPath);
    embeddingManager = new EmbeddingManager(registry);
  });

  test('embeds single text successfully', async () => {
    const result = await embeddingManager.embed(
      'Hello, world! This is a test of the embedding API.',
      [{ provider: 'openrouter-embeddings' }]
    );

    expect(result.vectors).toBeDefined();
    expect(result.vectors.length).toBe(1);
    expect(result.vectors[0].length).toBeGreaterThan(100); // Embeddings should be high-dimensional
    expect(result.model).toBeDefined();
    expect(result.dimensions).toBeGreaterThan(0);

    console.log('Embedding result:', {
      model: result.model,
      dimensions: result.dimensions,
      vectorLength: result.vectors[0].length,
      tokenCount: result.tokenCount,
      sampleValues: result.vectors[0].slice(0, 5)
    });
  }, 30000);

  test('embeds batch of texts successfully', async () => {
    const texts = [
      'The quick brown fox jumps over the lazy dog.',
      'Machine learning is a subset of artificial intelligence.',
      'TypeScript adds static typing to JavaScript.'
    ];

    const result = await embeddingManager.embed(
      texts,
      [{ provider: 'openrouter-embeddings' }]
    );

    expect(result.vectors).toBeDefined();
    expect(result.vectors.length).toBe(3);

    // Each vector should have same dimensions
    const dim = result.vectors[0].length;
    for (const vec of result.vectors) {
      expect(vec.length).toBe(dim);
    }

    console.log('Batch embedding result:', {
      model: result.model,
      dimensions: result.dimensions,
      batchSize: result.vectors.length,
      tokenCount: result.tokenCount
    });
  }, 30000);

  test('similar texts have similar embeddings', async () => {
    const result = await embeddingManager.embed(
      [
        'I love programming in TypeScript.',
        'TypeScript is my favorite programming language.',
        'The weather is sunny today.'
      ],
      [{ provider: 'openrouter-embeddings' }]
    );

    // Calculate cosine similarity
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

    const sim01 = cosineSimilarity(result.vectors[0], result.vectors[1]);
    const sim02 = cosineSimilarity(result.vectors[0], result.vectors[2]);
    const sim12 = cosineSimilarity(result.vectors[1], result.vectors[2]);

    console.log('Similarity scores:', {
      'TypeScript love vs TypeScript favorite': sim01.toFixed(4),
      'TypeScript love vs Weather': sim02.toFixed(4),
      'TypeScript favorite vs Weather': sim12.toFixed(4)
    });

    // Similar texts should have higher similarity than dissimilar ones
    expect(sim01).toBeGreaterThan(sim02);
    expect(sim01).toBeGreaterThan(sim12);
  }, 30000);

  test('getDimensions returns correct dimensions', async () => {
    const dims = await embeddingManager.getDimensions('openrouter-embeddings');

    expect(dims).toBeGreaterThan(0);
    console.log('Dimensions:', dims);
  }, 10000);

  test('validate returns true for valid provider', async () => {
    const isValid = await embeddingManager.validate('openrouter-embeddings');

    expect(isValid).toBe(true);
  }, 30000);

  test('createEmbedderFn produces working embedder', async () => {
    const embedFn = embeddingManager.createEmbedderFn([{ provider: 'openrouter-embeddings' }]);

    // Single text
    const singleResult = await embedFn('Hello world');
    expect(Array.isArray(singleResult)).toBe(true);
    expect((singleResult as number[]).length).toBeGreaterThan(100);

    // Batch texts
    const batchResult = await embedFn(['Hello', 'World']);
    expect(Array.isArray(batchResult)).toBe(true);
    expect((batchResult as number[][]).length).toBe(2);
  }, 30000);

  test('fallback works when first provider is invalid', async () => {
    const result = await embeddingManager.embed(
      'Test fallback behavior',
      [
        { provider: 'nonexistent-provider' },
        { provider: 'openrouter-embeddings' }
      ]
    );

    expect(result.vectors).toBeDefined();
    expect(result.vectors.length).toBe(1);
    console.log('Fallback worked, used model:', result.model);
  }, 30000);
});
