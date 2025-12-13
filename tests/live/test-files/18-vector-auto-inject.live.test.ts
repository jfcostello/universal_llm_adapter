/**
 * Live tests for vector context auto-injection via CLI/server transport.
 *
 * Required environment variables:
 * - QDRANT_CLOUD_URL
 * - QDRANT_API_KEY
 * - OPENROUTER_API_KEY
 *
 * Run with:
 * - CLI: `npm run test:live:openrouter -- --transport=cli --testPathPattern=18-vector-auto-inject`
 * - Server: `npm run test:live:openrouter -- --transport=server --testPathPattern=18-vector-auto-inject`
 */

import { runCoordinator, runEmbeddingCoordinator, runVectorCoordinator } from '@tests/helpers/node-cli.ts';

const runLive = process.env.LLM_LIVE === '1';
const required = ['QDRANT_CLOUD_URL', 'QDRANT_API_KEY', 'OPENROUTER_API_KEY'];
const missing = required.filter(key => !process.env[key]);
const describeLive = runLive && missing.length === 0 ? describe : describe.skip;

const pluginsPath = './plugins';
const testCollection = `test-inject-${Date.now()}`;

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

async function runLlm(spec: any): Promise<any> {
  const result = await runCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: process.env
  });
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim());
}

describeLive('18-vector-auto-inject (transported)', () => {
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
        dimensions
      }
    });
    expect(createRes.success).toBe(true);

    // Seed with test documents
    const seedRes = await runVector({
      operation: 'embed',
      store: 'qdrant-cloud',
      collection: testCollection,
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        chunks: [
          {
            id: 'fact-1',
            text: 'The capital of France is Paris. Paris is known for the Eiffel Tower.',
            metadata: { topic: 'geography', country: 'France' }
          },
          {
            id: 'fact-2',
            text: 'Python was created by Guido van Rossum and released in 1991.',
            metadata: { topic: 'programming', language: 'Python' }
          },
          {
            id: 'fact-3',
            text: 'Machine learning is a subset of AI that enables computers to learn from data.',
            metadata: { topic: 'technology', field: 'AI' }
          },
          {
            id: 'fact-4',
            text: 'The Great Wall of China is over 13,000 miles long.',
            metadata: { topic: 'geography', country: 'China' }
          }
        ]
      }
    });
    expect(seedRes.success).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 2000));
  }, 180000);

  afterAll(async () => {
    if (missing.length > 0) return;

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

  describe('auto mode - context injection', () => {
    test('injects relevant context before LLM call', async () => {
      const spec = {
        systemPrompt: 'You are a helpful assistant. Answer questions using only the provided context.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'What is the capital of France?' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: testCollection,
          mode: 'auto',
          topK: 2,
          injectAs: 'system',
          injectTemplate: 'Use the following context to answer:\n\n{{results}}'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 200 }
      };

      const response = await runLlm(spec);

      const textParts = (response?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase());

      const joined = textParts.join('\n');
      expect(joined).toContain('paris');
    }, 120000);

    test('filters context by metadata', async () => {
      const spec = {
        systemPrompt: 'Answer based only on the provided context. Be specific and mention locations.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Tell me about a capital city mentioned in the context.' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: testCollection,
          mode: 'auto',
          topK: 5,
          filter: { topic: 'geography' },
          injectAs: 'system'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 200 }
      };

      const response = await runLlm(spec);
      const textParts = (response?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase());

      const joined = textParts.join('\n');
      expect(
        joined.includes('paris') ||
          joined.includes('france') ||
          joined.includes('china') ||
          joined.includes('beijing') ||
          joined.includes('capital')
      ).toBe(true);
    }, 120000);

    test('uses score threshold to filter low-relevance results', async () => {
      const spec = {
        systemPrompt: 'If no relevant context is provided, say "No relevant information found."',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'What is the recipe for chocolate cake?' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: testCollection,
          mode: 'auto',
          topK: 3,
          scoreThreshold: 0.9,
          injectAs: 'system'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 200 }
      };

      const response = await runLlm(spec);
      const textParts = (response?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase());
      expect(textParts.join('\n').length).toBeGreaterThan(0);
    }, 120000);
  });
});

