import fs from 'fs';
import path from 'path';
import { buildLogPathFor, deleteVectorCollectionAndWaitForMissing, mergeSettings, parseLogBodies, runLlmOnce, runVectorOnce } from '@tests/helpers/live.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '19-vector-search-locks';

const STORE_ID = 'qdrant-cloud';
const TOKEN = `VECTOR_LOCKS_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const ANSWER_HIGH = 'VECTOR_LOCKS_ANSWER_HIGH_OK';
const ANSWER_LOW = 'VECTOR_LOCKS_ANSWER_LOW_OK';

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
  const collection = `live_${TEST_FILE}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

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
              text: `Token ${TOKEN}: The meaning of life is 42. AnswerToken=${ANSWER_HIGH}`,
              metadata: { relevance: 'high' }
            },
            {
              id: 'fact-low',
              text: `Token ${TOKEN}: The meaning of life is 41. AnswerToken=${ANSWER_LOW}`,
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
    await deleteVectorCollectionAndWaitForMissing({
      testFileBase: TEST_FILE,
      store: STORE_ID,
      collectionName: collection,
      timeoutMs: 50_000
    });
  }, 60_000);

  test('locks hide schema params and enforce store/topK/filter/scoreThreshold with queryPriority failure-only fallback', async () => {
    expect(runCfg).toBeTruthy();

    const spec = {
      systemPrompt: [
        'You are a conformance test agent.',
        `Token: ${TOKEN}.`,
        'You MUST call the vector_search tool exactly once.',
        'After the tool result arrives, extract the AnswerToken value (the text after "AnswerToken=") and remember it for your final output.',
        'If you receive a user message that begins with "All tool calls have been consumed", reply with ONLY the remembered AnswerToken value.',
        'Final output rules:',
        '- Output EXACTLY the AnswerToken value',
        '- No extra whitespace',
        '- No punctuation',
        '- Do NOT truncate or redact (no ellipses)',
        '- No code blocks',
        '- Do NOT call any tools after the tool result'
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Token=${TOKEN}. Use vector_search to answer: What is the meaning of life? Then reply with ONLY the AnswerToken value from the tool result.`
            }
          ]
        }
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, {
        // Some providers/models use a large reasoning budget when tools are enabled; keep enough headroom
        // so tool call arguments aren't truncated and rejected upstream.
        maxTokens: 512,
        maxToolIterations: 1,
        toolFinalPromptEnabled: true,
        parallelToolExecution: false
      }),
      toolChoice: { type: 'single', name: 'vector_search' },
      vectorContexts: [{
        // Intentionally wrong/unhelpful defaults (locks must override these).
        mode: 'tool',
        stores: ['memory', STORE_ID],
        collection: `wrong_collection_${TOKEN}`,
        topK: 10,
        filter: { relevance: 'low' },
        scoreThreshold: 0.99,
        queryPriority: [
          {
            stores: [STORE_ID],
            collection: `${collection}_missing_candidate`,
            embeddingPriority: [{ provider: embeddingProviderId, model: 'missing-model-for-query-priority-candidate' }]
          },
          {
            stores: [STORE_ID],
            collection,
            embeddingPriority: [{ provider: embeddingProviderId }]
          }
        ],

        locks: {
          store: STORE_ID,
          topK: 1,
          filter: { relevance: 'high' },
          scoreThreshold: 0
        }
      }]
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
    expect(finalText).toBe(ANSWER_HIGH);

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

    const requestWithToolMessage = normalizedRequests.find((b: any) => {
      const msgs = Array.isArray(b?.messages) ? b.messages : [];
      const json = JSON.stringify(msgs);
      if (!json.includes(TOKEN)) return false;
      return msgs.some((m: any) => m?.role === 'tool' && JSON.stringify(m?.content ?? []).includes('vector_search'));
    });

    const toolMessages = (requestWithToolMessage as any)?.messages;

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
    expect(toolText).toContain(ANSWER_HIGH);
    expect(toolText).not.toContain('The meaning of life is 41');
    expect(toolText).not.toContain(ANSWER_LOW);
  }, 240_000);
});
