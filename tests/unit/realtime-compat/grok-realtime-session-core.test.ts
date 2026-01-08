import { jest } from '@jest/globals';

import type { RealtimeAudioFrame, RealtimeCompatSession, RealtimeEvent } from '@/kernel/index.ts';
import { AsyncQueue } from '@/kernel/index.ts';

import { createGrokRealtimeCompatSessionWithTransport } from '@/plugins/realtime-compat/grok/internal/session-core.ts';

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

describe('realtime-compat/grok — session core', () => {
  const provider: any = {
    id: 'grok',
    compat: 'grok',
    endpoint: { urlTemplate: 'wss://api.x.ai/v1/realtime', headers: { Authorization: 'Bearer sk' } },
    metadata: { defaultVoice: 'ara' }
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

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', transcription: { enabled: true } } as any
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

  test('handshake: waits for conversation.created to send session.update and emits ready on session.updated', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', transcription: { enabled: true } } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    expect(fake.sent).toHaveLength(0);

    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created', conversation: { id: 'c1' } }) });
    await new Promise(res => setTimeout(res, 0));
    expect(fake.sent[0]?.type).toBe('session.update');
    expect(fake.sent[0]?.session?.voice).toBe('ara');

    // Second conversation.created should not re-send session.update.
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created', conversation: { id: 'c1' } }) });
    await new Promise(res => setTimeout(res, 0));
    expect(fake.sent.filter(m => m.type === 'session.update')).toHaveLength(1);

    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated', session: { id: 's1' } }) });
    const evt = await waitForEvent(it, e => e.type === 'ready');
    expect(evt.type).toBe('ready');

    await session.close();
  });

  test('emits non-fatal warnings for unsupported/invalid session settings', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', settings: { unknownKey: 'x', temperature: 'nope' } } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });

    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created', conversation: { id: 'c1' } }) });
    await new Promise(res => setTimeout(res, 0));

    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated', session: { id: 's1' } }) });
    await waitForEvent(it, e => e.type === 'ready');

    const second = await it.next();
    expect(second.value).toMatchObject({ type: 'error', code: 'unsupported_session_settings' });
    expect(String(second.value.message)).toContain('unknownKey');

    const third = await it.next();
    expect(third.value).toMatchObject({ type: 'error', code: 'invalid_session_settings' });
    expect(String(third.value.message)).toContain('temperature');

    await session.close();
  });

  test('buffers mapped events until ready, then flushes them in order', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });

    // Pre-ready event should be buffered.
    fake.push({ type: 'message', data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });

    expect((await it.next()).value).toEqual(expect.objectContaining({ type: 'ready' }));
    expect((await it.next()).value).toEqual(expect.objectContaining({ type: 'user_speech.started' }));

    await session.close();
  });

  test('transport error emits ready + error and does not crash', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'error', error: new Error('boom'), code: 'ws_error' });

    const ready = await waitForEvent(it, e => e.type === 'ready');
    expect(ready.type).toBe('ready');

    const error = await waitForEvent(it, e => e.type === 'error');
    expect(error).toEqual(expect.objectContaining({ type: 'error', code: 'ws_error' }));

    await session.close();
  });

  test('parsed error event (type=error) emits ready and maps error payload', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'error', error: { message: 'bad', code: 'x' } }) });

    await waitForEvent(it, e => e.type === 'ready');
    const error = await waitForEvent(it, e => e.type === 'error');
    expect(error).toEqual({ type: 'error', message: 'bad', code: 'x' });

    await session.close();
  });

  test('covers nullish parsing branches and cancel spelling variants', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });

    // Transport error without an explicit code should default to `transport_error`.
    fake.push({ type: 'error', error: new Error('boom') } as any);
    await waitForEvent(it, e => e.type === 'ready');
    const transportError = await waitForEvent(it, e => e.type === 'error');
    expect(transportError).toEqual(expect.objectContaining({ type: 'error', code: 'transport_error' }));

    // Message without `data` should hit the nullish-coalescing fallback in JSON.parse.
    fake.push({ type: 'message', data: undefined } as any);
    const invalidJson = await waitForEvent(it, e => e.type === 'error' && (e as any).code === 'invalid_json');
    expect(invalidJson).toEqual({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });

    // Parsed message with no `.type` should hit the nullish-coalescing fallback for msgType.
    fake.push({ type: 'message', data: '{}' });
    await new Promise(res => setTimeout(res, 0));

    // response.done with missing status should hit the status fallback branch.
    fake.push({ type: 'message', data: JSON.stringify({ type: 'response.done' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'response.done', response: {} }) });
    await new Promise(res => setTimeout(res, 0));

    // cancel ack via status=cancelled
    await session.interrupt();
    const commitWithCancelled = session.commit();
    fake.push({ type: 'message', data: JSON.stringify({ type: 'response.done', response: { status: 'cancelled' } }) });
    await commitWithCancelled;

    // cancel ack via response.canceled spelling
    await session.interrupt();
    const commitWithCanceled = session.commit();
    fake.push({ type: 'message', data: JSON.stringify({ type: 'response.canceled' }) });
    await commitWithCanceled;

    await session.close();
  });

  test('invalid JSON message emits ready + invalid_json error', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: '{' });

    await waitForEvent(it, e => e.type === 'ready');
    const error = await waitForEvent(it, e => e.type === 'error');
    expect(error).toEqual({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });

    await session.close();
  });

  test('transport close emits ready + closed(provider_close)', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'close' });

    await waitForEvent(it, e => e.type === 'ready');
    const closed = await waitForEvent(it, e => e.type === 'closed');
    expect(closed).toEqual({ type: 'closed', reason: 'provider_close' });
  });

  test('manual_commit: commit without audio sends response.create only', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;
    await session.commit();

    const types = fake.sent.map(m => m.type);
    expect(types).toEqual(['response.create']);

    await session.close();
  });

  test('manual_commit: sendAudio + commit sends input_audio_buffer.commit + response.create', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    const frame: RealtimeAudioFrame = {
      format: 'pcm16',
      sampleRateHz: 24000,
      channels: 1,
      dataBase64: Buffer.from('a').toString('base64')
    };

    await session.sendAudio(frame);
    await session.commit();

    const types = fake.sent.map(m => m.type);
    expect(types.includes('input_audio_buffer.append')).toBe(true);
    expect(types.includes('input_audio_buffer.commit')).toBe(true);
    expect(types.includes('response.create')).toBe(true);

    await session.close();
  });

  test('input_audio_buffer.committed clears pending audio so commit does not re-send commit', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;

    const frame: RealtimeAudioFrame = {
      format: 'pcm16',
      sampleRateHz: 24000,
      channels: 1,
      dataBase64: Buffer.from('a').toString('base64')
    };

    await session.sendAudio(frame);
    fake.push({ type: 'message', data: JSON.stringify({ type: 'input_audio_buffer.committed' }) });
    await new Promise(res => setTimeout(res, 0));

    await session.commit();
    const types = fake.sent.map(m => m.type);
    expect(types).toContain('input_audio_buffer.append');
    expect(types).not.toContain('input_audio_buffer.commit');
    expect(types).toContain('response.create');

    await session.close();
  });

  test('server_vad: commit is a no-op for audio turns (avoids double response)', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', turnDetection: { mode: 'server_vad' } } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;

    const frame: RealtimeAudioFrame = {
      format: 'pcm16',
      sampleRateHz: 24000,
      channels: 1,
      dataBase64: Buffer.from('a').toString('base64')
    };

    await session.sendAudio(frame);
    await session.commit();

    const types = fake.sent.map(m => m.type);
    expect(types).toEqual(['input_audio_buffer.append']);

    await session.close();
  });

  test('server_vad: commit sends response.create for text turns', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', turnDetection: { mode: 'server_vad' } } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;

    await session.sendText({ text: 'hi' });
    await session.commit();

    const types = fake.sent.map(m => m.type);
    expect(types).toEqual(['conversation.item.create', 'response.create']);

    await session.close();
  });

  test('toolChoice=single forces required on commit', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', toolChoice: { type: 'single', name: 'demo_tool' } } as any,
        tools: [{ name: 'demo_tool', description: 'Demo tool', parametersJsonSchema: { type: 'object', properties: {} } }] as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;
    await session.sendText({ text: 'hi' });
    await session.commit();

    const responseCreate = fake.sent.find(m => m.type === 'response.create');
    expect(responseCreate.response.tool_choice).toEqual({ type: 'function', name: 'demo_tool' });

    await session.close();
  });

  test('toolChoice=single accepts provider tool name and forces function tool choice', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', toolChoice: { type: 'single', name: 'demo_tool' } } as any,
        tools: [{ name: 'demo.tool', description: 'Demo tool', parametersJsonSchema: { type: 'object', properties: {} } }] as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;
    await session.sendText({ text: 'hi' });
    await session.commit();

    const responseCreate = fake.sent.find(m => m.type === 'response.create');
    expect(responseCreate.response.tool_choice).toEqual({ type: 'function', name: 'demo_tool' });

    await session.close();
  });

  test('toolChoice=single falls back to required when tool name is empty', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', toolChoice: { type: 'single', name: '' } } as any,
        tools: [{ name: '', description: 'Demo tool', parametersJsonSchema: { type: 'object', properties: {} } }] as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;
    await session.sendText({ text: 'hi' });
    await session.commit();

    const responseCreate = fake.sent.find(m => m.type === 'response.create');
    expect(responseCreate.response.tool_choice).toBe('required');

    await session.close();
  });

  test('interrupt sets pending cancel; cancel ack via response.cancelled releases commit wait', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;

    await session.interrupt();
    await session.interrupt(); // idempotent pending cancel creation

    const commitPromise = session.commit();
    fake.push({ type: 'message', data: JSON.stringify({ type: 'response.cancelled' }) });
    await commitPromise;

    const types = fake.sent.map(m => m.type);
    expect(types).toContain('response.cancel');
    expect(types).toContain('response.create');

    await session.close();
  });

  test('cancel ack via response.done(status=canceled) releases commit wait', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;

    await session.interrupt();
    const commitPromise = session.commit();
    fake.push({ type: 'message', data: JSON.stringify({ type: 'response.done', response: { status: 'canceled' } }) });
    await commitPromise;

    expect(fake.sent.some(m => m.type === 'response.create')).toBe(true);

    await session.close();
  });

  test('receiving cancel ack without a pending cancel is ignored', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.push({ type: 'message', data: JSON.stringify({ type: 'response.cancelled' }) });
    await new Promise(res => setTimeout(res, 0));

    await session.close();
  });

  test('commit waits up to 500ms for cancel ack before continuing', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;
    await session.interrupt();

    const start = Date.now();
    await session.commit();
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeGreaterThanOrEqual(450);
    expect(fake.sent.some(m => m.type === 'response.create')).toBe(true);

    await session.close();
  });

  test('sendToolResult sends function_call_output item then creates a follow-up response', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;
    await session.sendToolResult({ toolCallId: 'call-1', result: { ok: true } });

    expect(fake.sent[0].type).toBe('conversation.item.create');
    expect(fake.sent[0].item.type).toBe('function_call_output');
    expect(fake.sent[1].type).toBe('response.create');

    await session.close();
  });

  test('injectContext supports empty history and non-empty history', async () => {
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    fake.sent.length = 0;
    await session.injectContext([]);
    await session.injectContext([{ role: 'assistant', text: 'hello' }] as any);

    expect(fake.sent.some(m => m.type === 'conversation.item.create')).toBe(true);

    await session.close();
  });

  test('close is idempotent and swallows transport.close errors', async () => {
    const fake = createFakeTransport({
      closeImpl: () => {
        fake.close();
        throw new Error('boom');
      }
    });

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok' } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });
    fake.push({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) });
    await waitForEvent(it, e => e.type === 'ready');

    await session.close();
    await session.close();

    const closed = await waitForEvent(it, e => e.type === 'closed');
    expect(closed).toEqual({ type: 'closed', reason: 'client_close' });

    await expect(session.commit()).rejects.toThrow('Realtime session is closed');
  });

  test('pump failure emits ready + transport_pump_failed error and closes', async () => {
    await jest.isolateModulesAsync(async () => {
      const { createGrokRealtimeCompatSessionWithTransport: createSession } = await import(
        '@/plugins/realtime-compat/grok/internal/session-core.ts'
      );

      const q = new AsyncQueue<TransportEvent>();
      const transport = {
        send: () => {
          throw new Error('send boom');
        },
        events: () => q.iterate(),
        close: () => {
          q.push({ type: 'close' });
          q.close();
        }
      };

      const session = createSession(
        {
          provider,
          spec: { provider: 'grok' } as any
        } as any,
        transport as any
      );

      const it = session.events()[Symbol.asyncIterator]();
      q.push({ type: 'open' });
      q.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created' }) });

      await waitForEvent(it, e => e.type === 'ready');
      const err = await waitForEvent(it, e => e.type === 'error');
      expect(err).toEqual(expect.objectContaining({ type: 'error', code: 'transport_pump_failed' }));
      const closed = await waitForEvent(it, e => e.type === 'closed');
      expect(closed).toEqual({ type: 'closed', reason: 'error' });
    });
  });

  test('handshake: emits ready if session.updated never arrives (fallback)', async () => {
    jest.useFakeTimers();
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', transcription: { enabled: true } } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });
    fake.push({ type: 'open' });

    // Ensure the transport pump has started by flowing through a handshake message.
    fake.push({ type: 'message', data: JSON.stringify({ type: 'conversation.created', conversation: { id: 'c1' } }) });
    for (let i = 0; i < 25 && fake.sent.length === 0; i++) {
      await Promise.resolve();
    }
    expect(fake.sent[0]?.type).toBe('session.update');
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(10_000);
    const evt = await waitForEvent(it, e => e.type === 'ready');
    expect(evt.type).toBe('ready');

    await session.close();
    jest.useRealTimers();
  });

  test('handshake: fallback sends session.update if conversation.created never arrives', async () => {
    jest.useFakeTimers();
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', transcription: { enabled: true } } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });

    for (let i = 0; i < 25 && jest.getTimerCount() === 0; i++) {
      await Promise.resolve();
    }
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(10_000);
    expect(fake.sent[0]?.type).toBe('session.update');
    const evt = await waitForEvent(it, e => e.type === 'ready');
    expect(evt.type).toBe('ready');
    expect(jest.getTimerCount()).toBe(0);

    await session.close();
    jest.useRealTimers();
  });

  test('handshake: ready fallback delay is configurable via spec.handshake.readyFallbackMs', async () => {
    jest.useFakeTimers();
    const fake = createFakeTransport();

    const session = createGrokRealtimeCompatSessionWithTransport(
      {
        provider,
        spec: { provider: 'grok', transcription: { enabled: true }, handshake: { readyFallbackMs: 123 } } as any
      },
      fake.transport as any
    );

    const it = session.events()[Symbol.asyncIterator]();
    fake.push({ type: 'open' });

    for (let i = 0; i < 25 && jest.getTimerCount() === 0; i++) {
      await Promise.resolve();
    }
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(123);
    expect(fake.sent[0]?.type).toBe('session.update');
    const evt = await waitForEvent(it, e => e.type === 'ready');
    expect(evt.type).toBe('ready');
    expect(jest.getTimerCount()).toBe(0);

    await session.close();
    jest.useRealTimers();
  });
});
