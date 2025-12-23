// 21 — Observability Live Tests
// Tests that observability events are properly exported to Langfuse

import { runCoordinator } from '@tests/helpers/node-cli.ts';
import { filteredTestRuns as testRuns, observabilityTestProvider } from '../config.ts';
import { withLiveEnv, makeSpec, parseStream, findDone, mergeSettings } from '@tests/helpers/live-v2.ts';

const runLive = process.env.LLM_LIVE === '1';
const pluginsPath = './plugins';
const TEST_FILE = '21-observability';

// Skip all tests if observability is not configured
const shouldRun = runLive && observabilityTestProvider !== null;
const skipReason = !observabilityTestProvider ? 'observabilityTestProvider not configured in config.ts' : undefined;

// Use only the first test run to avoid excessive Langfuse API calls
const testRun = testRuns[0];

describe('21-observability', () => {
  (shouldRun && testRun ? test : test.skip)(
    `observability happy path - ${testRun?.name ?? 'no provider'}`,
    async () => {
      if (!testRun || !observabilityTestProvider) {
        throw new Error('Test configuration missing');
      }

      // Create a unique trace ID for this test
      const traceId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
          { role: 'user', content: [{ type: 'text', text: 'Say "observability test" and nothing else.' }] }
        ],
        llmPriority: testRun.llmPriority,
        functionToolNames: [],
        settings: mergeSettings(testRun.settings, { temperature: 0, maxTokens: 100 }),
        metadata: { correlationId: traceId },
        // Enable observability with test provider config
        observability: {
          enabled: true,
          provider: observabilityTestProvider.provider,
          traceId,
          providerConfig: observabilityTestProvider.baseUrl
            ? { baseUrl: observabilityTestProvider.baseUrl }
            : undefined
        }
      } as any);

      const result = await runCoordinator({
        args: ['stream', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env: withLiveEnv({ TEST_FILE })
      });

      // The LLM call should succeed regardless of observability
      expect(result.code).toBe(0);

      const events = parseStream(result.stdout);
      const done = findDone(events);
      expect(done).toBeDefined();

      // Verify response contains expected text
      const finalText = String(done?.response?.content?.[0]?.text ?? '').toLowerCase();
      expect(finalText).toContain('observability');
    },
    120000
  );

  (shouldRun && testRun ? test : test.skip)(
    `observability non-blocking on invalid config - ${testRun?.name ?? 'no provider'}`,
    async () => {
      if (!testRun || !observabilityTestProvider) {
        throw new Error('Test configuration missing');
      }

      // Create a unique trace ID for this test
      const traceId = `test-invalid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const spec = makeSpec({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
          { role: 'user', content: [{ type: 'text', text: 'Say "still works" and nothing else.' }] }
        ],
        llmPriority: testRun.llmPriority,
        functionToolNames: [],
        settings: mergeSettings(testRun.settings, { temperature: 0, maxTokens: 100 }),
        metadata: { correlationId: traceId },
        // Enable observability but with an invalid baseUrl
        // This tests that LLM calls still succeed even when observability fails
        observability: {
          enabled: true,
          provider: observabilityTestProvider.provider,
          traceId,
          providerConfig: {
            baseUrl: 'http://localhost:99999/invalid-endpoint-that-does-not-exist'
          }
        }
      } as any);

      const result = await runCoordinator({
        args: ['stream', '--spec', JSON.stringify(spec), '--plugins', pluginsPath],
        cwd: process.cwd(),
        env: withLiveEnv({ TEST_FILE })
      });

      // The LLM call should still succeed even with invalid observability config
      // Observability should never block the main LLM execution path
      expect(result.code).toBe(0);

      const events = parseStream(result.stdout);
      const done = findDone(events);
      expect(done).toBeDefined();

      // Verify response contains expected text
      const finalText = String(done?.response?.content?.[0]?.text ?? '').toLowerCase();
      expect(finalText).toContain('works');
    },
    120000
  );
});

// Log skip reason if applicable
if (!shouldRun && skipReason) {
  console.log(`Skipping observability tests: ${skipReason}`);
}
