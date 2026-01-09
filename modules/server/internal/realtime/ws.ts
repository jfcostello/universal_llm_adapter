import type http from 'http';
import type net from 'net';
import { createRequire } from 'module';

import { createAudioRateLimiter } from '../transport/audio-rate-limiter.js';
import { createLimiter } from '../transport/limiter.js';
import type { UpgradeRouter } from '../transport/upgrade-router.js';
import { writeHttpUpgradeResponse } from '../transport/upgrade-router.js';

export interface RealtimeWsConfig {
  path: string;
  maxMessageBytes: number;
  idleTimeoutMs: number;
  openHandshakeTimeoutMs?: number;
  maxConcurrentSessions: number;
  maxAudioBytesPerSecond: number;
  maxSessionDurationMs: number;
}

export type RealtimeWsCreateSession = (options: {
  registry: any;
  spec: any;
}) => PromiseLike<any> | any;

type RealtimeClientMessage =
  | { type: 'open'; protocolVersion: 1; spec: any }
  | { type: 'send_text'; text: string; role?: 'system' | 'user' }
  | {
      type: 'send_audio';
      frame: {
        format: string;
        sampleRateHz: number;
        channels: 1 | 2;
        dataBase64: string;
        timestampMs?: number;
      };
    }
  | { type: 'inject_context'; items: any[] }
  | { type: 'commit' }
  | { type: 'interrupt'; reason?: string }
  | { type: 'close' };

type RealtimeServerEnvelope =
  | { type: 'event'; event: any }
  | { type: 'error'; error: { message: string; code?: string } };

function writeHttpResponse(socket: net.Socket, statusCode: number, statusText: string, body: string): void {
  writeHttpUpgradeResponse(socket, statusCode, statusText, body);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: any): Promise<T> {
  const ms = Math.floor(Number(timeoutMs));
  if (!Number.isFinite(ms) || ms <= 0) return await promise;

  return await new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    timer = setTimeout(() => reject(error), ms);
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref();

    promise
      .then(resolve, reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      });
  });
}

export async function attachRealtimeWsServer(options: {
  server: http.Server;
  upgradeRouter: UpgradeRouter;
  registry: any;
  createSession: RealtimeWsCreateSession;
  authorizeUpgrade: (req: http.IncomingMessage) => Promise<void> | void;
  config: RealtimeWsConfig;
}): Promise<{ close: () => Promise<void> }> {
  const require = createRequire(import.meta.url);
  const ws = require('ws');
  const wss = new ws.WebSocketServer({
    noServer: true,
    maxPayload: Math.floor(options.config.maxMessageBytes) + 1,
    perMessageDeflate: false
  });

  const limiter = createLimiter({
    maxConcurrent: options.config.maxConcurrentSessions,
    maxQueueSize: 0,
    queueTimeoutMs: 0
  });

  const statusTextFor = (statusCode: number): string => {
    const map: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      413: 'Payload Too Large',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      503: 'Service Unavailable'
    };
    return map[statusCode] ?? 'Error';
  };

  const onUpgrade = async (ctx: { req: http.IncomingMessage; socket: net.Socket; head: Buffer; pathname: string }) => {
    const { req, socket, head, pathname } = ctx;
    if (pathname !== options.config.path) return false;

    try {
      await options.authorizeUpgrade(req);
    } catch (err: any) {
      const statusCode = Number(err?.statusCode ?? 401);
      writeHttpResponse(socket, statusCode, statusTextFor(statusCode), err?.message ?? 'Unauthorized');
      socket.destroy();
      return true;
    }

    let release: (() => void) | undefined;
    try {
      release = await limiter.acquire();
    } catch {
      writeHttpResponse(socket, 503, statusTextFor(503), 'Server busy');
      socket.destroy();
      return true;
    }

    let upgraded = false;
    try {
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        upgraded = true;
        (ws as any).__realtimeRelease = release;
        wss.emit('connection', ws, req);
      });
    } catch {
      // If ws throws before establishing a ws connection, ensure we don't leak a limiter slot.
      try { release(); } catch {}
      try { socket.destroy(); } catch {}
      return true;
    }
    // If the ws library rejects the upgrade without throwing, the callback won't run.
    if (!upgraded) {
      try { release(); } catch {}
      try { socket.destroy(); } catch {}
    }
    return true;
  };

  const unregisterUpgrade = options.upgradeRouter.register(onUpgrade);

  wss.on('connection', (ws: any) => {
    const release: (() => void) = (ws as any).__realtimeRelease as () => void;

    let session: any | undefined;
    let openSeen = false;
    let closed = false;

    let idleTimeoutMs = options.config.idleTimeoutMs;
    let specIdleTimeoutAfterReadyMs: number | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let durationTimer: NodeJS.Timeout | undefined;
    const audioRateLimiter = createAudioRateLimiter(options.config.maxAudioBytesPerSecond);

    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
        return;
      }
      idleTimer = setTimeout(() => {
        send({ type: 'error', error: { message: 'Realtime WS idle timeout', code: 'ws_idle_timeout' } });
        try { ws.close(); } catch {}
      }, idleTimeoutMs);
    };

    const send = (env: RealtimeServerEnvelope) => {
      if (ws.readyState !== ws.OPEN) return;
      scheduleIdleCheck();
      ws.send(JSON.stringify(env));
    };

    const failAndClose = (message: string, code?: string) => {
      send({ type: 'error', error: { message, ...(code ? { code } : {}) } });
      try { ws.close(); } catch {}
    };

    const ensureOpen = () => {
      if (!openSeen || !session) {
        throw new Error('Session not open (expected open first)');
      }
    };

    const startEventPump = async (options: { openStartedAtMs: number; openHandshakeTimeoutMs: number }) => {
      if (!session?.events) {
        throw new Error('Session missing events()');
      }
      const iterator = (session.events() as AsyncIterable<any>)[Symbol.asyncIterator]();
      const remainingMs = options.openHandshakeTimeoutMs > 0
        ? Math.max(0, options.openHandshakeTimeoutMs - (Date.now() - options.openStartedAtMs))
        : 0;
      const first = await withTimeout(
        iterator.next(),
        remainingMs,
        Object.assign(new Error('Realtime WS open handshake timeout (ready)'), { code: 'ws_open_timeout' })
      );
      if (first.done) {
        failAndClose('Realtime session closed before ready', 'closed_before_ready');
        return;
      }
      if (first.value?.type !== 'ready') {
        failAndClose('Realtime session did not emit ready first', 'missing_ready');
        return;
      }
      send({ type: 'event', event: first.value });
      if (specIdleTimeoutAfterReadyMs !== undefined) {
        idleTimeoutMs = specIdleTimeoutAfterReadyMs;
        scheduleIdleCheck();
      }

      for await (const event of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<any>) {
        send({ type: 'event', event });
      }
    };

    const closeAll = async () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (durationTimer) clearTimeout(durationTimer);
      try {
        await session?.close?.();
      } catch {}
      try { release(); } catch {}
      try {
        if (ws.readyState === ws.OPEN) ws.close();
      } catch {}
    };

    ws.on('error', () => {
      void closeAll();
    });

    ws.on('close', () => {
      void closeAll();
    });

    scheduleIdleCheck();
    if (Number.isFinite(options.config.maxSessionDurationMs) && options.config.maxSessionDurationMs > 0) {
      durationTimer = setTimeout(() => {
        send({ type: 'error', error: { message: 'Realtime WS max session duration exceeded', code: 'ws_max_duration' } });
        try { ws.close(); } catch {}
      }, options.config.maxSessionDurationMs);
    }

    ws.on('message', async (data: any) => {
      scheduleIdleCheck();

      const buf = Buffer.from(data as any);
      const size = buf.length;
      if (size > options.config.maxMessageBytes) {
        failAndClose('WebSocket message too large', 'message_too_large');
        try { ws.close(1009); } catch {}
        return;
      }

      let msg: RealtimeClientMessage;
      try {
        msg = JSON.parse(buf.toString('utf-8'));
      } catch {
        failAndClose('Invalid JSON message', 'invalid_json');
        return;
      }

      try {
        switch (msg.type) {
          case 'open': {
            if (openSeen) {
              failAndClose('Session already open', 'already_open');
              return;
            }
            if (msg.protocolVersion !== 1) {
              failAndClose('Unsupported protocolVersion', 'unsupported_protocol');
              return;
            }
            const specIdleTimeoutMs = Number((msg as any)?.spec?.timeout?.idleTimeoutMs);
            if (Number.isFinite(specIdleTimeoutMs)) {
              specIdleTimeoutAfterReadyMs = Math.max(0, Math.floor(specIdleTimeoutMs));
            }
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = undefined;
            }
            const openStartedAtMs = Date.now();
            const openHandshakeTimeoutMs = Math.max(0, Math.floor(Number(options.config.openHandshakeTimeoutMs ?? 0)));
            session = await withTimeout(
              Promise.resolve(options.createSession({ registry: options.registry, spec: msg.spec })),
              openHandshakeTimeoutMs,
              Object.assign(new Error('Realtime WS open handshake timeout (createSession)'), { code: 'ws_open_timeout' })
            );
            if (closed) {
              try {
                await session?.close?.();
              } catch {}
              return;
            }
            openSeen = true;
            startEventPump({ openStartedAtMs, openHandshakeTimeoutMs })
              .catch(err => failAndClose(err?.message ?? String(err), err?.code))
              .finally(() => closeAll());
            return;
          }
          case 'send_text': {
            ensureOpen();
            await session.sendText({ text: msg.text, role: msg.role });
            return;
          }
          case 'send_audio': {
            ensureOpen();
            const approxBytes = Math.floor((msg.frame.dataBase64.length * 3) / 4);
            audioRateLimiter.charge(approxBytes);
            await session.sendAudio(msg.frame);
            return;
          }
          case 'inject_context': {
            ensureOpen();
            await session.injectContext(msg.items);
            return;
          }
          case 'commit': {
            ensureOpen();
            await session.commit();
            return;
          }
          case 'interrupt': {
            ensureOpen();
            await session.interrupt({ reason: msg.reason });
            return;
          }
          case 'close': {
            ensureOpen();
            await session.close();
            return;
          }
          default: {
            failAndClose('Unknown message type', 'unknown_type');
            return;
          }
        }
      } catch (err: any) {
        failAndClose(err?.message ?? String(err), err?.code);
      }
    });
  });

  const close = async () => {
    unregisterUpgrade();

    // Ensure connections are terminated so the parent HTTP server can close promptly.
    const clients: any[] = Array.from(wss.clients);
    for (const client of clients) {
      try { client.terminate(); } catch {}
    }

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { close };
}
