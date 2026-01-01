import { attachLangfuseObservability, createTraceId, waitForLangfuseTrace } from '@tests/helpers/langfuse.ts';
import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredRealtimeTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '38-realtime-observability-langfuse';

if (filteredRealtimeTestRuns.length === 0) {
  describeLive(`${TEST_FILE} — provider selection`, () => {
    test('requires a realtime provider selection', () => {
      throw new Error(
        'No realtime live test runs are selected. ' +
          'Set LLM_TEST_PROVIDERS=openai|google|grok (or unset it to run all realtime providers).'
      );
    });
  });
} else {
  for (const runCfg of filteredRealtimeTestRuns) {
    describeLive(`${TEST_FILE} — ${runCfg.name}`, () => {
      test('exports per-turn observability to Langfuse (traceId = first turn, grouped by sessionId)', async () => {
        const suffix = `${String(runCfg.name).replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}${Date.now().toString().slice(-4)}`;
        const token = `OBS_REALTIME_${suffix}`;
        const traceId = createTraceId(`${TEST_FILE}-${Date.now()}`);

        const spec = attachLangfuseObservability(
          {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt: [
              'You are a realtime conformance test agent.',
              'When asked to reply with a token, reply with the exact token and nothing else.'
            ].join('\n'),
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 60000, idleTimeoutMs: 20000, onTimeout: 'close' },
            metadata: { correlationId: `corr_${suffix}` }
          } as any,
          traceId
        );

        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec,
          steps: [
            { type: 'send_text', text: `Reply with exactly: ${token}`, role: 'user' },
            { type: 'commit' },
            { type: 'wait_for_event', eventType: 'assistant_transcript.final', timeoutMs: 30000 },
            { type: 'close' }
          ],
          timeoutMs: 30000
        });

        expect(result.code).toBe(0);

        // Verifies that our locally-logged observability content is present in the Langfuse trace.
        await waitForLangfuseTrace(traceId, {
          testFileBase: TEST_FILE,
          timeoutMs: 180_000,
          logTimeoutMs: 60_000
        });
      }, 240_000);
    });
  }
}

