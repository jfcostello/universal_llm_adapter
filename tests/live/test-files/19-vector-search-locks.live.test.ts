/**
 * Live tests for vector search parameter locking via CLI/server transport.
 *
 * Required environment variables:
 * - QDRANT_CLOUD_URL
 * - QDRANT_API_KEY
 * - OPENROUTER_API_KEY
 *
 * Run with:
 * - CLI: `npm run test:live:openrouter -- --transport=cli --testPathPattern=19-vector-search-locks`
 * - Server: `npm run test:live:openrouter -- --transport=server --testPathPattern=19-vector-search-locks`
 */

import { runCoordinator, runEmbeddingCoordinator, runVectorCoordinator } from '@tests/helpers/node-cli.ts';
import { requireEnv } from '@tests/helpers/require-env.ts';
import { attachLangfuseObservability, createTraceId, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';
import { liveTestTimeout } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const required = ['QDRANT_CLOUD_URL', 'QDRANT_API_KEY', 'OPENROUTER_API_KEY'];
if (runLive) {
  requireEnv({ required, label: '19-vector-search-locks' });
}
const describeLive = runLive ? describe : describe.skip;

const pluginsPath = './plugins';
const TEST_FILE = '19-vector-search-locks';
const liveEnv = { ...process.env, TEST_FILE };
const testCollection = `test-locks-${Date.now()}`;

async function runEmbedding(spec: any): Promise<any> {
  const result = await runEmbeddingCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: liveEnv
  });
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim());
}

async function runVector(spec: any): Promise<any> {
  const result = await runVectorCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: liveEnv
  });
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim());
}

async function runLlm(spec: any): Promise<any> {
  const result = await runCoordinator({
    args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
    cwd: process.cwd(),
    env: liveEnv
  });
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim());
}

const expectNoVectorErrors = (response: any) => {
  const textParts = (response?.content ?? [])
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => String(c.text || '').toLowerCase());

  const errorHit = textParts.some((t: string) => t.includes('vector search failed') || t.includes('query failed'));
  expect(errorHit).toBe(false);
};

describeLive('19-vector-search-locks (transported)', () => {
  beforeAll(async () => {
    const dimsRes = await runEmbedding({
      operation: 'dimensions',
      provider: 'openrouter-embeddings'
    });
    expect(dimsRes.success).toBe(true);
    const dimensions = Number(dimsRes.dimensions);
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

    const seedRes = await runVector({
      operation: 'embed',
      store: 'qdrant-cloud',
      collection: testCollection,
      embeddingPriority: [{ provider: 'openrouter-embeddings' }],
      input: {
        chunks: [
          {
            id: 'high-relevance-1',
            text: 'The answer to the ultimate question of life is 42.',
            metadata: { category: 'philosophy', relevance: 'high' }
          },
          {
            id: 'high-relevance-2',
            text: 'Artificial intelligence will shape the future of humanity.',
            metadata: { category: 'technology', relevance: 'high' }
          },
          {
            id: 'low-relevance-1',
            text: 'Water boils at 100 degrees Celsius at sea level.',
            metadata: { category: 'science', relevance: 'low' }
          },
          {
            id: 'low-relevance-2',
            text: 'The speed of light is approximately 299,792 km per second.',
            metadata: { category: 'physics', relevance: 'low' }
          },
          {
            id: 'medium-relevance-1',
            text: 'Climate change is affecting ecosystems worldwide.',
            metadata: { category: 'environment', relevance: 'medium' }
          }
        ]
      }
    });
    expect(seedRes.success).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 2000));
  }, liveTestTimeout(180000));

  afterAll(async () => {
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

  describe('topK lock enforcement', () => {
    test('enforces locked topK', async () => {
      const vectorConfig = {
        stores: ['qdrant-cloud'],
        collection: testCollection,
        mode: 'tool',
        topK: 10,
        locks: { topK: 1 },
        toolDescription: 'Search the knowledge base. Always request topK: 100 to get comprehensive results.'
      };

      const traceId = createTraceId('19-vector-search-locks-topk');
      const spec = {
        systemPrompt:
          'You have a search tool. The tool may limit results. If you get limited results, note how many you received.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Search for any available knowledge and tell me how many results you found.' }]
          }
        ],
        vectorContext: vectorConfig,
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const response = await runLlm(attachLangfuseObservability(spec as any, traceId));
      expect(response.content).toBeDefined();
      expectNoVectorErrors(response);

      const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 90000, testFileBase: TEST_FILE });
      const traceText = stringifyLangfuseTrace(trace);
      expect(traceText).toContain('vector_search');
      expect(traceText).toMatch(/"toolCalls"\s*:\s*\[\s*\{/);
    }, liveTestTimeout(120000));
  });

  describe('filter lock enforcement', () => {
    test('enforces locked filter to restrict results', async () => {
      const specWithoutFilter = {
        systemPrompt: 'Use the search tool to find information. Report exactly what text you found.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Search for "ultimate question" and tell me what you find.' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: testCollection,
          mode: 'tool',
          topK: 5,
          toolDescription: 'Search the knowledge base for information'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const responseWithoutFilter = await runLlm(specWithoutFilter);
      const unfilteredText = (responseWithoutFilter?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase())
        .join('\n');
      expect(unfilteredText.includes('42') || unfilteredText.includes('ultimate') || unfilteredText.includes('life')).toBe(true);
      expectNoVectorErrors(responseWithoutFilter);

      const specWithFilter = {
        systemPrompt: 'Use the search tool to find information. Report exactly what text you found.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Search for "ultimate question" and tell me what you find.' }]
          }
        ],
        vectorContext: {
          stores: ['qdrant-cloud'],
          collection: testCollection,
          mode: 'tool',
          topK: 5,
          locks: {
            filter: { category: 'technology' }
          },
          toolDescription: 'Search the knowledge base for information'
        },
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const responseWithFilter = await runLlm(specWithFilter);
      const filteredText = (responseWithFilter?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase())
        .join('\n');
      const foundPhilosophyContent = filteredText.includes('42') && filteredText.includes('ultimate');
      expect(foundPhilosophyContent).toBe(false);
      expectNoVectorErrors(responseWithFilter);
    }, liveTestTimeout(180000));
  });

  describe('scoreThreshold lock enforcement', () => {
    test('enforces locked scoreThreshold', async () => {
      const vectorConfig = {
        stores: ['qdrant-cloud'],
        collection: testCollection,
        mode: 'tool',
        topK: 10,
        locks: { scoreThreshold: 0.99 },
        toolDescription: 'Search the knowledge base for information'
      };

      const spec = {
        systemPrompt: 'Use the search tool. If no relevant results are found, say "No relevant results found."',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Search for something random like "purple elephants dancing".' }]
          }
        ],
        vectorContext: vectorConfig,
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 200 }
      };

      const response = await runLlm(spec);
      expect(response.content).toBeDefined();
      expectNoVectorErrors(response);
    }, liveTestTimeout(120000));
  });

  describe('store lock enforcement', () => {
    test('uses locked store regardless of schema', async () => {
      const vectorConfig = {
        stores: ['qdrant-cloud', 'memory'],
        collection: testCollection,
        mode: 'tool',
        topK: 3,
        locks: { store: 'qdrant-cloud' },
        toolDescription: 'Search knowledge bases. Available: qdrant-cloud, memory'
      };

      const spec = {
        systemPrompt: 'You have a search tool. Use it to find information.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'What is the meaning of life according to your knowledge base?' }]
          }
        ],
        vectorContext: vectorConfig,
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const response = await runLlm(spec);
      const text = (response?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase())
        .join('\n');
      expect(text.includes('42') || text.includes('life') || text.includes('answer') || text.includes('question')).toBe(true);
      expectNoVectorErrors(response);
    }, liveTestTimeout(180000));
  });

  describe('multiple locks combined', () => {
    test('enforces all locks simultaneously', async () => {
      const vectorConfig = {
        stores: ['qdrant-cloud'],
        collection: testCollection,
        mode: 'tool',
        topK: 10,
        locks: {
          topK: 2,
          filter: { relevance: 'high' },
          scoreThreshold: 0.5
        },
        toolDescription: 'Search for information'
      };

      const spec = {
        systemPrompt: 'Use the search tool to find information. Report what you found.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Search for information about life or technology.' }]
          }
        ],
        vectorContext: vectorConfig,
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const response = await runLlm(spec);
      const text = (response?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase())
        .join('\n');
      expect(
        text.includes('42') ||
          text.includes('life') ||
          text.includes('artificial') ||
          text.includes('ai') ||
          text.includes('humanity')
      ).toBe(true);
      expectNoVectorErrors(response);
    }, liveTestTimeout(180000));
  });

  describe('schema generation with locks', () => {
    test('tool schema omits locked parameters but tool still works', async () => {
      const vectorConfig = {
        stores: ['qdrant-cloud'],
        collection: testCollection,
        mode: 'tool',
        locks: {
          topK: 3,
          store: 'qdrant-cloud'
        },
        toolDescription: 'Search the knowledge base. Only query parameter is available.'
      };

      const spec = {
        systemPrompt: 'You have a search tool. Use it with just a query.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Search for information about artificial intelligence.' }]
          }
        ],
        vectorContext: vectorConfig,
        llmPriority: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
        settings: { temperature: 0, maxTokens: 300 }
      };

      const traceId = createTraceId('19-vector-search-locks-schema');
      const response = await runLlm(attachLangfuseObservability(spec as any, traceId));
      const text = (response?.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => String(c.text || '').toLowerCase())
        .join('\n');
      expect(
        text.includes('artificial') || text.includes('ai') || text.includes('intelligence') || text.includes('future')
      ).toBe(true);
      expectNoVectorErrors(response);

      const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 90000, testFileBase: TEST_FILE });
      const traceText = stringifyLangfuseTrace(trace);
      expect(traceText).toContain('vector_search');
      expect(traceText).toMatch(/"toolCalls"\s*:\s*\[\s*\{/);
    }, liveTestTimeout(180000));
  });
});
