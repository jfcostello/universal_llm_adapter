import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live.ts';
import { filteredRealtimeTestRuns } from '../config.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '37-realtime-timeouts-buffer-overflow';

if (filteredRealtimeTestRuns.length === 0) {
  describeLive(`${TEST_FILE} — provider selection`, () => {
      test('requires a realtime provider selection', () => {
        throw new Error(
          'No realtime live test runs are selected. ' +
          'Set LLM_TEST_PROVIDERS=openai|google|grok|vapi (or unset it to run all realtime providers).'
        );
      });
    });
  } else {
  for (const runCfg of filteredRealtimeTestRuns) {
    describeLive(`${TEST_FILE} — ${runCfg.name}`, () => {
      test('idle timeout emits timeout + playback.clear_requested(timeout) and closes', async () => {
        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec: {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt: 'Stay idle.',
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 60000, idleTimeoutMs: 1000, onTimeout: 'close' }
          },
          steps: [
            { type: 'wait_for_event', eventType: 'timeout', timeoutMs: 10000 },
            { type: 'wait_for_event', eventType: 'playback.clear_requested', timeoutMs: 10000 },
            { type: 'wait_for_event', eventType: 'closed', timeoutMs: 10000 }
          ],
          timeoutMs: 10000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const timeout = events.find((e: any) => e?.type === 'timeout');
        expect(timeout?.reason).toBe('idle');
        const clear = events.find((e: any) => e?.type === 'playback.clear_requested');
        expect(clear?.reason).toBe('timeout');
        const closed = events.find((e: any) => e?.type === 'closed');
        expect(closed?.reason).toBe('timeout');
      }, 240_000);

      test('max duration timeout emits timeout + playback.clear_requested(timeout) and closes', async () => {
        const result = await runRealtimeScenario({
          pluginsPath,
          cwd: process.cwd(),
          env: withLiveEnv({ TEST_FILE }),
          spec: {
            provider: runCfg.provider,
            model: runCfg.model,
            systemPrompt: 'Stay idle.',
            transcription: { enabled: true },
            turnDetection: { mode: 'manual_commit' },
            audio: {
              input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
              output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
            },
            timeout: { maxDurationMs: 1500, idleTimeoutMs: 0, onTimeout: 'close' }
          },
          steps: [
            { type: 'wait_for_event', eventType: 'timeout', timeoutMs: 10000 },
            { type: 'wait_for_event', eventType: 'playback.clear_requested', timeoutMs: 10000 },
            { type: 'wait_for_event', eventType: 'closed', timeoutMs: 10000 }
          ],
          timeoutMs: 10000
        });

        expect(result.code).toBe(0);
        const events = result.envelopes.filter(e => e.type === 'event').map(e => (e as any).event);
        const timeout = events.find((e: any) => e?.type === 'timeout');
        expect(timeout?.reason).toBe('max_duration');
        const clear = events.find((e: any) => e?.type === 'playback.clear_requested');
        expect(clear?.reason).toBe('timeout');
        const closed = events.find((e: any) => e?.type === 'closed');
        expect(closed?.reason).toBe('timeout');
      }, 240_000);
    });
  }
}
