import fs from 'fs';
import path from 'path';
import { buildLogPathFor, deleteVectorCollectionAndWaitForMissing, mergeSettings, parseLogBodies, runLlmOnce, runVectorOnce } from '@tests/helpers/live.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '18-vector-auto-inject';

const STORE_ID = 'qdrant-cloud';
const TOKEN = `AUTO_INJECT_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const SECRET = `AUTO_INJECT_SECRET_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

function readOpenRouterEmbeddingProviderId(): string {
  const raw = fs.readFileSync(path.join(process.cwd(), 'plugins', 'embeddings', 'openrouter.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return String(parsed.id);
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
          payloadIndexes: [{ field: 'topic', type: 'keyword' }]
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
              id: 'fact-meaning-of-life',
              text: `Marker ${TOKEN}. SecretAnswer: ${SECRET}.`,
              metadata: { topic: 'life' }
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

  test('auto-inject (both mode) inserts retrieved context and tool is available', async () => {
    expect(runCfg).toBeTruthy();

    const spec = {
      systemPrompt: [
        'You are a conformance test agent.',
        `Marker: ${TOKEN}.`,
        'You will receive retrieved context.',
        'From the retrieved context, extract the exact value after "SecretAnswer:" and reply with only that value.',
        'No extra whitespace. No punctuation. No code blocks.',
        'Do not include any reasoning or explanation. Reply with the secret token immediately.'
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Marker=${TOKEN}. What is the SecretAnswer from retrieved context? Reply with the secret token only.`
            }
          ]
        }
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 512 }),
      vectorContext: {
        mode: 'both',
        stores: [STORE_ID],
        collection,
        topK: 1,
        injectAs: 'system',
        injectTemplate: `Relevant context for ${TOKEN}:\n{{results}}`
      }
    };

    const { result, response } = await runLlmOnce({
      testFileBase: TEST_FILE,
      testName: 'run',
      spec
    });

    expect(result.code).toBe(0);
    const text = (response?.content ?? [])
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p.text || ''))
      .join('')
      .trim();
    expect(text).toBe(SECRET);

    const logPath = buildLogPathFor(TEST_FILE);
    const bodies = parseLogBodies(logPath);
    const normalized = bodies.filter((b: any) => b?.__liveType === 'normalized_llm_request');

    const thisRun = normalized.find((b: any) => {
      const msgs = Array.isArray(b?.messages) ? b.messages : [];
      return JSON.stringify(msgs).includes(TOKEN);
    });

    expect(thisRun).toBeTruthy();

    const tools = Array.isArray((thisRun as any)?.tools) ? (thisRun as any).tools : [];
    expect(tools.some((t: any) => t?.name === 'vector_search')).toBe(true);

    const msgs = Array.isArray((thisRun as any)?.messages) ? (thisRun as any).messages : [];
    const systemText = msgs
      .filter((m: any) => m?.role === 'system')
      .flatMap((m: any) => (Array.isArray(m?.content) ? m.content : []))
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p.text || ''))
      .join('\n');

    expect(systemText).toContain(`Relevant context for ${TOKEN}:`);
    expect(systemText).toContain(`SecretAnswer: ${SECRET}`);
  }, 180_000);
});
