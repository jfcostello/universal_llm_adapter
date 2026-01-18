import { createRequire } from 'module';

import * as http from 'http';

import { createGeminiRealtimeCompatSession } from '@/plugins/realtime-compat/gemini/internal/session.ts';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

async function startWsServer(options?: { closeOnSetup?: boolean }) {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  const messages: any[] = [];

  let socket: any | undefined;
  let requestUrl: string | undefined;
  wss.on('connection', (ws: any, req: any) => {
    socket = ws;
    requestUrl = req?.url;
    ws.on('message', (data: any) => {
      const shouldClose = options?.closeOnSetup === true;
      try {
        const parsed = JSON.parse(data.toString());
        messages.push(parsed);
        if (shouldClose && parsed?.setup) {
          try { ws.close(); } catch {}
        }
      } catch {
        messages.push({ type: '__unparsed__', raw: data.toString() });
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');

  const urlTemplate = `ws://127.0.0.1:${address.port}/live`;

  const close = async () => {
    try {
      socket?.close?.();
    } catch {}
    await new Promise<void>(resolve => wss.close(() => resolve()));
  };

  const sendToClient = (evt: any) => {
    if (!socket) throw new Error('No socket connected');
    socket.send(JSON.stringify(evt));
  };

  const sendRawToClient = (raw: string) => {
    if (!socket) throw new Error('No socket connected');
    socket.send(raw);
  };

  const closeClient = () => {
    if (!socket) throw new Error('No socket connected');
    socket.close();
  };

  const closeClientWithReason = (code: number, reason: string) => {
    if (!socket) throw new Error('No socket connected');
    socket.close(code, reason);
  };

  const waitForConnection = async (timeoutMs = 2000) => {
    const start = Date.now();
    while (!socket) {
      if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for socket');
      await new Promise(res => setTimeout(res, 10));
    }
  };

  const getRequestUrl = () => requestUrl;

  return {
    urlTemplate,
    messages,
    sendToClient,
    sendRawToClient,
    closeClient,
    closeClientWithReason,
    waitForConnection,
    getRequestUrl,
    close
  };
}

async function waitForMessage(messages: any[], predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(res => setTimeout(res, 10));
  }
  throw new Error('Timed out waiting for message');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ms = Math.max(0, Math.floor(timeoutMs));
  if (ms === 0) return await promise;

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} (${ms}ms)`)), ms);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

async function waitForSessionEvent(options: {
  iterator: AsyncIterator<any>;
  predicate: (evt: any) => boolean;
  timeoutMs?: number;
}): Promise<any> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    const next = await withTimeout(options.iterator.next(), remainingMs, 'session event');
    if (next.done) throw new Error('Session ended before expected event');
    if (options.predicate(next.value)) return next.value;
  }

  throw new Error('Timed out waiting for session event');
}

describe('integration/realtime-compat/gemini session', () => {
  test('throws when provider realtime config is missing', async () => {
    expect(() =>
      createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: '', headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm' }
      } as any)
    ).toThrow('missing realtime endpoint configuration');
  });

  test('throws when model is missing and no provider default is configured', async () => {
    const server = await startWsServer();
    try {
      expect(() =>
        createGeminiRealtimeCompatSession({
          provider: {
            id: 'google',
            compat: 'gemini',
            endpoint: { urlTemplate: server.urlTemplate, headers: {} }
          } as any,
          spec: { provider: 'google' }
        } as any)
      ).toThrow("requires 'model'");
    } finally {
      await server.close();
    }
  });

  test('connects, sends setup, waits for setupComplete, and emits ready first', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', transcription: { enabled: true }, turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      // Cover event mapping: serverContent -> normalized events.
      server.sendToClient({
        serverContent: {
          outputTranscription: { text: 'hi' },
          modelTurn: { parts: [{ text: 'x' }, { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] }
        }
      });

      const next = await it.next();
      expect(['assistant_transcript.delta', 'assistant_text.delta', 'assistant_audio.chunk']).toContain(next.value.type);

      await session.close();
      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('emits non-fatal warnings for unsupported/invalid session settings', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: {
          provider: 'google',
          model: 'm',
          turnDetection: { mode: 'manual_commit' },
          settings: { unknownKey: 'x', maxTokens: 'nope' }
        } as any
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      const second = await it.next();
      expect(second.value).toMatchObject({ type: 'error', code: 'unsupported_session_settings' });
      expect(String(second.value.message)).toContain('unknownKey');

      const third = await it.next();
      expect(third.value).toMatchObject({ type: 'error', code: 'invalid_session_settings' });
      expect(String(third.value.message)).toContain('maxTokens');

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('injectContext is a startup-only no-op and runtime injection is not supported', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: {
          provider: 'google',
          model: 'm',
          systemPrompt: 'Hello',
          history: [{ role: 'system', text: 'Remember TOKEN_123' }],
          turnDetection: { mode: 'manual_commit' }
        }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      expect(String(server.messages.find(m => m?.setup)?.setup?.systemInstruction?.parts?.[0]?.text ?? '')).toContain('TOKEN_123');

      // This call represents the core's startup seeding call; Gemini pre-seeds via setup message so it is a no-op.
      await expect(session.injectContext([{ role: 'system', text: 'Remember TOKEN_123' }])).resolves.toBeUndefined();

      // Any mid-session injection attempts are rejected (not supported for this compat).
      await expect(session.injectContext([{ role: 'system', text: 'Remember TOKEN_999' }])).rejects.toThrow('not supported');

      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('buffers outbound messages until setupComplete', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      await session.sendText({ role: 'user', text: 'hi' });
      await new Promise(res => setTimeout(res, 25));
      expect(server.messages.some(m => m?.clientContent)).toBe(false);

      server.sendToClient({ setupComplete: {} });
      await waitForMessage(server.messages, m => m?.clientContent?.turnComplete === false, 2000);

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('reconnects when the websocket closes before setupComplete', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      await session.sendText({ role: 'user', text: 'hi' });
      await session.commit();
      await new Promise(res => setTimeout(res, 25));
      expect(server.messages.some(m => m?.clientContent)).toBe(false);

      const setupCountBefore = server.messages.filter(m => m?.setup?.model === 'models/m').length;
      server.closeClient();

      const waitForSetupCount = async (count: number, timeoutMs: number) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const current = server.messages.filter(m => m?.setup?.model === 'models/m').length;
          if (current >= count) return;
          await new Promise(res => setTimeout(res, 10));
        }
        throw new Error('Timed out waiting for reconnect setup message');
      };

      await waitForSetupCount(setupCountBefore + 1, 5000);
      server.sendToClient({ setupComplete: {} });

      await waitForMessage(server.messages, m => m?.clientContent?.turnComplete === false, 2000);
      await waitForMessage(server.messages, m => m?.clientContent?.turnComplete === true, 2000);

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('does not reconnect after close (covers connect closed guard)', async () => {
    const server = await startWsServer({ closeOnSetup: true });
    const originalSetTimeout = globalThis.setTimeout;
    const capturedTimeouts: Array<{ callback: () => void; ms: number; stack: string }> = [];
    try {
      // Deterministically cover the `connect()` closed guard by simulating a reconnect timer that fires
      // after the client calls `session.close()` (a real race when a timer callback is already queued).
      globalThis.setTimeout = ((callback: any, ms: any, ...args: any[]) => {
        const id = originalSetTimeout(callback, ms, ...args) as any;
        try {
          const stack = (new Error().stack ?? '').replace(/\\/g, '/');
          if (stack.includes('plugins/realtime-compat/gemini/internal/session.ts') && typeof callback === 'function') {
            capturedTimeouts.push({
              callback: () => callback(...args),
              ms: Number(ms),
              stack
            });
          }
        } catch {}
        return id;
      }) as any;

      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' }, handshake: { readyFallbackMs: 60000 } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      await new Promise(res => originalSetTimeout(res, 50));

      const waitForReconnectTimerCallback = async (): Promise<() => void> => {
        const start = Date.now();
        while (Date.now() - start < 2000) {
          // The setupComplete deadline timer uses readyFallbackMs (configured above),
          // but reconnect backoff is <= 2000ms.
          const match = capturedTimeouts.find(t => t.ms <= 2000 && t.stack.includes('scheduleReconnect'));
          if (match) return match.callback;
          await new Promise(res => originalSetTimeout(res, 10));
        }
        throw new Error('Timed out waiting for reconnect timer to be scheduled');
      };

      const reconnectCallback = await waitForReconnectTimerCallback();

      await session.close();
      reconnectCallback();

      await new Promise(res => originalSetTimeout(res, 25));
      const setupCount = server.messages.filter(m => m?.setup?.model === 'models/m').length;
      expect(setupCount).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      await server.close();
    }
  });

  test('stops reconnecting after max attempts', async () => {
    const server = await startWsServer({ closeOnSetup: true });
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' }, handshake: { readyFallbackMs: 60000 } }
      } as any);

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      const waitForSetupCount = async (count: number, timeoutMs: number) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const current = server.messages.filter(m => m?.setup?.model === 'models/m').length;
          if (current >= count) return;
          await new Promise(res => setTimeout(res, 10));
        }
        throw new Error('Timed out waiting for reconnect attempts');
      };

      await waitForSetupCount(4, 10000);
      await new Promise(res => setTimeout(res, 2000));
      const finalSetupCount = server.messages.filter(m => m?.setup?.model === 'models/m').length;
      expect(finalSetupCount).toBe(4);

      const error = await waitForSessionEvent({
        iterator: it,
        predicate: (evt) => evt?.type === 'error' && evt?.code === 'setup_incomplete',
        timeoutMs: 5000
      });
      expect(String(error.message)).toContain('setupComplete');

      const closed = await waitForSessionEvent({
        iterator: it,
        predicate: (evt) => evt?.type === 'closed',
        timeoutMs: 2000
      });
      expect(closed.reason).toBe('error');

      await expect(session.sendText({ text: 'hi' } as any)).rejects.toThrow('closed');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('closes when setupComplete deadline is exceeded', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' }, handshake: { readyFallbackMs: 200 } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      const error = await waitForSessionEvent({
        iterator: it,
        predicate: (evt) => evt?.type === 'error' && evt?.code === 'setup_timeout',
        timeoutMs: 5000
      });
      expect(String(error.message)).toContain('setupComplete');

      const closed = await waitForSessionEvent({
        iterator: it,
        predicate: (evt) => evt?.type === 'closed',
        timeoutMs: 2000
      });
      expect(closed.reason).toBe('timeout');

      await expect(session.sendText({ text: 'hi' } as any)).rejects.toThrow('closed');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('resolves urlTemplate/query substitutions when establishing the websocket', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: {
            urlTemplate: `${server.urlTemplate}?fromTemplate={model}`,
            headers: {},
            query: { static: '1', fromQuery: '{model}' }
          }
        } as any,
        spec: { provider: 'google', model: 'a/b' }
      } as any);

      await server.waitForConnection();
      expect(server.getRequestUrl()).toContain('fromTemplate=a%2Fb');
      expect(server.getRequestUrl()).toContain('static=1');
      expect(server.getRequestUrl()).toContain('fromQuery=a%2Fb');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits an error with close code/reason when websocket closes abnormally after setupComplete', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      server.closeClientWithReason(1011, 'boom');

      const error = await waitForSessionEvent({
        iterator: it,
        predicate: (evt) => evt?.type === 'error' && evt?.code === 'ws_close',
        timeoutMs: 5000
      });
      expect(String(error.message)).toContain('1011');
      expect(String(error.message)).toContain('boom');

      const closed = await waitForSessionEvent({
        iterator: it,
        predicate: (evt) => evt?.type === 'closed',
        timeoutMs: 5000
      });
      expect(closed.reason).toBe('provider_close');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('sends text/audio/commit/interrupt/tool responses with expected message shapes', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        tools: [
          {
            name: 'test.echo',
            description: 'Echo a message',
            parametersJsonSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message']
            }
          }
        ],
        spec: {
          provider: 'google',
          model: 'm',
          turnDetection: { mode: 'manual_commit' },
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
          }
        }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      await session.sendText({ text: 'hi' });
      await waitForMessage(server.messages, m => m?.clientContent?.turnComplete === false, 2000);

      await session.commit();
      await waitForMessage(server.messages, m => m?.clientContent?.turnComplete === true, 2000);

      await session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' });
      await waitForMessage(server.messages, m => m?.realtimeInput?.audio?.mimeType?.startsWith('audio/pcm'), 2000);
      expect(server.messages.some(m => m?.realtimeInput?.activityStart)).toBe(true);

      // While an activity is in progress, sendText uses realtimeInput.text to avoid ordering issues.
      await session.sendText({ text: 'hi2' });
      await waitForMessage(server.messages, m => m?.realtimeInput?.text === 'hi2', 2000);

      await session.commit();
      await waitForMessage(server.messages, m => m?.realtimeInput?.activityEnd, 2000);

      await session.interrupt();
      await waitForMessage(server.messages, m => m?.realtimeInput?.activityStart, 2000);

      // Tool response uses name from prior tool call mapping.
      server.sendToClient({ toolCall: { functionCalls: [{ id: 'c1', name: 'test_echo', args: { message: 'Tokyo' } }] } });
      while (true) {
        const evt = await it.next();
        if (evt.done) throw new Error('Expected tool call event');
        if (evt.value.type === 'tool_call.end' && (evt.value as any).toolCallId === 'c1') {
          // Incoming provider name (test_echo) is mapped back to unified tool name (test.echo).
          expect((evt.value as any).name).toBe('test.echo');
          break;
        }
      }

      await session.sendToolResult({ toolCallId: 'c1', result: { ok: true } });
      await waitForMessage(
        server.messages,
        m =>
          m?.toolResponse?.functionResponses?.[0]?.id === 'c1' &&
          m?.toolResponse?.functionResponses?.[0]?.name === 'test_echo' &&
          m?.toolResponse?.functionResponses?.[0]?.response?.ok === true,
        2000
      );

      await session.sendToolResult({ toolCallId: 'c1', result: 'ok' });
      await waitForMessage(
        server.messages,
        m =>
          m?.toolResponse?.functionResponses?.[0]?.id === 'c1' &&
          m?.toolResponse?.functionResponses?.[0]?.name === 'test_echo' &&
          m?.toolResponse?.functionResponses?.[0]?.response?.output === 'ok',
        2000
      );

      await session.sendToolResult({ toolCallId: 'missing', result: { ok: true } });
      await waitForMessage(
        server.messages,
        m =>
          m?.toolResponse?.functionResponses?.[0]?.id === 'missing' &&
          m?.toolResponse?.functionResponses?.[0]?.name === 'missing' &&
          m?.toolResponse?.functionResponses?.[0]?.response?.ok === true,
        2000
      );

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('interrupt falls back to clientContent noop when activity detection is enabled', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'server_vad' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      const before = server.messages.length;
      await session.interrupt();
      await new Promise(res => setTimeout(res, 25));

      const next = server.messages.slice(before);
      expect(next.some(m => m?.clientContent?.turnComplete === false && Array.isArray(m?.clientContent?.turns))).toBe(true);

      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });

  test('emits user_speech.started on audio send and user_speech.stopped at turn completion in server_vad mode', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'server_vad' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      await session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' });
      const started = await it.next();
      expect(started.value).toEqual({ type: 'user_speech.started' });

      server.sendToClient({ serverContent: { turnComplete: true } });

      while (true) {
        const evt = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for user_speech.stopped')), 2000))
        ]);
        if (evt.done) throw new Error('Expected user_speech.stopped event');
        if (evt.value.type === 'user_speech.stopped') break;
      }

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits user_transcript.final at turn completion after audio activity commit', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      await session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAA=' });
      // Ensure the transcription update is processed before committing, otherwise
      // the commit-boundary final may not be emitted yet under heavy test load.
      await it.next(); // user_speech.started
      server.sendToClient({ serverContent: { inputTranscription: { text: 'hello' } } });

      // Wait for the delta to confirm server message processing.
      while (true) {
        const evt = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for user_transcript.delta')), 2000))
        ]);
        if (evt.done) throw new Error('Expected user_transcript.delta event');
        if (evt.value.type === 'user_transcript.delta') break;
      }

      await session.commit();
      server.sendToClient({ serverContent: { turnComplete: true } });

      while (true) {
        const evt = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for user_transcript.final')), 2000))
        ]);
        if (evt.done) throw new Error('Expected user_transcript.final event');
        if (evt.value.type === 'user_transcript.final') {
          expect((evt.value as any).text).toBe('hello');
          break;
        }
      }

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits ws_close without reason when websocket closes abnormally after setupComplete with empty reason', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm', turnDetection: { mode: 'manual_commit' } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      server.closeClientWithReason(1011, '');

      const error = await waitForSessionEvent({
        iterator: it,
        predicate: (evt) => evt?.type === 'error' && evt?.code === 'ws_close',
        timeoutMs: 5000
      });
      expect(String(error.message)).toContain('1011');
      expect(String(error.message)).not.toContain('reason=');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits invalid_json error when server sends malformed JSON', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm' }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      server.sendRawToClient('not-json');
      const evt = await it.next();
      expect(evt.value).toEqual({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits event_mapping_failed when mapper throws during audio decode', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm' }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      server.sendToClient({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] } }
      });

      while (true) {
        const evt = await it.next();
        if (evt.done) throw new Error('Expected event_mapping_failed error');
        if (evt.value.type === 'error' && (evt.value as any).code === 'event_mapping_failed') break;
      }

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('emits ws_error when websocket handshake fails and still emits ready first', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      socket.destroy();
    });

    await new Promise<void>(resolve => server.listen(0, () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');

    const session = createGeminiRealtimeCompatSession({
      provider: {
        id: 'google',
        compat: 'gemini',
        endpoint: { urlTemplate: `ws://127.0.0.1:${address.port}/not-ws`, headers: {} }
      } as any,
      spec: { provider: 'google', model: 'm' }
    } as any);

    try {
      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      while (true) {
        const evt = await it.next();
        if (evt.done) throw new Error('Expected ws_error event');
        if (evt.value.type === 'error') {
          expect((evt.value as any).code).toBe('ws_error');
          break;
        }
      }
    } finally {
      await session.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('emits closed(provider_close) when server closes the websocket', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm' }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.value.type).toBe('ready');

      server.closeClient();
      const closed = await it.next();
      expect(closed.value).toEqual({ type: 'closed', reason: 'provider_close' });
    } finally {
      await server.close();
    }
  });

  test('close() terminates when websocket is not open', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm' }
      } as any);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('methods buffer before websocket open', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm' }
      } as any);

      await expect(session.sendText({ text: 'hi' })).resolves.toBeUndefined();
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('methods reject after close (covers closed guard)', async () => {
    const server = await startWsServer();
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        spec: { provider: 'google', model: 'm' }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);
      server.sendToClient({ setupComplete: {} });

      const it = session.events()[Symbol.asyncIterator]();
      await it.next();

      await session.close();
      await expect(session.sendText({ text: 'hi' })).rejects.toThrow('Realtime session is closed');
      await it.next();
    } finally {
      await server.close();
    }
  });
});
