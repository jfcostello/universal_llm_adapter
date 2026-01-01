import { jest } from '@jest/globals';

import { AsyncQueue } from '@/kernel/index.ts';
import { createRealtimeSessionController } from '@/modules/realtime/internal/realtime-session.ts';
import { createRealtimeSession } from '@/modules/realtime/index.ts';

import type {
  ProcessRouteManifest,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec,
  UnifiedTool
} from '@/kernel/index.ts';

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

describe('modules/realtime/internal/async-queue', () => {
  test('resolves pending next() when push() is called', async () => {
    const q = new AsyncQueue<number>();
    const nextPromise = q.next();
    q.push(123);
    await expect(nextPromise).resolves.toEqual({ value: 123, done: false });
    q.close();
  });

  test('buffers items when no consumer is waiting', async () => {
    const q = new AsyncQueue<string>();
    q.push('a');
    q.push('b');
    await expect(q.next()).resolves.toEqual({ value: 'a', done: false });
    await expect(q.next()).resolves.toEqual({ value: 'b', done: false });
    q.close();
  });

  test('close() resolves pending next() and stops iteration', async () => {
    const q = new AsyncQueue<number>();
    const pending = q.next();
    q.close();
    await expect(pending).resolves.toEqual({ value: undefined as any, done: true });
    await expect(q.next()).resolves.toEqual({ value: undefined as any, done: true });
  });

  test('iterate() yields items until closed', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    await expect(collectAll(q.iterate())).resolves.toEqual([1, 2]);
  });

  test('push() is ignored after close()', async () => {
    const q = new AsyncQueue<number>();
    q.close();
    q.push(1);
    await expect(q.next()).resolves.toEqual({ value: undefined as any, done: true });
  });

  test('close() is idempotent', async () => {
    const q = new AsyncQueue<number>();
    q.close();
    q.close();
    await expect(q.next()).resolves.toEqual({ value: undefined as any, done: true });
  });
});

describe('modules/realtime createRealtimeSession (public API)', () => {
  test('throws when realtime provider does not declare compat config', async () => {
    const registry = {
      getRealtimeProvider: jest.fn().mockResolvedValue({ id: 'p' }),
      getRealtimeCompat: jest.fn(),
      getTools: jest.fn(),
      getProcessRoutes: jest.fn().mockResolvedValue([])
    };

    await expect(
      createRealtimeSession(registry as any, { provider: 'p' })
    ).rejects.toThrow("Realtime provider 'p' does not declare compat configuration");
  });

  test('uses spec.provider in compat error message when provider id is missing', async () => {
    const registry = {
      getRealtimeProvider: jest.fn().mockResolvedValue({}),
      getRealtimeCompat: jest.fn(),
      getTools: jest.fn(),
      getProcessRoutes: jest.fn().mockResolvedValue([])
    };

    await expect(
      createRealtimeSession(registry as any, { provider: 'p_from_spec' } as any)
    ).rejects.toThrow("Realtime provider 'p_from_spec' does not declare compat configuration");
  });

  test('loads compat + tools and returns a session controller', async () => {
    const provider = { id: 'p', compat: 'rt' };
    const tools: UnifiedTool[] = [{ name: 'echo' }];

    const closed = createDeferred<void>();
    const compatSession: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const compat = { createSession: jest.fn().mockResolvedValue(compatSession) };

    const registry = {
      getRealtimeProvider: jest.fn().mockResolvedValue(provider),
      getRealtimeCompat: jest.fn().mockResolvedValue(compat),
      getTools: jest.fn().mockResolvedValue(tools),
      getProcessRoutes: jest.fn().mockResolvedValue([])
    };

    const session = await createRealtimeSession(registry as any, {
      provider: 'p',
      functionToolNames: ['echo']
    });

    const events = session.events()[Symbol.asyncIterator]();
    const first = await events.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: 'ready', sessionId: 's' });

    await session.close();
    await expect(events.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'client_close' } });

    expect(registry.getRealtimeProvider).toHaveBeenCalledWith('p');
    expect(registry.getRealtimeCompat).toHaveBeenCalledWith('rt');
    expect(registry.getTools).toHaveBeenCalledWith(['echo']);
    expect(compat.createSession).toHaveBeenCalledWith({ provider, spec: expect.any(Object), tools });
  });

  test('does not call getTools when functionToolNames is empty', async () => {
    const provider = { id: 'p', compat: 'rt' };

    const closed = createDeferred<void>();
    const compatSession: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const compat = { createSession: jest.fn().mockResolvedValue(compatSession) };

    const registry = {
      getRealtimeProvider: jest.fn().mockResolvedValue(provider),
      getRealtimeCompat: jest.fn().mockResolvedValue(compat),
      getTools: jest.fn(),
      getProcessRoutes: jest.fn().mockResolvedValue([])
    };

    const session = await createRealtimeSession(registry as any, { provider: 'p', functionToolNames: [] });
    await session.close();

    expect(registry.getTools).not.toHaveBeenCalled();
    expect(compat.createSession).toHaveBeenCalledWith({ provider, spec: expect.any(Object), tools: undefined });
  });
});

describe('modules/realtime/internal/realtime-session', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('events() can only be consumed once', async () => {
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const first = session.events();
    expect(first).toBeDefined();
    expect(() => session.events()).toThrow('events() can only be consumed once');

    await session.close();
  });

  test('fails fast when event buffer overflows (consumer stalls)', async () => {
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
          yield { type: 'user_transcript.delta', textDelta: `d${i}` };
        }
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
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
    expect(events[1]).toMatchObject({ type: 'playback.clear_requested', reason: 'error' });
    expect(typeof (events[1] as any).atMs).toBe('number');
    expect(events[2]).toEqual({ type: 'closed', reason: 'error' });
    expect(compatClose).toHaveBeenCalled();
  });

  test('eventBuffer.maxEvents does not affect normal sessions within limit', async () => {
    const compatClose = jest.fn();
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
        yield { type: 'user_transcript.delta', textDelta: 'hi' };
        yield { type: 'closed', reason: 'provider_close' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        eventBuffer: { maxEvents: 10 },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events).toEqual([
      { type: 'ready', sessionId: 's' },
      { type: 'user_transcript.delta', textDelta: 'hi' },
      { type: 'closed', reason: 'provider_close' }
    ]);
    expect(compatClose).toHaveBeenCalled();
  });

  test('enforces first event must be ready', async () => {
    const compatClose = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: compatClose,
      events: async function* () {
        yield { type: 'user_transcript.delta', textDelta: 'nope' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events).toEqual([
      { type: 'error', message: 'First realtime event must be ready', code: 'invalid_first_event' },
      { type: 'closed', reason: 'error' }
    ]);
    expect(compatClose).toHaveBeenCalled();
  });

  test('closes with provider_close when compat ends without yielding any events', async () => {
    const compatClose = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: compatClose,
      events: async function* () {}
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events).toEqual([{ type: 'closed', reason: 'provider_close' }]);
    expect(compatClose).toHaveBeenCalled();
  });

  test('interrupt() calls compat.interrupt and emits playback.clear_requested', async () => {
    const closed = createDeferred<void>();
    const compatInterrupt = jest.fn();
    const compatClose = jest.fn().mockImplementation(() => closed.resolve());
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: compatInterrupt,
      sendToolResult: jest.fn(),
      close: compatClose,
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const iter = session.events()[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: 'ready', sessionId: 's' });

    await session.interrupt({ reason: 'user_interrupt' });
    expect(compatInterrupt).toHaveBeenCalledWith({ reason: 'user_interrupt' });

    const clear = await iter.next();
    expect(clear.value).toMatchObject({ type: 'playback.clear_requested', reason: 'interrupt' });

    await session.close();
    await expect(iter.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'client_close' } });
  });

  test('sendText/sendAudio/commit delegate to compat session', async () => {
    const closed = createDeferred<void>();
    const compatSendText = jest.fn();
    const compatSendAudio = jest.fn();
    const compatCommit = jest.fn();

    const compat: RealtimeCompatSession = {
      sendText: compatSendText,
      injectContext: jest.fn(),
      sendAudio: compatSendAudio,
      commit: compatCommit,
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const iter = session.events()[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: 'ready' });

    await session.sendText({ text: 'hello', role: 'user' });
    await session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: '' });
    await session.commit();

    expect(compatSendText).toHaveBeenCalledWith({ text: 'hello', role: 'user' });
    expect(compatSendAudio).toHaveBeenCalled();
    expect(compatCommit).toHaveBeenCalled();

    await session.close();
    await expect(iter.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'client_close' } });
  });

  test('startup history injection blocks ready until compat injectContext completes', async () => {
    const injection = createDeferred<void>();

    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn().mockImplementation(() => injection.promise),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        // keep session open
        await new Promise(() => {});
      }
    };

    const history = [{ role: 'system', text: 'Remember TOKEN_123' }];
    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        history,
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const iter = session.events()[Symbol.asyncIterator]();
    const first = iter.next();

    let settled = false;
    void first.finally(() => {
      settled = true;
    });

    // Allow the event pump to reach the injectContext await.
    await new Promise(res => setTimeout(res, 0));
    expect(compat.injectContext).toHaveBeenCalledWith(history);
    expect(settled).toBe(false);

    injection.resolve(undefined);
    await expect(first).resolves.toMatchObject({ value: { type: 'ready', sessionId: 's' } });
    await session.close();
  });

  test('startup history injection failure surfaces history_injection_failed and closes without emitting ready', async () => {
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn().mockImplementation(() => {
        throw new Error('inject boom');
      }),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        history: [{ role: 'system', text: 'x' }],
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    await expect(collectAll(session.events())).resolves.toEqual([
      { type: 'error', message: 'inject boom', code: 'history_injection_failed' },
      { type: 'closed', reason: 'error' }
    ]);
  });

  test('startup history injection failure uses String(error) when thrown value has no message', async () => {
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn().mockImplementation(() => {
        throw 123;
      }),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        history: [{ role: 'system', text: 'x' }],
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    await expect(collectAll(session.events())).resolves.toEqual([
      { type: 'error', message: '123', code: 'history_injection_failed' },
      { type: 'closed', reason: 'error' }
    ]);
  });

  test('injectContext() delegates to compat session', async () => {
    const closed = createDeferred<void>();
    const compatInject = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: compatInject,
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const eventsPromise = collectAll(session.events());
    await new Promise(res => setTimeout(res, 0));

    await session.injectContext([{ role: 'user', text: 'hello' }]);
    await session.close();

    expect(compatInject).toHaveBeenCalledWith([{ role: 'user', text: 'hello' }]);
    await expect(eventsPromise).resolves.toContainEqual({ type: 'ready', sessionId: 's' });
  });

  test('throws when attempting to send after close', async () => {
    const closed = createDeferred<void>();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    await session.close();
    await expect(session.sendText({ text: 'x' })).rejects.toThrow('Realtime session is closed');
    await expect(session.injectContext([] as any)).rejects.toThrow('Realtime session is closed');
    await expect(session.sendDTMF('5')).rejects.toThrow('Realtime session is closed');
    await expect(session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: '' })).rejects.toThrow(
      'Realtime session is closed'
    );
    await expect(session.commit()).rejects.toThrow('Realtime session is closed');
    await expect(session.interrupt()).rejects.toThrow('Realtime session is closed');
  });

  test('sendDTMF forwards digit mode to the compat and emits normalized events', async () => {
    const closed = createDeferred<void>();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        dtmf: { mode: 'digit' },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const eventsPromise = collectAll(session.events());
    await new Promise(res => setTimeout(res, 0));

    await session.sendDTMF('5');
    await session.close();

    await expect(eventsPromise).resolves.toEqual([
      { type: 'ready', sessionId: 's' },
      { type: 'user_dtmf.digit', digit: '5' },
      { type: 'closed', reason: 'client_close' }
    ]);

    expect(compat.sendText).toHaveBeenCalledWith({ text: 'DTMF: 5', role: 'user' });
    expect(compat.commit).toHaveBeenCalled();
  });

  test('sendDTMF sequence mode buffers digits until a terminator then forwards a sequence turn', async () => {
    const closed = createDeferred<void>();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        dtmf: { mode: 'sequence', terminators: ['#'] },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const eventsPromise = collectAll(session.events());
    await new Promise(res => setTimeout(res, 0));

    await session.sendDTMF('1');
    expect(compat.sendText).not.toHaveBeenCalled();
    expect(compat.commit).not.toHaveBeenCalled();

    await session.sendDTMF('#');
    await session.close();

    await expect(eventsPromise).resolves.toEqual([
      { type: 'ready', sessionId: 's' },
      { type: 'user_dtmf.digit', digit: '1' },
      { type: 'user_dtmf.digit', digit: '#' },
      { type: 'user_dtmf.sequence', digits: '1#', terminator: '#' },
      { type: 'closed', reason: 'client_close' }
    ]);

    expect(compat.sendText).toHaveBeenCalledWith({ text: 'DTMF sequence: 1#', role: 'user' });
    expect(compat.commit).toHaveBeenCalledTimes(1);
  });

  test('sendDTMF rejects empty digits', async () => {
    const closed = createDeferred<void>();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    await new Promise(res => setTimeout(res, 0));
    await expect(session.sendDTMF('')).rejects.toThrow('DTMF digit must be a non-empty string');
    await expect(session.sendDTMF(undefined as any)).rejects.toThrow('DTMF digit must be a non-empty string');
    await session.close();
  });

  test('sendDTMF sequence mode can flush on maxDigits (no terminator field)', async () => {
    const closed = createDeferred<void>();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        dtmf: { mode: 'sequence', terminators: ['#'], maxDigits: 2 },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const eventsPromise = collectAll(session.events());
    await new Promise(res => setTimeout(res, 0));

    await session.sendDTMF('1');
    await session.sendDTMF('2');
    await session.close();

    await expect(eventsPromise).resolves.toEqual([
      { type: 'ready', sessionId: 's' },
      { type: 'user_dtmf.digit', digit: '1' },
      { type: 'user_dtmf.digit', digit: '2' },
      { type: 'user_dtmf.sequence', digits: '12' },
      { type: 'closed', reason: 'client_close' }
    ]);

    expect(compat.sendText).toHaveBeenCalledWith({ text: 'DTMF sequence: 12', role: 'user' });
    expect(compat.commit).toHaveBeenCalledTimes(1);
  });

  test('DTMF can trigger barge-in when enabled (digit mode)', async () => {
    const closed = createDeferred<void>();
    const compatInterrupt = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: compatInterrupt,
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        bargeIn: { enabled: true },
        dtmf: { mode: 'digit' },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const eventsPromise = collectAll(session.events());
    await new Promise(res => setTimeout(res, 0));

    await session.sendDTMF('5');
    await session.close();

    const events = await eventsPromise;
    expect(compatInterrupt).toHaveBeenCalledWith({ reason: 'barge_in' });
    expect(events.map(e => e.type)).toEqual(['ready', 'playback.clear_requested', 'user_dtmf.digit', 'closed']);
  });

  test('barge-in triggers interrupt on user_speech.started and emits playback.clear_requested', async () => {
    const compatInterrupt = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: compatInterrupt,
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'user_speech.started' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        bargeIn: { enabled: true },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(compatInterrupt).toHaveBeenCalledWith({ reason: 'barge_in' });
    expect(events.map(e => e.type)).toEqual(['ready', 'playback.clear_requested', 'user_speech.started', 'closed']);
    expect(events[events.length - 1]).toMatchObject({ type: 'closed', reason: 'provider_close' });
  });

  test('barge-in does not trigger when disabled', async () => {
    const compatInterrupt = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: compatInterrupt,
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'user_speech.started' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(compatInterrupt).not.toHaveBeenCalled();
    expect(events.map(e => e.type)).toEqual(['ready', 'user_speech.started', 'closed']);
  });

  test('barge-in can trigger on user_transcript.delta when configured', async () => {
    const compatInterrupt = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: compatInterrupt,
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'user_transcript.delta', textDelta: 'h' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        bargeIn: { enabled: true, triggers: ['user_transcript.delta'] },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(compatInterrupt).toHaveBeenCalledWith({ reason: 'barge_in' });
    expect(events.some(e => e.type === 'user_transcript.delta')).toBe(true);
  });

  test('barge-in does not trigger when the event is not in triggers', async () => {
    const compatInterrupt = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: compatInterrupt,
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'user_transcript.delta', textDelta: 'h' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        bargeIn: { enabled: true, triggers: ['user_speech.started'] },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    await collectAll(session.events());
    expect(compatInterrupt).not.toHaveBeenCalled();
  });

  test('routes tool_call.end via ToolCoordinator and sends tool result', async () => {
    const routes: ProcessRouteManifest[] = [
      {
        id: 'echo',
        match: { type: 'exact', pattern: 'echo' },
        invoke: { kind: 'module', module: './tests/fixtures/modules/echo-tool.mjs' }
      } as any
    ];

    const compatSendToolResult = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: compatSendToolResult,
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo', arguments: { text: 'Tokyo' } };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue(routes) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        model: 'm',
        functionToolNames: ['echo'],
        metadata: { testKey: 'testValue' },
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual(['ready', 'tool_call.end', 'tool_result.sent', 'closed']);

    expect(compatSendToolResult).toHaveBeenCalledWith({
      toolCallId: 'c1',
      result: {
        result: {
          echoed: 'Tokyo',
          provider: 'p',
          model: 'm',
          metadata: { testKey: 'testValue' }
        }
      }
    });
  });

  test('reuses tool coordinator for multiple tool calls in a single session', async () => {
    const routes: ProcessRouteManifest[] = [
      {
        id: 'echo',
        match: { type: 'exact', pattern: 'echo' },
        invoke: { kind: 'module', module: './tests/fixtures/modules/echo-tool.mjs' }
      } as any
    ];

    const compatSendToolResult = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: compatSendToolResult,
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo', arguments: { text: 'one' } };
        yield { type: 'tool_call.end', toolCallId: 'c2', name: 'echo', arguments: { text: 'two' } };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue(routes) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        model: 'm',
        functionToolNames: ['echo'],
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' }
      },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual([
      'ready',
      'tool_call.end',
      'tool_result.sent',
      'tool_call.end',
      'tool_result.sent',
      'closed'
    ]);
    expect(compatSendToolResult).toHaveBeenCalledTimes(2);
    expect(compatSendToolResult).toHaveBeenNthCalledWith(1, expect.objectContaining({ toolCallId: 'c1' }));
    expect(compatSendToolResult).toHaveBeenNthCalledWith(2, expect.objectContaining({ toolCallId: 'c2' }));
  });

  test('tool calls are rejected when tools are not enabled', async () => {
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo', arguments: {} };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual(['ready', 'tool_call.end', 'error', 'closed']);
    const error = events.find(e => e.type === 'error') as any;
    expect(error.code).toBe('tools_disabled');
  });

  test('tool calls are rejected when tool is not enabled', async () => {
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo', arguments: {} };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', functionToolNames: ['other'], timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual(['ready', 'tool_call.end', 'error', 'closed']);
    const error = events.find(e => e.type === 'error') as any;
    expect(error.code).toBe('tool_not_enabled');
  });

  test('tool execution failures surface as error + close', async () => {
    const compatClose = jest.fn();
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
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo', arguments: { text: 'x' } };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', functionToolNames: ['echo'], timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual(['ready', 'tool_call.end', 'error', 'closed']);
    const error = events.find(e => e.type === 'error') as any;
    expect(error.code).toBe('tool_error');
    expect(String(error.message)).toContain('Tool execution failed');
    expect(compatClose).toHaveBeenCalled();
  });

  test('tool error message falls back to String(error) when sendToolResult throws non-Error', async () => {
    const routes: ProcessRouteManifest[] = [
      {
        id: 'echo',
        match: { type: 'exact', pattern: 'echo' },
        invoke: { kind: 'module', module: './tests/fixtures/modules/echo-tool.mjs' }
      } as any
    ];

    const compatClose = jest.fn();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn().mockImplementation(() => {
        throw 123;
      }),
      close: compatClose,
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        yield { type: 'tool_call.end', toolCallId: 'c1', name: 'echo', arguments: { text: 'x' } };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue(routes) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', model: 'm', functionToolNames: ['echo'], timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual(['ready', 'tool_call.end', 'error', 'closed']);
    const error = events.find(e => e.type === 'error') as any;
    expect(error.code).toBe('tool_error');
    expect(String(error.message)).toContain('123');
    expect(compatClose).toHaveBeenCalled();
  });

  test('respects provider-emitted closed event and does not emit a duplicate closed event', async () => {
    const compatClose = jest.fn();
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
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events).toEqual([
      { type: 'ready', sessionId: 's' },
      { type: 'closed', reason: 'client_close' }
    ]);
    expect(compatClose).toHaveBeenCalled();
  });

  test('provider-emitted closed event without reason defaults internally to provider_close', async () => {
    const compatClose = jest.fn();
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
        yield { type: 'closed' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events).toEqual([{ type: 'ready', sessionId: 's' }, { type: 'closed' }]);
    await expect(session.sendText({ text: 'x' })).rejects.toThrow('Realtime session is closed');
    expect(compatClose).toHaveBeenCalled();
  });

  test('surfaces compat errors as compat_error + close', async () => {
    const compatClose = jest.fn();
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
        throw new Error('boom');
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual(['ready', 'error', 'closed']);
    const error = events.find(e => e.type === 'error') as any;
    expect(error.code).toBe('compat_error');
    expect(String(error.message)).toContain('boom');
    expect(compatClose).toHaveBeenCalled();
  });

  test('surfaces compat errors using String(error) when thrown value has no message', async () => {
    const compatClose = jest.fn();
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
        throw 123;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const events = await collectAll(session.events());
    expect(events.map(e => e.type)).toEqual(['ready', 'error', 'closed']);
    const error = events.find(e => e.type === 'error') as any;
    expect(error.code).toBe('compat_error');
    expect(String(error.message)).toBe('123');
    expect(compatClose).toHaveBeenCalled();
  });

  test('does not emit compat_error if compat throws after the session is already closed', async () => {
    const closed = createDeferred<void>();
    const compatClose = jest.fn().mockImplementation(() => closed.resolve());

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
        await closed.promise;
        throw new Error('boom-after-close');
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    const iter = session.events()[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: 'ready' });

    await session.close();
    await expect(iter.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'client_close' } });
    await expect(iter.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test('timeout (idle) emits timeout + playback.clear_requested and closes when onTimeout=close', async () => {
    jest.useFakeTimers();

    const closed = createDeferred<void>();
    const compatClose = jest.fn().mockImplementation(() => closed.resolve());
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
        await closed.promise;
        // Even if compat emits something after closure, core must ignore it.
        yield { type: 'user_transcript.delta', textDelta: 'late' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 10, onTimeout: 'close' } },
      compatSession: compat
    });

    const iter = session.events()[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: 'ready' });

    await jest.advanceTimersByTimeAsync(10);

    expect((await iter.next()).value).toMatchObject({ type: 'timeout', reason: 'idle' });
    expect((await iter.next()).value).toMatchObject({ type: 'playback.clear_requested', reason: 'timeout' });
    expect((await iter.next()).value).toMatchObject({ type: 'closed', reason: 'timeout' });
    await expect(iter.next()).resolves.toEqual({ value: undefined, done: true });

    expect(compatClose).toHaveBeenCalled();

    // Cover: handleTimeout no-ops when already closed.
    await expect((session as any).handleTimeout('idle')).resolves.toBeUndefined();
  });

  test('timeout timers start after ready (even if time elapses + client activity happens pre-ready)', async () => {
    jest.useFakeTimers();

    const readyGate = createDeferred<void>();
    const closed = createDeferred<void>();

    const compatClose = jest.fn().mockImplementation(() => closed.resolve());
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: compatClose,
      events: async function* () {
        await readyGate.promise;
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 10, onTimeout: 'close' } },
      compatSession: compat
    });

    // Covers: onActivity() before ready must not schedule idle timers.
    await session.sendText({ text: 'hello', role: 'user' });

    const iter = session.events()[Symbol.asyncIterator]();

    // Even if time elapses beyond idleTimeout before ready, the first event must still be ready.
    await jest.advanceTimersByTimeAsync(50);
    readyGate.resolve();
    expect((await iter.next()).value).toMatchObject({ type: 'ready' });

    await jest.advanceTimersByTimeAsync(10);
    expect((await iter.next()).value).toMatchObject({ type: 'timeout', reason: 'idle' });
    expect((await iter.next()).value).toMatchObject({ type: 'playback.clear_requested', reason: 'timeout' });
    expect((await iter.next()).value).toMatchObject({ type: 'closed', reason: 'timeout' });
    await expect(iter.next()).resolves.toEqual({ value: undefined, done: true });

    expect(compatClose).toHaveBeenCalled();
  });

  test('timeout (max_duration) emits timeout but does not close when onTimeout=warn', async () => {
    jest.useFakeTimers();

    const closed = createDeferred<void>();
    const compatClose = jest.fn().mockImplementation(() => closed.resolve());
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
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 10, idleTimeoutMs: 0, onTimeout: 'warn' } },
      compatSession: compat
    });

    const iter = session.events()[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: 'ready' });

    await jest.advanceTimersByTimeAsync(10);

    const timeout = await iter.next();
    expect(timeout.value).toMatchObject({ type: 'timeout', reason: 'max_duration' });
    await expect(iter.next()).resolves.toMatchObject({ value: { type: 'playback.clear_requested', reason: 'timeout' } });

    // Session should remain open; close explicitly to finish.
    await session.close();
    await expect(iter.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'client_close' } });
    expect(compatClose).toHaveBeenCalled();
  });

  test('close is idempotent and swallows compat close errors', async () => {
    const compatClose = jest.fn().mockImplementation(() => {
      throw new Error('close failed');
    });
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
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
    expect(compatClose).toHaveBeenCalled();
  });

  test('can ignore incoming compat events after closure', async () => {
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' } },
      compatSession: compat
    });

    await session.close();
    await expect((session as any).handleCompatEvent({ type: 'user_speech.started' } as RealtimeEvent)).resolves.toBeUndefined();
  });

  test('does not schedule activity timers after close', async () => {
    const closed = createDeferred<void>();
    const compat: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closed.resolve()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed.promise;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: { provider: 'p', timeout: { maxDurationMs: 0, idleTimeoutMs: 60000, onTimeout: 'close' } },
      compatSession: compat
    });

    const iter = session.events()[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: 'ready' });

    await session.close();
    await expect(iter.next()).resolves.toMatchObject({ value: { type: 'closed', reason: 'client_close' } });

    // Cover the onActivity closed-guard (should not re-arm timers post-close).
    expect(() => (session as any).onActivity()).not.toThrow();
    expect((session as any).idleTimer).toBeUndefined();
  });
});
