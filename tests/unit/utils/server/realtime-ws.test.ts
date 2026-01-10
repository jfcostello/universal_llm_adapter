import { jest } from '@jest/globals';
import http from 'http';
import net from 'net';
import { createRequire } from 'module';

import { attachRealtimeWsServer } from '@/modules/server/internal/realtime/ws.ts';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

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

  test('releases limiter slot when ws upgrade fails (invalid handshake)', async () => {
    const harness = await startHarness({
      config: {
        path: '/realtime/ws',
        maxMessageBytes: 1024 * 1024,
        idleTimeoutMs: 0,
        maxConcurrentSessions: 1,
        maxAudioBytesPerSecond: 256000,
        maxSessionDurationMs: 0
      },
      createSession: jest.fn()
    });

    try {
      // Send an invalid websocket upgrade request (missing Sec-WebSocket-* headers) that
      // should be rejected by the ws library without establishing a ws connection.
      const { port } = new URL(harness.url);
      const responseText = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
          socket.write(
            [
              'GET /realtime/ws HTTP/1.1',
              `Host: 127.0.0.1:${port}`,
              'Connection: Upgrade',
              'Upgrade: websocket',
              '',
              ''
            ].join('\r\n')
          );
        });
        const timer = setTimeout(() => {
          try { socket.destroy(); } catch {}
          reject(new Error('Timed out waiting for invalid upgrade response'));
        }, 2000);
        socket.on('error', (err) => {
          clearTimeout(timer);
          try { socket.destroy(); } catch {}
          reject(err);
        });
        socket.on('data', (chunk) => {
          clearTimeout(timer);
          const text = Buffer.from(chunk).toString('utf-8');
          try { socket.destroy(); } catch {}
          resolve(text);
        });
      });
      expect(responseText).toContain('HTTP/1.1');

      // If the limiter slot leaked, this would fail with 503 due to maxConcurrentSessions=1.
      const { ws, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      try {
        ws.close();
      } catch {}
      await closePromise;
    } finally {
      await harness.close();
    }
  });

  test('releases limiter slot when ws handleUpgrade throws', async () => {
    const originalHandleUpgrade = wsLib.WebSocketServer.prototype.handleUpgrade;
    (wsLib.WebSocketServer.prototype as any).handleUpgrade = () => {
      throw new Error('handleUpgrade blew up');
    };

    const harness = await startHarness({
      config: {
        path: '/realtime/ws',
        maxMessageBytes: 1024 * 1024,
        idleTimeoutMs: 0,
        maxConcurrentSessions: 1,
        maxAudioBytesPerSecond: 256000,
        maxSessionDurationMs: 0
      },
      createSession: jest.fn()
    });

    try {
      const fakeSocket: any = { write: jest.fn(), destroy: jest.fn() };
      harness.server.emit('upgrade', { url: '/realtime/ws' } as any, fakeSocket as any, Buffer.alloc(0));
      await new Promise(res => setTimeout(res, 0));
      expect(fakeSocket.destroy).toHaveBeenCalled();

      // Restore upgrades so we can verify a subsequent connection works (slot didn't leak).
      (wsLib.WebSocketServer.prototype as any).handleUpgrade = originalHandleUpgrade;

      const { ws, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      try {
        ws.close();
      } catch {}
      await closePromise;
    } finally {
      (wsLib.WebSocketServer.prototype as any).handleUpgrade = originalHandleUpgrade;
      await harness.close();
    }
  });

  test('releases limiter slot when message handling throws (messageChain resilient)', async () => {
    const originalOn = wsLib.WebSocketServer.prototype.on;
    let connectionCount = 0;

    (wsLib.WebSocketServer.prototype as any).on = function (event: string, cb: any) {
      if (event !== 'connection') return originalOn.call(this, event, cb);

      return originalOn.call(this, event, (ws: any, req: any) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          const originalSend = ws.send.bind(ws);
          let sendCalls = 0;
          ws.send = (...args: any[]) => {
            sendCalls += 1;
            if (sendCalls >= 2) {
              throw new Error('ws.send failed');
            }
            return originalSend(...args);
          };
        }
        return cb(ws, req);
      });
    };

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
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 1, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn().mockResolvedValue(session)
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));

      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));
      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);

      // Trigger failAndClose -> send(error). The wrapped server ws.send throws on the second send.
      ws.send('{not-json');

      await closePromise;
      expect(session.close).toHaveBeenCalled();

      // If the limiter slot leaked, this would fail with 503 (maxConcurrentSessions=1).
      const second = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      try {
        second.ws.close();
      } catch {}
      await second.closePromise;
    } finally {
      (wsLib.WebSocketServer.prototype as any).on = originalOn;
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
        yield { type: 'ready', sessionId: 's' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 5000, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
      createSession: jest.fn().mockResolvedValue(session)
    });

    try {
      const { ws, messages, closePromise } = await openWs(toWsUrl(harness.url, '/realtime/ws'));
      ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: { timeout: { idleTimeoutMs: 200 } } }));

      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'ready', 2000);
      const err = await waitForMessage(messages, m => m?.type === 'error' && m?.error?.code === 'ws_idle_timeout', 2000);
      expect(err.error.message).toContain('idle timeout');

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
      expect(err.error.message).toContain('createSession');

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
      expect(err.error.message).toContain('(ready)');

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

  test('processes messages sequentially (commit waits for sendText)', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    let unblockSendText: (() => void) | undefined;
    const sendTextBlocked = new Promise<void>((resolve) => {
      unblockSendText = resolve;
    });

    const session = {
      sendText: jest.fn().mockImplementation(async () => {
        await sendTextBlocked;
      }),
      commit: jest.fn().mockResolvedValue(undefined),
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
      ws.send(JSON.stringify({ type: 'commit' }));

      await new Promise(res => setTimeout(res, 50));
      expect(session.sendText).toHaveBeenCalledTimes(1);
      expect(session.commit).not.toHaveBeenCalled();

      unblockSendText?.();

      const start = Date.now();
      while (session.commit.mock.calls.length === 0 && Date.now() - start < 2000) {
        await new Promise(res => setTimeout(res, 10));
      }
      expect(session.commit).toHaveBeenCalledTimes(1);

      ws.send(JSON.stringify({ type: 'close' }));
      await waitForMessage(messages, m => m?.type === 'event' && m?.event?.type === 'closed', 2000);
      await closePromise;

      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('drops queued message handling after stopping and prevents duplicate failAndClose', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    let rejectSendText: ((err: any) => void) | undefined;
    const sendTextBlocked = new Promise<void>((_resolve, reject) => {
      rejectSendText = reject;
    });

    const session = {
      sendText: jest.fn().mockImplementation(async () => {
        await sendTextBlocked;
      }),
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's-1' };
        await new Promise(res => setTimeout(res, 100));
        throw Object.assign(new Error('boom'), { code: 'events_failed' });
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

      ws.send(JSON.stringify({ type: 'send_text', text: 'hi', role: 'user' }));
      ws.send(JSON.stringify({ type: 'send_text', text: 'ignored', role: 'user' }));

      const startSendText = Date.now();
      while (session.sendText.mock.calls.length === 0 && Date.now() - startSendText < 2000) {
        await new Promise(res => setTimeout(res, 10));
      }
      expect(session.sendText).toHaveBeenCalledTimes(1);

      // Wait for the event pump failure to trigger failAndClose once.
      await waitForMessage(messages, m => m?.type === 'error' && String(m?.error?.message).includes('boom'), 2000);
      expect(messages.filter(m => m?.type === 'error').length).toBe(1);

      // Fail send_text so the queued message can be evaluated against the stopping guard.
      rejectSendText?.(new Error('sendText failed'));

      await closePromise;

      // The second failure should not emit an additional error envelope.
      expect(messages.filter(m => m?.type === 'error').length).toBe(1);
      expect(session.sendText).toHaveBeenCalledTimes(1);

      try { ws.close(); } catch {}
    } finally {
      await harness.close();
    }
  });

  test('fails on message before open', async () => {
    const harness = await startHarness({
      config: { path: '/realtime/ws', maxMessageBytes: 1024 * 1024, idleTimeoutMs: 0, maxConcurrentSessions: 20, maxAudioBytesPerSecond: 256000, maxSessionDurationMs: 0 },
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
