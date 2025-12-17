import type http from 'http';
import type net from 'net';
import { createRequire } from 'module';

export interface RealtimeWsConfig {
  path: string;
  maxMessageBytes: number;
  idleTimeoutMs: number;
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
  | { type: 'commit' }
  | { type: 'interrupt'; reason?: string }
  | { type: 'close' };

type RealtimeServerEnvelope =
  | { type: 'event'; event: any }
  | { type: 'error'; error: { message: string; code?: string } };

function writeHttpResponse(socket: net.Socket, statusCode: number, statusText: string, body: string): void {
  const payload = String(body);
  const buf = Buffer.from(payload, 'utf-8');
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${buf.length}`,
      '',
      payload
    ].join('\r\n')
  );
}

function parseWsPath(req: http.IncomingMessage): string {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return raw.split('?')[0];
  }
}

export async function attachRealtimeWsServer(options: {
  server: http.Server;
  registry: any;
  createSession: RealtimeWsCreateSession;
  config: RealtimeWsConfig;
}): Promise<{ close: () => Promise<void> }> {
  const require = createRequire(import.meta.url);
  const ws = require('ws');
  const wss = new ws.WebSocketServer({ noServer: true });

  const onUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const pathname = parseWsPath(req);
    if (pathname !== options.config.path) {
      writeHttpResponse(socket, 404, 'Not Found', 'Not Found');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: any) => {
      wss.emit('connection', ws, req);
    });
  };

  options.server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: any) => {
    let session: any | undefined;
    let openSeen = false;
    let closed = false;

    let idleTimer: NodeJS.Timeout | undefined;
    let lastActivity = Date.now();

    const touch = () => {
      lastActivity = Date.now();
    };

    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!Number.isFinite(options.config.idleTimeoutMs) || options.config.idleTimeoutMs <= 0) {
        return;
      }
      idleTimer = setTimeout(() => {
        send({ type: 'error', error: { message: 'Realtime WS idle timeout', code: 'ws_idle_timeout' } });
        try { ws.close(); } catch {}
      }, options.config.idleTimeoutMs);
    };

    const send = (env: RealtimeServerEnvelope) => {
      if (ws.readyState !== ws.OPEN) return;
      touch();
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

    const startEventPump = async () => {
      if (!session?.events) {
        throw new Error('Session missing events()');
      }
      const iterator = (session.events() as AsyncIterable<any>)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) {
        failAndClose('Realtime session closed before ready', 'closed_before_ready');
        return;
      }
      if (first.value?.type !== 'ready') {
        failAndClose('Realtime session did not emit ready first', 'missing_ready');
        return;
      }
      send({ type: 'event', event: first.value });

      for await (const event of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<any>) {
        send({ type: 'event', event });
      }
    };

    const closeAll = async () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        await session?.close?.();
      } catch {}
      try {
        if (ws.readyState === ws.OPEN) ws.close();
      } catch {}
    };

    ws.on('close', () => {
      void closeAll();
    });

    touch();
    scheduleIdleCheck();

    ws.on('message', async (data: any) => {
      touch();
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
            session = await options.createSession({ registry: options.registry, spec: msg.spec });
            openSeen = true;
            startEventPump()
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
            await session.sendAudio(msg.frame);
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
    options.server.off('upgrade', onUpgrade);

    // Ensure connections are terminated so the parent HTTP server can close promptly.
    const clients: any[] = Array.from(wss.clients);
    for (const client of clients) {
      try { client.terminate(); } catch {}
    }

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { close };
}
