import {
  attachLangfuseObservability,
  createTraceId,
  getLangfuseTraceTotalCost,
  waitForLangfuseTrace
} from '@tests/helpers/langfuse.ts';
import { runLlmOnce, mergeSettings } from '@tests/helpers/live.ts';
import { filteredTestRuns, liveTestTimeout } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '21-observability-cost-ingestion';

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('ingests provider cost into Langfuse trace totalCost', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const traceId = createTraceId(`${TEST_FILE}-${Date.now()}`);

    const baseSpec = attachLangfuseObservability(
      {
        systemPrompt: [
          'You are a conformance test agent.',
          'Reply with exactly: OBS_COST_INGESTION_OK'
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Reply with exactly: OBS_COST_INGESTION_OK' }]
          }
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, { maxTokens: 80 })
      } as any,
      traceId
    );

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
    expect(text).toBe('OBS_COST_INGESTION_OK');

    const cost = response?.usage?.cost;
    expect(typeof cost).toBe('number');
    expect(Number.isFinite(cost as number)).toBe(true);
    expect(cost as number).toBeGreaterThan(0);

    // Langfuse may expose the trace before cost aggregation settles; poll until totalCost reflects usage.cost.
    const deadlineMs = Date.now() + 120_000;
    let trace = await waitForLangfuseTrace(traceId);
    let totalCost = getLangfuseTraceTotalCost(trace);
    while ((totalCost ?? 0) <= 0 && Date.now() < deadlineMs) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      trace = await waitForLangfuseTrace(traceId, { assertLoggedContent: false, timeoutMs: 30_000 });
      totalCost = getLangfuseTraceTotalCost(trace);
    }

    expect(typeof totalCost).toBe('number');
    expect(totalCost as number).toBeGreaterThan(0);
    expect(totalCost as number).toBeGreaterThan((cost as number) * 0.5);
    expect(totalCost as number).toBeLessThan((cost as number) * 1.5);
  }, liveTestTimeout(300_000));
});
