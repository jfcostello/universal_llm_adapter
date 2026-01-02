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
        await waitForEvent(it, e => e.type === 'ready');

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
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '20';

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
        await waitForEvent(it, e => e.type === 'ready');

        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        await flush();

        await new Promise(resolve => setTimeout(resolve, 30));
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
      process.env.LLM_ADAPTER_REALTIME_LOG_PROVIDER_EVENTS_MS = '200';

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
        await waitForEvent(it, e => e.type === 'ready');

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
        await waitForEvent(it, e => e.type === 'ready');

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
        await waitForEvent(it, e => e.type === 'ready');

        // First event triggers provider-event logging (logger init hangs).
        fake.push({ type: 'message', data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AA==' }) });
        // Second event should still be processed and mapped immediately.
        fake.push({ type: 'message', data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });

        await waitForEvent(it, e => e.type === 'user_speech.started', 200);

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
