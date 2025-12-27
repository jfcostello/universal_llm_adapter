import { jest } from '@jest/globals';
import { runRealtimeScenario } from '@tests/helpers/realtime-runner.ts';
import { withLiveEnv } from '@tests/helpers/live-v3.ts';
import { filteredRealtimeTestRuns } from '../config.ts';

import { createRealtimeSessionController } from '@/modules/realtime/internal/realtime-session.ts';

import type { RealtimeCompatSession, RealtimeEvent } from '@/kernel/index.ts';

const runLive = process.env.LLM_LIVE === '1';
const describeLive = runLive ? describe : describe.skip;
const pluginsPath = './plugins';
const TEST_FILE = '37-realtime-timeouts-buffer-overflow';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function collectAll<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

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

describeLive(`${TEST_FILE} — event buffer overflow`, () => {
  test('fails fast when consumer does not drain events()', async () => {
    const closed = createDeferred<void>();
    const compatClose = jest.fn().mockImplementation(async () => closed.resolve());

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: compatClose,
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        for (let i = 0; i < 10; i++) {
          yield { type: 'user_transcript.delta', textDelta: `d${i}` } as any;
        }
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) } as any,
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        eventBuffer: { maxEvents: 2 },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    // Do not drain events until after overflow triggers (simulates a stalled consumer).
    await closed.promise;

    const events = await collectAll(session.events());
    expect(events[0]).toEqual({
      type: 'error',
      message: 'Realtime event buffer overflow: consumer is not draining events()',
      code: 'event_buffer_overflow'
    });
    expect((events[1] as any)?.type).toBe('playback.clear_requested');
    expect((events[1] as any)?.reason).toBe('error');
    expect((events[2] as any)?.type).toBe('closed');
    expect((events[2] as any)?.reason).toBe('error');
  });
});

