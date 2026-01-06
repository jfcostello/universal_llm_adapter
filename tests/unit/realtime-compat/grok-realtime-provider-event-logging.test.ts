import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';

import type { RealtimeEvent } from '@/kernel/index.ts';
import { AsyncQueue } from '@/kernel/index.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

type TransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'error'; error: unknown; code?: string }
  | { type: 'close' };

function createFakeTransport() {
  const q = new AsyncQueue<TransportEvent>();
  const sent: any[] = [];
  let closed = false;

  return {
    sent,
    push: (evt: TransportEvent) => q.push(evt),
    close: () => {
      if (closed) return;
      closed = true;
      q.push({ type: 'close' });
      q.close();
    },
    transport: {
      send: (data: string) => {
        sent.push(JSON.parse(data));
      },
      events: () => q.iterate(),
      close: () => {
        if (closed) return;
        closed = true;
        q.push({ type: 'close' });
        q.close();
      }
    }
  };
}

async function waitForEvent<T extends RealtimeEvent = RealtimeEvent>(
  iter: AsyncIterator<RealtimeEvent>,
  predicate: (value: RealtimeEvent) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const next = await iter.next();
    if (next.done) throw new Error('session events closed');
    if (predicate(next.value as any)) return next.value as any;
  }
  throw new Error('timed out waiting for event');
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => process.nextTick(resolve));
  await new Promise<void>(resolve => process.nextTick(resolve));
}

function busyWaitMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin
  }
}

function readRealtimeLogLines(cwd: string): any[] {
  const dir = path.join(cwd, 'logs', 'realtime');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
  if (files.length === 0) return [];
  const content = fs.readFileSync(path.join(dir, files[0] as string), 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('realtime-compat/grok — provider event logging', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  const provider: any = {
    id: 'grok',
    compat: 'grok',
    endpoint: { urlTemplate: 'wss://api.x.ai/v1/realtime', headers: { Authorization: 'Bearer sk' } },
    metadata: { defaultVoice: 'ara' }
  };

  test('disabled by default: does not emit provider-event logs', async () => {
    await withTempCwd('grok-rt-provider-log-disabled', async (cwd) => {
      delete process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS;
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';

      await jest.isolateModulesAsync(async () => {
        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        await flush();

        const lines = readRealtimeLogLines(cwd);
        expect(lines.length).toBe(0);

        await session.close();
      });
    });
  });

  test('redacts audio payloads and stops logging after the configured window', async () => {
    await withTempCwd('grok-rt-provider-log-enabled', async (cwd) => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '5000';

      await jest.isolateModulesAsync(async () => {
        const baseNow = Date.now();
        const now = jest.spyOn(Date, 'now').mockImplementation(() => baseNow);

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        await flush();

        // Force the follow-up provider events to arrive after the configured window.
        now.mockImplementation(() => baseNow + 6000);
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'BB==' }) });
        await flush();
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'CC==' }) });
        await flush();

        const logging = await import('@/modules/logging/index.ts');
        await logging.closeLogger();

        const lines = readRealtimeLogLines(cwd);
        const providerLogs = lines.filter(l => l?.message === 'realtime.provider_event');
        expect(providerLogs).toHaveLength(1);

        const first = providerLogs[0];
        expect(first?.data?.providerEvent?.type).toBe('response.output_audio.delta');
        expect(first?.data?.providerEvent?.delta).toBe('[REDACTED_BASE64]');

        const content = JSON.stringify(providerLogs);
        expect(content).not.toContain('AA==');
        expect(content).not.toContain('BB==');
        expect(content).not.toContain('CC==');

        await session.close();
      });
    });
  });

  test('logs non-object provider payloads and reuses the logger within the window', async () => {
    await withTempCwd('grok-rt-provider-log-varied', async (cwd) => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '5000';

      await jest.isolateModulesAsync(async () => {
        const baseNow = Date.now();
        jest.spyOn(Date, 'now').mockImplementation(() => baseNow);

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        fake.push({ type: 'message', data: JSON.stringify('hi') });
        fake.push({ type: 'message', data: JSON.stringify([1, 2, 3]) });
        await flush();

        const logging = await import('@/modules/logging/index.ts');
        await logging.closeLogger();

        const lines = readRealtimeLogLines(cwd);
        const providerLogs = lines.filter(l => l?.message === 'realtime.provider_event');
        expect(providerLogs).toHaveLength(2);
        expect(providerLogs[0]?.data?.providerEvent).toBe('hi');
        expect(providerLogs[1]?.data?.providerEvent).toEqual([1, 2, 3]);

        await session.close();
      });
    });
  });

  test('best-effort: logger initialization failure does not break the session', async () => {
    await withTempCwd('grok-rt-provider-log-logger-failure', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '0';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '50';

      await jest.isolateModulesAsync(async () => {
        let getRealtimeLogger: any;
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: (getRealtimeLogger = jest.fn(() => {
            throw new Error('boom');
          }))
        }));

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        fake.push({ type: 'message', data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
        await waitForEvent(it, e => e.type === 'user_speech.started');

        // Provider-event logging runs async; allow the background drain to attempt logger init.
        await flush();
        expect(getRealtimeLogger).toHaveBeenCalled();

        await session.close();
      });
    });
  });

  test('non-blocking: logger init hang does not stall the transport loop', async () => {
    await withTempCwd('grok-rt-provider-log-non-blocking', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '500';

      await jest.isolateModulesAsync(async () => {
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: jest.fn(async () => await new Promise(() => {}))
        }));

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        // First event triggers provider-event logging (logger init hangs).
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        // Second event should still be processed and mapped immediately.
        fake.push({ type: 'message', data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });

        await waitForEvent(it, e => e.type === 'user_speech.started', 200);

        await session.close();
      });
    });
  });

  test('expiry: drain drops queued provider events when time exceeds until (without relying on timers)', async () => {
    await withTempCwd('grok-rt-provider-log-expiry-drain-check', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '1000';

      await jest.isolateModulesAsync(async () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: jest.fn(() => logger)
        }));

        const baseNow = Date.now();
        const now = jest.spyOn(Date, 'now').mockImplementation(() => baseNow);

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        await flushMicrotasks();

        // Force the drain to observe "now > until" without waiting for the expiry timer.
        now.mockImplementation(() => baseNow + 5000);

        await flush();
        await flush();

        const providerEventCalls = (logger.info as any).mock.calls.filter((c: any[]) => c[0] === 'realtime.provider_event');
        expect(providerEventCalls).toHaveLength(0);

        const warnCalls = (logger.warn as any).mock.calls.filter(
          (c: any[]) => c[0] === 'realtime.provider_event.dropped' && c?.[1]?.sessionId === sessionId
        );
        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0]?.[1]).toEqual(
          expect.objectContaining({
            droppedTotal: expect.any(Number),
            droppedDueToExpiry: expect.any(Number)
          })
        );
        expect(warnCalls[0]?.[1]?.droppedDueToExpiry).toBeGreaterThan(0);

        await session.close();
      });
    });
  });

  test('expiry: mid-drain window expiry stops logging and emits a drop warning', async () => {
    await withTempCwd('grok-rt-provider-log-expiry-mid-drain', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '1000';

      await jest.isolateModulesAsync(async () => {
        const baseNow = Date.now();
        const now = jest.spyOn(Date, 'now').mockImplementation(() => baseNow);
        const logger = {
          info: jest.fn(() => {
            // Force the drain loop to observe an expired window on the next iteration.
            now.mockImplementation(() => baseNow + 5000);
          }),
          warn: jest.fn()
        };

        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: jest.fn(() => logger)
        }));

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'BB==' }) });
        await flush();
        await flush();

        const providerEventCalls = (logger.info as any).mock.calls.filter((c: any[]) => c[0] === 'realtime.provider_event');
        expect(providerEventCalls).toHaveLength(1);

        const warnCalls = (logger.warn as any).mock.calls.filter(
          (c: any[]) => c[0] === 'realtime.provider_event.dropped' && c?.[1]?.sessionId === sessionId
        );
        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0]?.[1]).toEqual(expect.objectContaining({ droppedDueToExpiry: expect.any(Number) }));
        expect(warnCalls[0]?.[1]?.droppedDueToExpiry).toBeGreaterThan(0);

        await session.close();
      });
    });
  });

  test('expiry: transport loop expires window without scheduling drain when no events were queued', async () => {
    await withTempCwd('grok-rt-provider-log-expiry-no-drops', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '10';

      await jest.isolateModulesAsync(async () => {
        const getRealtimeLogger = jest.fn();
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger
        }));

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        // Block timers so the expiry handler can't run yet.
        busyWaitMs(25);

        // First provider event arrives after the window; the session should expire the window without
        // loading the logger (since there are no queued events/drops to flush).
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        await flushMicrotasks();

        expect(getRealtimeLogger).not.toHaveBeenCalled();

        await session.close();
      });
    });
  });

  test('expiry: transport loop expires window and attempts to schedule a drop-warning drain when drops exist', async () => {
    await withTempCwd('grok-rt-provider-log-expiry-transport-schedules-drain', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '5000';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MAX_QUEUE = '1';

      await jest.isolateModulesAsync(async () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        let resolveLogger: ((value: any) => void) | undefined;
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: jest.fn(async () => new Promise((resolve) => {
            resolveLogger = resolve;
          }))
        }));

        const baseNow = Date.now();
        const now = jest.spyOn(Date, 'now').mockImplementation(() => baseNow);

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        // Fill the queue (1) and create a dropped-event counter (2nd event).
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'BB==' }) });
        await flushMicrotasks();

        // Force the follow-up provider event to arrive after the configured window.
        now.mockImplementation(() => baseNow + 6000);

        // This provider event arrives after the window; it should trigger the transport-loop expiry path,
        // which attempts to schedule a drain so the dropped-event warning can be emitted once the logger
        // becomes available.
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'CC==' }) });
        await flushMicrotasks();

        resolveLogger?.(logger);
        await flush();
        await flush();

        const warnCalls = (logger.warn as any).mock.calls.filter(
          (c: any[]) => c[0] === 'realtime.provider_event.dropped' && c?.[1]?.sessionId === sessionId
        );
        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0]?.[1]?.droppedTotal).toBeGreaterThan(0);

        await session.close();
      });
    });
  });

  test('expiry: drops queued provider-event logs when the window ends (even if drain is backlogged)', async () => {
    await withTempCwd('grok-rt-provider-log-expiry-backlog', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '20';

      await jest.isolateModulesAsync(async () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 60));
            return logger;
          })
        }));

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        await waitForEvent(it, e => e.type === 'ready');

        for (let i = 0; i < 200; i++) {
          fake.push({
            type: 'message',
            data: JSON.stringify({ type: 'response.output_audio.delta', delta: `${i}` })
          });
        }

        // Wait for logger init to resolve (after the log window expires) and allow drains to run.
        await new Promise(resolve => setTimeout(resolve, 90));
        await flush();
        await flush();

        const providerEventCalls = (logger.info as any).mock.calls.filter((c: any[]) => c[0] === 'realtime.provider_event');
        expect(providerEventCalls).toHaveLength(0);

        await session.close();
      });
    });
  });

  test('tunables: respects max queue and emits one dropped-event warning per session', async () => {
    await withTempCwd('grok-rt-provider-log-tunables', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '500';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MAX_QUEUE = '5';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_BATCH_SIZE = '2';

      await jest.isolateModulesAsync(async () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
            return logger;
          })
        }));

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        const ready = await waitForEvent(it, e => e.type === 'ready');
        const sessionId = (ready as any).sessionId;

        for (let i = 0; i < 100; i++) {
          fake.push({
            type: 'message',
            data: JSON.stringify({ type: 'response.output_audio.delta', delta: `${i}` })
          });
        }

        await new Promise(resolve => setTimeout(resolve, 120));
        await flush();
        await flush();

        const providerEventCalls = (logger.info as any).mock.calls.filter((c: any[]) => c[0] === 'realtime.provider_event');
        expect(providerEventCalls.length).toBeLessThanOrEqual(5);

        const droppedWarnCalls = (logger.warn as any).mock.calls.filter(
          (c: any[]) => c[0] === 'realtime.provider_event.dropped' && c?.[1]?.sessionId === sessionId
        );
        expect(droppedWarnCalls).toHaveLength(1);
        expect(droppedWarnCalls[0]?.[1]).toEqual(expect.objectContaining({ droppedTotal: expect.any(Number) }));
        expect(droppedWarnCalls[0]?.[1]?.droppedTotal).toBeGreaterThan(0);

        await session.close();
      });
    });
  });

  test('bounded: drops provider-event logs when overwhelmed', async () => {
    await withTempCwd('grok-rt-provider-log-bounded', async () => {
      process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '500';

      await jest.isolateModulesAsync(async () => {
        const logger = { info: jest.fn() };
        jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
          getRealtimeLogger: jest.fn(() => logger)
        }));

        const { createGrokRealtimeCompatSessionWithTransport } = await import(
          '@/plugins/realtime-compat/grok/internal/session-core.ts'
        );

        const fake = createFakeTransport();
        const session = createGrokRealtimeCompatSessionWithTransport(
          { provider, spec: { provider: 'grok' } as any } as any,
          fake.transport as any
        );

        const it = session.events()[Symbol.asyncIterator]();
        fake.push({ type: 'open' });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
        fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
        await waitForEvent(it, e => e.type === 'ready');

        const eventCount = 5000;
        for (let i = 0; i < eventCount; i++) {
          fake.push({
            type: 'message',
            data: JSON.stringify({ type: 'response.output_audio.delta', delta: `${i}` })
          });
        }

        // Allow background drains to run.
        await flush();
        await flush();

        expect(logger.info).toHaveBeenCalled();
        expect((logger.info as any).mock.calls.length).toBeLessThan(eventCount);

        await session.close();
      });
    });
  });
});
