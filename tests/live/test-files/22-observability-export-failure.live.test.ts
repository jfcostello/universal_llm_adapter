import { attachLangfuseObservability, createTraceId, waitForLangfuseTraceToBeMissing } from '@tests/helpers/langfuse.ts';
import { buildLogPathFor, parseLogBodies, runLlmOnce, mergeSettings } from '@tests/helpers/live.ts';
import { filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '22-observability-export-failure';

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('export failures do not fail the request (trace not published)', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const traceId = createTraceId(`${TEST_FILE}-${Date.now()}`);

    const baseSpec = attachLangfuseObservability(
      {
        systemPrompt: [
          'You are a conformance test agent.',
          'Reply with exactly: OBS_EXPORT_FAILURE_OK'
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Reply with exactly: OBS_EXPORT_FAILURE_OK' }]
          }
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { maxTokens: 80 })
      } as any,
      traceId
    );

    // Force the exporter to fail by overriding the ingestion base URL to an unreachable host.
    // This override is allowed in live runs (LLM_LIVE=1) specifically for failure-path testing.
    (baseSpec as any).observability = {
      ...(baseSpec as any).observability,
      providerConfig: { baseUrl: 'http://127.0.0.1:1' }
    };

    const { result, response } = await runLlmOnce({
      testFileBase: TEST_FILE,
      testName: 'run',
      spec: baseSpec as any
    });

    expect(result.code).toBe(0);
    const text = (response?.content ?? [])
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p.text || ''))
      .join('')
      .trim();
    expect(text).toBe('OBS_EXPORT_FAILURE_OK');

    // Ensure the adapter still recorded observability events locally (request + response).
    const logPath = buildLogPathFor(TEST_FILE);
    const bodies = parseLogBodies(logPath);
    const matching = bodies.filter((b: any) => b?.traceId === traceId);
    expect(matching.length).toBeGreaterThanOrEqual(2);

    // Verify the trace is NOT readable from Langfuse public API (export never succeeded).
    // Langfuse public API can intermittently 429; retry/backoff until we can verify.
    await waitForLangfuseTraceToBeMissing(traceId);
  }, 180_000);
});
