import { jest } from '@jest/globals';

import type { RealtimeEvent } from '@/kernel/index.ts';
import { AsyncQueue } from '@/kernel/index.ts';

import { createOpenAIRealtimeCompatSessionWithTransport } from '@/plugins/realtime-compat/openai/internal/session-core.ts';

type TransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'error'; error: unknown; code?: string }
  | { type: 'close' };

function createFakeTransport(options: { sendImpl?: (data: string) => void; closeImpl?: () => void } = {}) {
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
        if (options.sendImpl) {
          options.sendImpl(data);
          return;
        }
        sent.push(JSON.parse(data));
      },
      events: () => q.iterate(),
      close: () => {
        if (options.closeImpl) {
          options.closeImpl();
          return;
        }
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

describe('realtime-compat/openai — session core', () => {
  const provider: any = {
    id: 'openai',
    compat: 'openai',
    endpoint: { urlTemplate: 'wss://api.openai.com/v1/realtime', headers: { Authorization: 'Bearer sk' } },
    metadata: { defaultModel: 'gpt-realtime' }
  };

  test('handshake: unrefs ready fallback timer when supported', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const unrefSpy = jest.fn();
    const setTimeoutSpy = jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: any, ms: any, ...args: any[]) => {
        const timer: any = originalSetTimeout(fn, ms, ...args);
        if (timer && typeof timer.unref === 'function') {
          const originalUnref = timer.unref.bind(timer);
          timer.unref = (...unrefArgs: any[]) => {
            unrefSpy();
            return originalUnref(...unrefArgs);
          };
        }
        return timer;
      }) as any);

    const fake = createFakeTransport();

    const session = createOpenAIRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'openai', model: 'gpt-realtime', transcription: { enabled: true } } as any
      } as any,
      fake.transport as any
    );

    try {
      fake.push({ type: 'open' });
      for (let i = 0; i < 25 && unrefSpy.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      await session.close();
      setTimeoutSpy.mockRestore();
    }
  });

  test('handshake: sends session.update on open and emits ready on session.updated', async () => {
    const fake = createFakeTransport();

    const session = createOpenAIRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'openai', model: 'gpt-realtime', transcription: { enabled: true } } as any
      } as any,
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });

    await new Promise(res => setTimeout(res, 0));
    expect(fake.sent[0]?.type).toBe('session.update');

    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated', session: { id: 's1' } }) });
    const evt = await waitForEvent(it, e => e.type === 'ready');
    expect(evt.type).toBe('ready');

    await session.close();
  });

  test('handshake: emits ready if session.updated never arrives (fallback)', async () => {
    jest.useFakeTimers();
    const fake = createFakeTransport();

    const session = createOpenAIRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'openai', model: 'gpt-realtime', transcription: { enabled: true } } as any
      } as any,
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });

    // Allow the transport pump to process `open` (and schedule the fallback timer).
    for (let i = 0; i < 25 && fake.sent.length === 0; i++) {
      await Promise.resolve();
    }
    expect(fake.sent[0]?.type).toBe('session.update');
    jest.advanceTimersByTime(10_000);
    const evt = await waitForEvent(it, e => e.type === 'ready');
    expect(evt.type).toBe('ready');

    await session.close();
    jest.useRealTimers();
  });

  test('handshake: ignores duplicate open events when fallback is already scheduled', async () => {
    jest.useFakeTimers();
    const fake = createFakeTransport();

    const session = createOpenAIRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'openai', model: 'gpt-realtime', transcription: { enabled: true } } as any
      } as any,
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    for (let i = 0; i < 25 && fake.sent.length === 0; i++) {
      await Promise.resolve();
    }
    expect(fake.sent[0]?.type).toBe('session.update');
    expect(jest.getTimerCount()).toBe(1);

    // Duplicate open: should not schedule a second fallback timer.
    fake.push({ type: 'open' });
    for (let i = 0; i < 25 && fake.sent.length < 2; i++) {
      await Promise.resolve();
    }
    expect(fake.sent.filter(m => m.type === 'session.update')).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(10_000);
    const evt = await waitForEvent(it, e => e.type === 'ready');
    expect(evt.type).toBe('ready');
    expect(jest.getTimerCount()).toBe(0);

    await session.close();
    jest.useRealTimers();
  });
});
