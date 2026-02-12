import { attachSentryObservability, extractSentryTraceId, waitForSentryEventDetail } from '@tests/helpers/sentry.ts';
import { createTraceId } from '@tests/helpers/langfuse.ts';
import { runLlmOnce, mergeSettings, runTelemetryOnce } from '@tests/helpers/live.ts';
import { liveTestTimeout, filteredTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const TEST_FILE = '23-observability-sentry';

(runLive ? describe : describe.skip)(TEST_FILE, () => {
  test('exports tool result, tool error, and client signal to Sentry', async () => {
    const runCfg = filteredTestRuns[0];
    expect(runCfg).toBeTruthy();

    const traceId = createTraceId(`${TEST_FILE}-${Date.now()}`);
    const sessionId = traceId;

    const okToken = `SENTRY_TOOL_OK_${Date.now()}`;
    const clientSignalToken = `SENTRY_CLIENT_SIGNAL_${Date.now()}`;

    const systemPrompt = [
      'You are a conformance test agent.',
      'Follow the user instructions exactly.',
      'When instructed to call a tool, call it with the exact JSON arguments.',
      'Do not add any extra words.'
    ].join('\n');

    const prompt = [
      'You have access to tool test.echo.',
      `Step 1: Call tool test.echo with the EXACT JSON arguments: {"message":"${okToken}"}`,
      'Step 2: After you receive the tool result, call tool test.echo AGAIN with the EXACT JSON arguments: {"message":""}',
      'Step 3: After the tool loop ends, reply with exactly: SENTRY_OBS_OK'
    ].join('\n');

    const spec = attachSentryObservability(
      {
        messages: [
          { role: 'system', content: [{ type: 'text', text: systemPrompt } as any] },
          { role: 'user', content: [{ type: 'text', text: prompt } as any] }
        ],
        llmPriority: runCfg.llmPriority,
        settings: mergeSettings(runCfg.settings, {
          maxTokens: 512,
          maxToolIterations: 2,
          toolFinalPromptEnabled: true,
          parallelToolExecution: false
        }),
        functionToolNames: ['test.echo'],
        toolChoice: { type: 'single', name: 'test.echo' },
        observability: { sessionId }
      } as any,
      traceId,
      { sessionId, enableOtlp: false, providerConfig: { exportToolResultsAsSignals: true } }
    );

    const call = await runLlmOnce({ spec, testFileBase: TEST_FILE, testName: 'run' });
    expect(call.result.code).toBe(0);
    expect(call.response).toBeTruthy();

    const response: any = call.response as any;
    const toolResults = Array.isArray(response?.raw?.toolResults) ? response.raw.toolResults : [];
    expect(toolResults.length).toBeGreaterThanOrEqual(2);
    expect(toolResults.some((r: any) => r?.tool === 'test.echo')).toBe(true);
    expect(toolResults.some((r: any) => JSON.stringify(r?.result ?? {}).includes('[R:'))).toBe(true);
    expect(toolResults.some((r: any) => JSON.stringify(r?.result ?? {}).includes('tool_execution_failed'))).toBe(true);

    const telemetryPayload: any = {
      type: 'signal',
      traceId,
      level: 'error',
      message: clientSignalToken,
      observability: {
        enabled: true,
        traceId,
        sessionId,
        flushAt: 1,
        targets: [{ provider: 'sentry', export: { signals: true } }]
      }
    };

    const telemetry = await runTelemetryOnce({ payload: telemetryPayload, testFileBase: TEST_FILE, testName: 'client' });
    expect(telemetry.result.code).toBe(0);
    expect(telemetry.response?.queued).toBe(true);

    const project = String(process.env.SENTRY_PROJECT_SLUG || '').trim();
    expect(project).toBeTruthy();

    const clientEvent = await waitForSentryEventDetail({
      query: `project:${project} event.type:default "${clientSignalToken}"`,
      statsPeriod: '2h',
      match: (event) => String(event?.message || '').includes(clientSignalToken)
    });

    const traceIdHex = extractSentryTraceId(clientEvent);
    expect(typeof traceIdHex).toBe('string');
    expect(String(traceIdHex || '')).toMatch(/^[a-f0-9]{32}$/i);

    await waitForSentryEventDetail({
      query: `project:${project} event.type:default trace:${traceIdHex}`,
      statsPeriod: '2h',
      match: (event) => {
        const raw = JSON.stringify(event || {});
        return raw.includes('tool_loop') && raw.includes('test.echo');
      }
    });

    const expectedToolResult = `[R:${okToken.length}]${okToken.split('').reverse().join('')}`;
    await waitForSentryEventDetail({
      query: `project:${project} event.type:default trace:${traceIdHex}`,
      statsPeriod: '2h',
      match: (event) => JSON.stringify(event || {}).includes(expectedToolResult)
    });
  }, liveTestTimeout(420_000));
});
