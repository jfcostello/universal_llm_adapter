// 00 — Foundation: exact phrase + fallback; deterministic math; header redaction
import fs from 'fs';
import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns, invalidPriorityEntry } from '../config.ts';
import { withLiveEnv, buildLogPathFor, redactionFoundIn, makeSpec, mergeSettings, parseLogBodies } from '@tests/helpers/live-v2.ts';
import { attachLangfuseObservability, createTraceId, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';

function loadUsageCostTable(): Record<string, any> | null {
  const candidates = [
    './plugins/configs/usage-costs.json',
    './dist/plugins/configs/usage-costs.json'
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, any>;
    } catch {
      return null;
    }
  }
  return null;
}

function assertUsageCost(payload: any, usageCostEnabled: boolean): void {
  const usage = payload?.usage;
  if (!usage) return;

  const provider = payload?.provider;
  const model = payload?.model;
  const table = loadUsageCostTable();
  const hasRates = Boolean(table?.[provider]?.[model]);
  const hasTokens = typeof usage.promptTokens === 'number' && typeof usage.completionTokens === 'number';

  if (typeof usage.cost === 'number') {
    expect(Number.isFinite(usage.cost)).toBe(true);
    expect(usage.cost).toBeGreaterThanOrEqual(0);
    return;
  }

  if (usageCostEnabled && hasRates && hasTokens) {
    throw new Error(`Expected usage.cost to be computed for ${provider}/${model}`);
  }
}

function readCachedTokensFromBody(body: any): number | null {
  const cachedOpenAI = body?.usage?.prompt_tokens_details?.cached_tokens ??
    body?.usage?.input_tokens_details?.cached_tokens ??
    body?.usage?.input_token_details?.cached_tokens;
  if (typeof cachedOpenAI === 'number') return cachedOpenAI;

  const cachedAnthropicRead = body?.usage?.cache_read_input_tokens;
  const cachedAnthropicCreate = body?.usage?.cache_creation_input_tokens;
  if (typeof cachedAnthropicRead === 'number' || typeof cachedAnthropicCreate === 'number') {
    return (typeof cachedAnthropicRead === 'number' ? cachedAnthropicRead : 0) +
      (typeof cachedAnthropicCreate === 'number' ? cachedAnthropicCreate : 0);
  }

  const cachedGoogle = body?.usageMetadata?.cachedContentTokenCount;
  if (typeof cachedGoogle === 'number') return cachedGoogle;

  return null;
}

function assertCachedTokensExtracted(payload: any, logPath: string): void {
  const bodies = parseLogBodies(logPath);
  let cachedRaw: number | null = null;

  for (let i = bodies.length - 1; i >= 0; i--) {
    const candidate = readCachedTokensFromBody(bodies[i]);
    if (typeof candidate === 'number') {
      cachedRaw = candidate;
      break;
    }
  }

  if (cachedRaw === null) return;

  const cachedUnified = payload?.usage?.cachedTokens;
  if (typeof cachedUnified !== 'number') {
    throw new Error('Expected usage.cachedTokens to be set when cached tokens are present in the raw response');
  }
  if (cachedUnified !== cachedRaw) {
    throw new Error(`Expected usage.cachedTokens to equal ${cachedRaw}, got ${cachedUnified}`);
  }
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];

  (runLive ? describe : describe.skip)(`00-foundation — ${runCfg.name}`, () => {
    async function waitForFile(p: string, timeoutMs = 8000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(p)) return;
        await new Promise(res => setTimeout(res, 100));
      }
      throw new Error(`Timed out waiting for log file: ${p}`);
    }

    test('Call 1: exact phrase, fallback, extras log, header redaction', async () => {
      const testFileBase = '00-foundation';
      const env = withLiveEnv({ TEST_FILE: testFileBase });

      const traceId = createTraceId(`${testFileBase}-${runCfg.name}-call-1`);
      const spec = attachLangfuseObservability(makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Reply with exactly: INTEGRATION_TEST_OK' }]},
          { role: 'user', content: [{ type: 'text', text: 'Reply now.' }]}
        ],
        llmPriority: [invalidPriorityEntry as any, ...runCfg.llmPriority],
        settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 60000, fakeField: 'fakeValue', usageCost: true }),
        functionToolNames: []
      }) as any, traceId);

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const text = payload.content?.[0]?.text || '';
      expect(text.includes('INTEGRATION_TEST_OK')).toBe(true);
      expect(payload.provider).toBe(runCfg.llmPriority[0].provider);
      assertUsageCost(payload, spec.settings?.usageCost === true);
      const extrasLogFound = result.logs.some(line => line.includes('Extra field not supported by provider') && line.includes('fakeField'));
      expect(extrasLogFound).toBe(true);
      const logPath = buildLogPathFor(testFileBase);
      await waitForFile(logPath, 8000);
      const logText = fs.readFileSync(logPath, 'utf-8');
      // SDK-based providers (URL starts with "SDK:") don't have HTTP headers to redact
      const isSDKBased = /Method:\s*SDK_CALL/.test(logText);
      if (!isSDKBased) {
        expect(redactionFoundIn(logText)).toBe(true);
      }
      assertCachedTokensExtracted(payload, logPath);

      const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 60000 });
      const traceText = stringifyLangfuseTrace(trace);
      expect(traceText).toContain('Reply now.');
      expect(traceText).toContain(payload.provider);
      expect(traceText).toContain(payload.model);
      if (Array.isArray((trace as any)?.input)) {
        expect((trace as any).input.length).toBeGreaterThan(0);
      } else {
        expect(traceText).toContain('INTEGRATION_TEST_OK');
      }
    }, 120000);

    test('Call 2: observability non-blocking on export failure', async () => {
      const testFileBase = '00-foundation';
      const env = withLiveEnv({ TEST_FILE: testFileBase });

      const traceId = createTraceId(`${testFileBase}-${runCfg.name}-call-2`);
      const spec: any = attachLangfuseObservability(makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Respond concisely. When a user asks a math question and says "reply with only the number", reply with only the number and no words.' }]},
          { role: 'user', content: [{ type: 'text', text: 'What is 2 + 2? Reply with only the number.' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { temperature: 0, maxTokens: 60000 }),
        functionToolNames: []
      }) as any, traceId);

      spec.observability = {
        ...(spec.observability ?? {}),
        // Flush deterministically and fail quickly
        flushAt: 2,
        maxAttempts: 1,
        timeoutMs: 250,
        // Route the exporter to an unreachable local endpoint; with LLM_LIVE=1, the compat permits overrides.
        providerConfig: { baseUrl: 'http://127.0.0.1:1' }
      };

      const result = await runCoordinator({
        args: ['run', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const text = String(payload.content?.[0]?.text ?? '').trim();
      expect(text).toBe('4');

      const combinedLogs = `${result.logs.join('\n')}\n${String(result.stderr || '')}`;
      const marker = 'Observability export failed after max attempts';
      let hasExportFailed = combinedLogs.includes(marker);

      // Server transport returns a snapshot of the server process logs; the observability failure
      // can be logged shortly after the response is returned. Poll the server log file directly
      // to avoid flakiness.
      if (!hasExportFailed && process.env.LLM_LIVE_TRANSPORT === 'server') {
        const serverLogPath = process.env.LLM_TEST_SERVER_PROCESS_LOG_PATH;
        if (serverLogPath) {
          const start = Date.now();
          const correlationNeedle = `\"correlationId\":\"${traceId}\"`;
          while (Date.now() - start < 10000) {
            if (fs.existsSync(serverLogPath)) {
              const serverText = fs.readFileSync(serverLogPath, 'utf-8');
              if (serverText.includes(marker) && serverText.includes(correlationNeedle)) {
                hasExportFailed = true;
                break;
              }
            }
            await new Promise(res => setTimeout(res, 200));
          }
        }
      }
      expect(hasExportFailed).toBe(true);
    }, 120000);
  });
}
