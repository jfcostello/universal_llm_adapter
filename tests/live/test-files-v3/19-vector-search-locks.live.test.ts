import fs from 'fs';
import path from 'path';
import { buildLogPathFor, parseLogBodies, runLlmOnce, runVectorOnce, mergeSettings } from '@tests/helpers/live-v3.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '19-vector-search-locks';

const STORE_ID = 'qdrant-cloud';
const TOKEN = `VECTOR_LOCKS_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

function readOpenRouterEmbeddingProviderId(): string {
  const raw = fs.readFileSync(path.join(process.cwd(), 'plugins', 'embeddings', 'openrouter.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return String(parsed.id);
}

function extractTextFromMessage(msg: any): string {
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  return parts
    .filter((p: any) => p?.type === 'text')
    .map((p: any) => String(p.text || ''))
    .join('');
}

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  const runCfg = filteredTestRuns[0];
  const embeddingProviderId = readOpenRouterEmbeddingProviderId();
  const collection = `v3_${TEST_FILE}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  beforeAll(async () => {
    expect(runCfg).toBeTruthy();

    const { result: createResult, response: createRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'collections_create',
      spec: {
        operation: 'collections',
        store: STORE_ID,
        input: {
          collectionOp: 'create',
          collectionName: collection,
          dimensions: 1536,
          payloadIndexes: [{ field: 'relevance', type: 'keyword' }]
        }
      }
    });

    expect(createResult.code).toBe(0);
    expect(createRes?.success).toBe(true);

    const { result: seedResult, response: seedRes } = await runVectorOnce({
      testFileBase: TEST_FILE,
      testName: 'seed_embed',
      spec: {
        operation: 'embed',
        store: STORE_ID,
        collection,
        embeddingPriority: [{ provider: embeddingProviderId }],
        input: {
          chunks: [
            {
              id: 'fact-high',
              text: `Token ${TOKEN}: The meaning of life is 42.`,
              metadata: { relevance: 'high' }
            },
            {
              id: 'fact-low',
              text: `Token ${TOKEN}: The meaning of life is 41.`,
              metadata: { relevance: 'low' }
            }
          ]
        }
      }
    });

    expect(seedResult.code).toBe(0);
    expect(seedRes?.success).toBe(true);
  }, 180_000);

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
    } catch (error: any) {
      console.warn('Vector cleanup warning:', error?.message ?? String(error));
    }
  }, 60_000);

  test('locks hide schema params and enforce store/collection/topK/filter/scoreThreshold', async () => {
    expect(runCfg).toBeTruthy();

    const spec = {
      systemPrompt: [
        'You are a conformance test agent.',
        `Token: ${TOKEN}.`,
        'You MUST call the vector_search tool exactly once.',
        'After you receive tool results, reply with exactly: 42'
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Token=${TOKEN}. Use vector_search to answer: What is the meaning of life? Reply with exactly 42.`
            }
          ]
        }
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 120 }),
      toolChoice: { type: 'single', name: 'vector_search' },
      vectorContext: {
        // Intentionally wrong/unhelpful defaults (locks must override these).
        mode: 'tool',
        stores: ['memory', STORE_ID],
        collection: `wrong_collection_${TOKEN}`,
        topK: 10,
        filter: { relevance: 'low' },
        scoreThreshold: 0.99,

        locks: {
          store: STORE_ID,
          collection,
          topK: 1,
          filter: { relevance: 'high' },
          scoreThreshold: 0
        }
      }
    };

    const { result, response } = await runLlmOnce({
      testFileBase: TEST_FILE,
      testName: 'run',
      spec
    });

    expect(result.code).toBe(0);
    const finalText = (response?.content ?? [])
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p.text || ''))
      .join('')
      .trim();
    expect(finalText).toBe('42');

    const logPath = buildLogPathFor(TEST_FILE);
    const bodies = parseLogBodies(logPath);

    const normalizedRequests = bodies.filter((b: any) => b?.__liveType === 'normalized_llm_request');
    const requestForThisRun = normalizedRequests.find((b: any) => JSON.stringify(b?.messages ?? []).includes(TOKEN));
    expect(requestForThisRun).toBeTruthy();

    const tools = Array.isArray((requestForThisRun as any)?.tools) ? (requestForThisRun as any).tools : [];
    const vectorTool = tools.find((t: any) => t?.name === 'vector_search');
    expect(vectorTool).toBeTruthy();

    const schema = (vectorTool as any)?.parametersJsonSchema;
    const props = schema?.properties ?? {};
    expect(typeof props).toBe('object');
    expect(props.query).toBeTruthy();
    expect(props.topK).toBeUndefined();
    expect(props.store).toBeUndefined();
    expect(props.filter).toBeUndefined();
    expect(props.collection).toBeUndefined();
    expect(props.scoreThreshold).toBeUndefined();

    const toolMessages = (normalizedRequests.find((b: any) => {
      const msgs = Array.isArray(b?.messages) ? b.messages : [];
      return msgs.some((m: any) => m?.role === 'tool' && JSON.stringify(m?.content ?? []).includes('vector_search'));
    }) as any)?.messages;

    expect(Array.isArray(toolMessages)).toBe(true);

    const vectorToolMsg = (toolMessages as any[]).find((m: any) => {
      if (m?.role !== 'tool') return false;
      const parts = Array.isArray(m?.content) ? m.content : [];
      return parts.some((p: any) => p?.type === 'tool_result' && p?.toolName === 'vector_search');
    });

    expect(vectorToolMsg).toBeTruthy();
    const toolText = extractTextFromMessage(vectorToolMsg);
    expect(toolText).toContain('Found 1 results');
    expect(toolText).toContain('The meaning of life is 42');
    expect(toolText).not.toContain('The meaning of life is 41');
  }, 240_000);
});
