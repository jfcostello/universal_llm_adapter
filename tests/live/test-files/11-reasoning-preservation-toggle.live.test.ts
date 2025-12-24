// 11 — Reasoning Preservation Toggle
//
// This test verifies that:
// 1. When reasoning is enabled, the reasoning config is SENT in the request payload
// 2. When reasoning is enabled, the response may contain reasoning (provider-dependent)
// 3. When reasoning is disabled, we don't require reasoning in the response
//
// IMPORTANT: This test was hardened after issue #73 where reasoning settings were
// accepted but NOT sent in the request payload. Now we verify the REQUEST, not just the RESPONSE.

import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns } from '../config.ts';
import { withLiveEnv, makeSpec, mergeSettings, buildLogPathFor, parseLogBodies } from '@tests/helpers/live-v2.ts';
import { attachLangfuseObservability, createTraceId, waitForLangfuseTrace, stringifyLangfuseTrace } from '@tests/helpers/langfuse.ts';
import fs from 'fs';
import path from 'path';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '11-reasoning-preservation-toggle';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCoordinatorWithRetries(options: {
  spec: any;
  env: NodeJS.ProcessEnv;
  attempts?: number;
  beforeAttempt?: () => void;
}): Promise<Awaited<ReturnType<typeof runCoordinator>>> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  let last: Awaited<ReturnType<typeof runCoordinator>> | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.beforeAttempt?.();
    const result = await runCoordinator({
      args: ['run', '--spec', JSON.stringify(options.spec), '--plugins', pluginsPath],
      cwd: process.cwd(),
      env: options.env
    });

    if (result.code === 0) return result;
    last = result;

    // Backoff for transient failures (network, provider hiccups, etc). Still fails if retries are exhausted.
    await sleep(500 * attempt);
  }

  const stderr = String(last?.stderr || '');
  const stdout = String(last?.stdout || '');
  throw new Error(
    `Coordinator failed after ${attempts} attempt(s) (exit ${last?.code ?? 'unknown'}).\n\n` +
      `STDERR:\n${stderr}\n\nSTDOUT:\n${stdout}`
  );
}

/**
 * Check if a request body contains reasoning configuration.
 * Different providers use different formats:
 * - OpenRouter/OpenAI: { reasoning: { ... } } (HTTP payload)
 * - Anthropic: { thinking: { ... } } (HTTP payload)
 * - Google: { thinkingConfig: { ... } } (SDK) OR { settings.reasoning } (logged internal format)
 *
 * Note: SDK-based providers (like Google) log the internal spec format, not the
 * serialized SDK payload. So we also check settings.reasoning for SDK calls.
 */
function requestHasReasoningConfig(body: any): boolean {
  // OpenRouter/OpenAI format (HTTP payload)
  if (body.reasoning && typeof body.reasoning === 'object') {
    return true;
  }
  // Anthropic format (HTTP payload)
  if (body.thinking && typeof body.thinking === 'object') {
    return true;
  }
  // Google SDK format (if present in logs)
  if (body.generationConfig?.thinkingConfig) {
    return true;
  }
  // SDK-based providers log the internal spec format which has settings.reasoning
  // This is the format we log for Google since we can't intercept the SDK's actual HTTP call
  if (body.settings?.reasoning?.enabled === true && body.settings?.reasoning?.budget !== undefined) {
    return true;
  }
  return false;
}

for (let i = 0; i < testRuns.length; i++) {
  const runCfg = testRuns[i];
  (runLive ? describe : describe.skip)(`11-reasoning-preservation-toggle — ${runCfg.name}`, () => {
    test('Call 1 — reasoning ON: verify request payload contains reasoning config', async () => {
      const traceId = createTraceId(`11-reasoning-preservation-toggle-${runCfg.name}-call-1`);
      const logPath = buildLogPathFor(TEST_FILE);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const resetLog = () => fs.writeFileSync(logPath, '');
      resetLog();

      const spec = attachLangfuseObservability(makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Answer concisely and include internal reasoning if supported.' }]},
          { role: 'user', content: [{ type: 'text', text: 'What is 3 + 4?' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { temperature: 0.2, maxTokens: 200, reasoning: { enabled: true, budget: 1024 } })
      }) as any, traceId);
      const result = await runCoordinatorWithRetries({
        spec,
        env: withLiveEnv({ TEST_FILE }),
        attempts: 3,
        beforeAttempt: resetLog
      });

      // CRITICAL: Verify the REQUEST payload contains reasoning configuration
      // This is the key check that was missing in the original test (issue #73)
      const bodies = parseLogBodies(logPath);

      // Find outgoing request bodies (supports both messages-based payloads and responses-style input payloads).
      const requestBodies = bodies.filter(b => b?.model && (b?.messages || b?.input || b?.settings));
      expect(requestBodies.length).toBeGreaterThan(0);

      // This is the fix for issue #73 - we now verify reasoning is SENT in the request
      expect(requestBodies.some(requestHasReasoningConfig)).toBe(true);

      // Also check the response (original test behavior, but now secondary)
      const payload = JSON.parse(result.stdout.trim());
      if (payload.reasoning && typeof payload.reasoning.text === 'string') {
        expect(payload.reasoning.redacted === true || payload.reasoning.text.length > 0).toBe(true);
      }
      // Note: We don't fail if response doesn't have reasoning - some providers
      // don't return reasoning in the response even when requested

      const trace = await waitForLangfuseTrace(traceId, { timeoutMs: 90000, testFileBase: TEST_FILE });
      const traceText = stringifyLangfuseTrace(trace);
      expect(traceText).toContain('What is 3 + 4?');
      const hasReasoningEvidence =
        traceText.includes('requestPayload') ||
        traceText.includes('"reasoning"') ||
        traceText.includes('"thinking"') ||
        traceText.includes('thinkingConfig');
      expect(hasReasoningEvidence).toBe(true);
    }, 120000);

    test('Call 2 — reasoning OFF: verify no reasoning in response required', async () => {
      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Answer concisely.' }]},
          { role: 'user', content: [{ type: 'text', text: 'What is 6 + 7?' }]}
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { temperature: 0.2, maxTokens: 200, reasoning: { enabled: false } })
      });
      const result = await runCoordinatorWithRetries({
        spec,
        env: withLiveEnv({ TEST_FILE }),
        attempts: 3
      });
      const payload = JSON.parse(result.stdout.trim());
      // When reasoning is OFF, we accept any response (provider-dependent behavior)
      expect(payload).toBeDefined();
    }, 120000);
  });
}
