import fs from 'fs';
import path from 'path';
import { buildLogPathFor, deleteVectorCollectionAndWaitForMissing, mergeSettings, parseLogBodies, runLlmOnce, runVectorOnce } from '@tests/helpers/live.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '18-vector-auto-inject';

const STORE_ID = 'qdrant-cloud';
const TOKEN = `AUTO_INJECT_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const SECRET = `AUTO_INJECT_SECRET_${Math.random().toString(16).slice(2, 8)}_${Math.random().toString(16).slice(2, 8)}`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
              text: `Marker ${TOKEN}. ReferenceCode: ${SECRET}. This is a synthetic test datum.`,
              metadata: { topic: 'life' }
            }
          ]
        }
      }
    });

    expect(seedResult.code).toBe(0);
    expect(seedRes?.success).toBe(true);

    // External vector stores can be eventually consistent; ensure the freshly upserted point is queryable
    // before running the LLM auto-inject path (which is intended to be deterministic).
    const waitForSeedVisible = async (timeoutMs: number) => {
      const startedAt = Date.now();
      let attempt = 0;

      while (Date.now() - startedAt < timeoutMs) {
        attempt += 1;

        const { result: queryResult, response: queryRes } = await runVectorOnce({
          testFileBase: TEST_FILE,
          testName: `seed_visible_${attempt}`,
          spec: {
            operation: 'query',
            store: STORE_ID,
            collection,
            embeddingPriority: [{ provider: embeddingProviderId }],
            settings: { includePayload: true },
            input: {
              query: TOKEN,
              topK: 1
            }
          }
        });

        const payloadText = String((queryRes as any)?.results?.[0]?.payload?.text ?? '');
        if (queryResult.code === 0 && queryRes?.success === true && payloadText.includes(TOKEN)) {
          return;
        }

        await sleep(250);
      }

      throw new Error('Timed out waiting for seeded vector chunk to become queryable');
    };

    await waitForSeedVisible(10_000);
  }, 180_000);

  afterAll(async () => {
    await deleteVectorCollectionAndWaitForMissing({
      testFileBase: TEST_FILE,
      store: STORE_ID,
      collectionName: collection,
      timeoutMs: 50_000
    });
  }, 60_000);

  test('auto-inject (auto mode) falls back when first storePriority attempt collection fails', async () => {
    expect(runCfg).toBeTruthy();

    const spec = {
      systemPrompt: [
        'You are a conformance test agent.',
        `Marker: ${TOKEN}.`,
        'You will receive retrieved context.',
        'From the retrieved context, extract the exact value after "ReferenceCode:" and reply with only that value.',
        'No extra whitespace. No punctuation. No code blocks.',
        'Do not include any reasoning or explanation. Reply with the code value immediately.'
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Marker=${TOKEN}. What is the ReferenceCode from retrieved context? Reply with the code value only.`
            }
          ]
        }
      ],
      llmPriority: runCfg.llmPriority,
      settings: mergeSettings(runCfg.settings, { maxTokens: 512 }),
      vectorContexts: [{
        mode: 'auto',
        stores: [STORE_ID],
        topK: 1,
        overrideEmbeddingQuery: TOKEN,
        injectAs: 'system',
        injectTemplate: `Relevant context for ${TOKEN}:\n{{results}}`,
        storePriority: {
          [STORE_ID]: {
            attempts: [
              {
                store: STORE_ID,
                collection: `wrong_collection_${TOKEN}`,
                embeddingPriority: [{ provider: embeddingProviderId }]
              },
              {
                store: STORE_ID,
                collection,
                embeddingPriority: [{ provider: embeddingProviderId }]
              }
            ]
          }
        }
      }]
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
  }, 180_000);
});
