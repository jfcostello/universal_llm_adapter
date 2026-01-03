import { jest } from '@jest/globals';
import http from 'http';

import { attachRealtimeWsServer } from '@/modules/server/internal/realtime/ws.ts';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';

function toWsUrl(httpUrl: string, pathname: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

async function startHarness(options: {
  config: {
    path: string;
    maxMessageBytes: number;
    idleTimeoutMs: number;
    openHandshakeTimeoutMs?: number;
    maxConcurrentSessions: number;
    maxAudioBytesPerSecond: number;
    maxSessionDurationMs: number;
  };
  createSession: (opts: { registry: any; spec: any }) => Promise<any> | any;
  authorizeUpgrade?: (req: any) => Promise<void> | void;
}) {
  const server = http.createServer((_req, res) => res.end('ok'));
  const upgradeRouter = attachUpgradeRouter(server);
  const registry = { marker: true };
  const ws = await attachRealtimeWsServer({
    server,
    upgradeRouter,
    registry,
    authorizeUpgrade: options.authorizeUpgrade ?? (() => {}),
    createSession: options.createSession,
    config: options.config
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }
  const url = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    await ws.close();
    upgradeRouter.close();
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  };

  return { url, registry, close, server };
}

function openWs(url: string): Promise<{ ws: WebSocket; messages: any[]; closePromise: Promise<void> }> {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  const closePromise = new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
  });

  ws.onmessage = (evt: any) => {
    try {
      const text = typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf-8');
      messages.push(JSON.parse(text));
    } catch {
      // ignore
    }
  };

  return new Promise((resolve, reject) => {
    ws.onerror = (err) => reject(err);
    ws.onopen = () => resolve({ ws, messages, closePromise });
  });
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

describe('server/internal/realtime/ws', () => {
  test('ignores upgrade events for non-matching paths', async () => {
    const authorizeUpgrade = jest.fn();
    const createSession = jest.fn();

    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      authorizeUpgrade,
      createSession
    });

    try {
      const fakeSocket: any = { write: jest.fn(), destroy: jest.fn() };
      harness.server.emit('upgrade', { url: '/wrong' } as any, fakeSocket as any, Buffer.alloc(0));
      await new Promise(res => setTimeout(res, 0));

      expect(String(fakeSocket.write.mock.calls[0][0])).toContain('404 Not Found');
      expect(fakeSocket.destroy).toHaveBeenCalled();
      expect(authorizeUpgrade).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('rejects upgrade when authorizeUpgrade fails (and uses statusText mapping)', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      authorizeUpgrade: () => {
        throw Object.assign(new Error('Unauthorized: missing credentials'), { statusCode: 401 });
      },
      createSession: jest.fn()
    });

    try {
      const fakeSocket: any = { write: jest.fn(), destroy: jest.fn() };
      harness.server.emit('upgrade', { url: '/realtime/ws' } as any, fakeSocket as any, Buffer.alloc(0));
      await new Promise(res => setTimeout(res, 0));
      expect(String(fakeSocket.write.mock.calls[0][0])).toContain('401 Unauthorized');
      expect(fakeSocket.destroy).toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('rejects upgrade when authorizeUpgrade throws a non-Error (defaults to 401)', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      authorizeUpgrade: () => {
        throw 'boom';
      },
      createSession: jest.fn()
    });

    try {
      const fakeSocket: any = { write: jest.fn(), destroy: jest.fn() };
      harness.server.emit('upgrade', { url: '/realtime/ws' } as any, fakeSocket as any, Buffer.alloc(0));
      await new Promise(res => setTimeout(res, 0));
      expect(String(fakeSocket.write.mock.calls[0][0])).toContain('401 Unauthorized');
      expect(fakeSocket.destroy).toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('rejects upgrade with unknown statusCode using fallback statusText', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      authorizeUpgrade: () => {
        throw Object.assign(new Error('Nope'), { statusCode: 499 });
      },
      createSession: jest.fn()
    });

    try {
      const fakeSocket: any = { write: jest.fn(), destroy: jest.fn() };
      harness.server.emit('upgrade', { url: '/realtime/ws' } as any, fakeSocket as any, Buffer.alloc(0));
      await new Promise(res => setTimeout(res, 0));
      expect(String(fakeSocket.write.mock.calls[0][0])).toContain('499 Error');
      expect(fakeSocket.destroy).toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('rejects upgrade when maxConcurrentSessions is exceeded', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 1, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn()
    });

    try {
      const { ws, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));

      const fakeSocket: any = { write: jest.fn(), destroy: jest.fn() };
      harness.server.emit('upgrade', { url: '/realtime/ws' } as any, fakeSocket as any, Buffer.alloc(0));
      await new Promise(res => setTimeout(res, 0));
      expect(String(fakeSocket.write.mock.calls[0][0])).toContain('503 Service Unavailable');
      expect(fakeSocket.destroy).toHaveBeenCalled();

      try { ws.close(); } catch {}
      await closePromise;
    } finally {
      await harness.close();
    }
  });

  test('enforces maxAudioBytesPerSecond for send_audio', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    const session = {
      sendAudio: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 1, maxSessionDurationMs: 0 },
      createSession: jest.fn().mockResolvedValue(session)
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));

      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);

      ws.send(JSON.stringify({ type: 'send_audio', frame: { format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AAAA' } }));
      const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'audio_rate_limited', 2000);
      expect(String(err.error.message)).toContain('Audio rate limit');

      await closePromise;
      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('enforces maxSessionDurationMs', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 25 },
      createSession: jest.fn().mockResolvedValue({
        close: jest.fn(),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await new Promise<void>(() => {});
        }
      })
    });

    try {
      const { messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'ws_max_duration', 2000);
      expect(err.error.message).toContain('max session duration');
      await closePromise;
    } finally {
      await harness.close();
    }
  });

  test('terminates active connections when closing the WS server', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn()
    });

    let closed = false;
    try {
      const { closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      await harness.close();
      closed = true;
      await closePromise;
    } finally {
      if (!closed) {
        await harness.close();
      }
    }
  });

  test('closes idle connections with ws_idle_timeout', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 25, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn()
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));

      const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'ws_idle_timeout', 2000);
      expect(err.error.message).toContain('idle timeout');

      await closePromise;
      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('respects spec.timeout.idleTimeoutMs after open', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    const session = {
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        await new Promise(res => setTimeout(res, 150));
        yield { type: 'ready', sessionId: 's' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 50, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn().mockResolvedValue(session)
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: { timeout: { idleTimeoutMs: 500 } } }));

      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);
      expect(messages.some(m => m?.type === 'error' && m?.error?.code === 'ws_idle_timeout')).toBe(false);

      try { ws.close(); } catch {}
      await closePromise;
    } finally {
      await harness.close();
    }
  });

  test('enforces openHandshakeTimeoutMs when createSession hangs', async () => {
    const harness = await startHarness({
      config: {
        path: '/realtime/ws',
        maxMessageBytes: 1024 * 1024,
        idleTimeoutMs: 0,
        openHandshakeTimeoutMs: 25,
        maxConcurrentSessions: 20,
        maxAudioBytesPerSecond: 256000,
        maxSessionDurationMs: 0
      },
      createSession: jest.fn().mockImplementation(async () => new Promise(() => {}))
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));

      const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'ws_open_timeout', 2000);
      expect(err.error.message).toContain('open handshake timeout');

      await closePromise;
      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('enforces openHandshakeTimeoutMs when session never emits ready', async () => {
    const harness = await startHarness({
      config: {
        path: '/realtime/ws',
        maxMessageBytes: 1024 * 1024,
        idleTimeoutMs: 0,
        openHandshakeTimeoutMs: 25,
        maxConcurrentSessions: 20,
        maxAudioBytesPerSecond: 256000,
        maxSessionDurationMs: 0
      },
      createSession: jest.fn().mockResolvedValue({
        close: jest.fn(),
        events: async function* () {
          await new Promise<void>(() => {});
        }
      })
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));

      const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'ws_open_timeout', 2000);
      expect(err.error.message).toContain('open handshake timeout');

      await closePromise;
      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('closes session if WS closes before createSession resolves', async () => {
    let resolveSession: ((value: any) => void) | undefined;
    const createSessionPromise = new Promise((resolve) => {
      resolveSession = resolve as any;
    });
    const session = {
      close: jest.fn().mockResolvedValue(undefined),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
      }
    };

    const createSession = jest.fn().mockImplementation(async () => createSessionPromise);
    const harness = await startHarness({
      config: {
        path: '/realtime/ws',
        maxMessageBytes: 1024 * 1024,
        idleTimeoutMs: 0,
        openHandshakeTimeoutMs: 0,
        maxConcurrentSessions: 20,
        maxAudioBytesPerSecond: 256000,
        maxSessionDurationMs: 0
      },
      createSession
    });

    let clientWs: WebSocket | undefined;
    let harnessClosed = false;
    try {
      const { ws, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      clientWs = ws;

      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));

      const start = Date.now();
      while (createSession.mock.calls.length === 0 && Date.now() - start < 2000) {
        await new Promise(res => setTimeout(res, 10));
      }
      expect(createSession).toHaveBeenCalledTimes(1);

      await harness.close();
      harnessClosed = true;
      await closePromise;

      resolveSession?.(session);

      const startClosed = Date.now();
      while (session.close.mock.calls.length === 0 && Date.now() - startClosed < 2000) {
        await new Promise(res => setTimeout(res, 10));
      }
      expect(session.close).toHaveBeenCalledTimes(1);
    } finally {
      try { clientWs?.close(); } catch {}
      if (!harnessClosed) {
        await harness.close();
      }
    }
  });

  test('exchanges v1 protocol messages and forwards events', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    const session = {
      sendText: jest.fn().mockResolvedValue(undefined),
      injectContext: jest.fn().mockResolvedValue(undefined),
      sendAudio: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      interrupt: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's-1' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const createSession = jest.fn().mockResolvedValue(session);
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));

      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: { any: true } }));
      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);

      ws.send(JSON.stringify({ type: 'send_text', text: 'hi', role: 'user' }));
      ws.send(JSON.stringify({ type: 'inject_context', items: [{ role: 'system', text: 'Remember TOKEN_123' }] }));
      ws.send(JSON.stringify({ type: 'send_audio', frame: { format: 'pcm16', sampleRateHz: 24000, channels: 1, dataBase64: 'AA==' } }));
      ws.send(JSON.stringify({ type: 'commit' }));
      ws.send(JSON.stringify({ type: 'interrupt', reason: 'interrupt' }));
      ws.send(JSON.stringify({ type: 'close' }));

      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'closed', 2000);
      await closePromise;

      expect(createSession).toHaveBeenCalledWith({ registry: harness.registry, spec: { any: true } });
      expect(session.sendText).toHaveBeenCalledWith({ text: 'hi', role: 'user' });
      expect(session.injectContext).toHaveBeenCalledWith([{ role: 'system', text: 'Remember TOKEN_123' }]);
      expect(session.sendAudio).toHaveBeenCalled();
      expect(session.commit).toHaveBeenCalled();
      expect(session.interrupt).toHaveBeenCalledWith({ reason: 'interrupt' });
      expect(session.close).toHaveBeenCalled();

      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('fails on message before open', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 25, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn()
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      ws.send(JSON.stringify({ type: 'send_text', text: 'hi' }));

      const err = await waitForMessage(messages, m => m?.type === 'error', 2000);
      expect(String(err.error.message)).toContain('Session not open');
      await closePromise;
      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('reports non-Error thrown in message handler', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    const session = {
      sendText: jest.fn().mockImplementation(() => {
        throw 'boom';
      }),
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn().mockResolvedValue(session)
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));

      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);

      ws.send(JSON.stringify({ type: 'send_text', text: 'hi' }));
      const err = await waitForMessage(messages, m => m?.type === 'error', 2000);
      expect(String(err.error.message)).toContain('boom');

      await closePromise;
      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('fails on invalid JSON and oversized messages', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 64, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn()
    });

    try {
      // invalid JSON
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send(Buffer.from('not-json'));
        const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'invalid_json', 2000);
        expect(err.error.message).toContain('Invalid JSON');
        await closePromise;
        try { ws.close(); } catch {}
      }

      // too-large message
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        // maxPayload is configured to maxMessageBytes + 1, so this exceeds maxMessageBytes but is still deliverable.
        ws.send('x'.repeat(65));
        const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'message_too_large', 2000);
        expect(err.error.message).toContain('too large');
        await closePromise;
        try { ws.close(); } catch {}
      }

      // over maxPayload triggers ws-level close (and should not crash the server)
      {
        const { ws, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send('x'.repeat(1024));
        await closePromise;
        try { ws.close(); } catch {}
      }
    } finally {
      await harness.close();
    }
  });

  test('fails on unsupported protocolVersion and unknown message types', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn().mockResolvedValue({
        close: jest.fn(),
        events: async function* () {
          yield { type: 'ready', sessionId: 's' };
          await new Promise<void>(() => {});
        }
      })
    });

    try {
      // unsupported protocolVersion
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send(JSON.stringify({ type: 'open', protocolVersion: 2, spec: {} }));
        const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'unsupported_protocol', 2000);
        expect(err.error.message).toContain('Unsupported');
        await closePromise;
        try { ws.close(); } catch {}
      }

      // unknown message type after open
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
        await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);
        ws.send(JSON.stringify({ type: 'nope' }));
        const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'unknown_type', 2000);
        expect(err.error.message).toContain('Unknown');
        await closePromise;
        try { ws.close(); } catch {}
      }
    } finally {
      await harness.close();
    }
  });

  test('handles session ready contract violations', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest
        .fn()
        .mockResolvedValueOnce({
          close: jest.fn(),
          events: async function* () {
            // closes immediately
          }
        })
        .mockResolvedValueOnce({
          close: jest.fn(),
          events: async function* () {
            yield { type: 'not_ready' };
          }
        })
        .mockResolvedValueOnce({
          close: jest.fn(),
          // missing events()
        })
        .mockResolvedValueOnce({
          close: jest.fn(),
          events: async function* () {
            throw 'boom';
          }
        })
    });

    try {
      // closed before ready
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
        const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'closed_before_ready', 2000);
        expect(err.error.message).toContain('closed before ready');
        await closePromise;
        try { ws.close(); } catch {}
      }

      // missing ready first
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
        const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'missing_ready', 2000);
        expect(err.error.message).toContain('ready first');
        await closePromise;
        try { ws.close(); } catch {}
      }

      // session missing events()
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
        const err = await waitForMessage(messages, m => m?.type === 'error', 2000);
        expect(String(err.error.message)).toContain('events');
        await closePromise;
        try { ws.close(); } catch {}
      }

      // event pump throws non-Error
      {
        const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
        ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
        const err = await waitForMessage(messages, m => m?.type === 'error', 2000);
        expect(String(err.error.message)).toContain('boom');
        await closePromise;
        try { ws.close(); } catch {}
      }
    } finally {
      await harness.close();
    }
  });

  test('sends error when open is repeated (and avoids sending after close)', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    const session = {
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn().mockResolvedValue(session)
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);

      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
      const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'already_open', 2000);
      expect(err.error.message).toContain('already open');

      await closePromise;
      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });
});
