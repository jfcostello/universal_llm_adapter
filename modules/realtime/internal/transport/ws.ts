import { createRequire } from 'module';

import { AsyncQueue } from '../../../../kernel/index.js';
import { calculateBackoffDelay, setUnrefTimeout } from '../../../shared/index.js';

type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

export type RealtimeTransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'error'; error: unknown; code?: string }
  | { type: 'close' };

export interface RealtimeTransport {
  send: (data: string) => void;
  events: () => AsyncIterable<RealtimeTransportEvent>;
  close: () => void;
}

/**
 * Decode ws message payload to string.
 * The ws library can deliver payloads as string, Buffer, ArrayBuffer, Buffer[], or Blob.
 * Note: createWsTransport uses the sync decoder in the message handler to preserve ordering.
 */
export async function decodeWsMessageAsync(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data) && data.length > 0 && data.every(Buffer.isBuffer)) {
    return Buffer.concat(data).toString('utf8');
  }
  // Handle Blob (browser environments or Node 15.7.0+)
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text();
  }
  // Fallback: attempt to stringify unknown types
  try {
    return String(data);
  } catch {
    return '[unstringifiable]';
  }
}

/**
 * Synchronous decode for ws message payload.
 * For Blob payloads, falls back to String() since async is not supported here.
 * Use decodeWsMessageAsync in environments where ws emits Blob payloads (e.g., binaryType: 'blob').
 */
export function decodeWsMessage(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data) && data.length > 0 && data.every(Buffer.isBuffer)) {
    return Buffer.concat(data).toString('utf8');
  }
  // Fallback: attempt to stringify unknown types (includes Blob which would need async)
  try {
    return String(data);
  } catch {
    return '[unstringifiable]';
  }
}

export function createWsTransport(options: {
  url: string;
  headers?: Record<string, string>;
  connectTimeoutMs?: number;
  maxConnectAttempts?: number;
}): RealtimeTransport {
  const require = createRequire(import.meta.url);
  const wsLib = require('ws');
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeTransportEvent>();

  // Split state: sendClosed guards send(), queueEnded guards queue termination.
  let sendClosed = false;
  let queueEnded = false;

  const connectTimeoutMs = Math.max(0, Math.floor(options.connectTimeoutMs ?? 20000));
  const maxConnectAttempts = Math.max(1, Math.floor(options.maxConnectAttempts ?? 3));

  let ws!: WsLike;
  let connectTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  const endQueueOnce = () => {
    if (queueEnded) return;
    queueEnded = true;
    queue.push({ type: 'close' });
    queue.close();
  };

  const clearConnectTimer = () => {
    if (!connectTimer) return;
    clearTimeout(connectTimer);
    connectTimer = undefined;
  };

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const scheduleRetry = (attemptIndex: number) => {
    clearRetryTimer();
    const delayMs = calculateBackoffDelay(attemptIndex, 250, 2000);
    retryTimer = setUnrefTimeout(() => {
      retryTimer = undefined;
      startConnectAttempt();
    }, delayMs);
  };

  let connectAttempt = 0;

  const startConnectAttempt = () => {
    connectAttempt += 1;
    const attemptNo = connectAttempt;

    let opened = false;
    let attemptFailure: { code: string; error?: unknown } = {
      code: 'ws_close',
      error: new Error('Realtime websocket closed before open')
    };

    const socket: WsLike = new wsLib.WebSocket(
      options.url,
      connectTimeoutMs > 0
        ? { headers: options.headers ?? {}, handshakeTimeout: connectTimeoutMs }
        : { headers: options.headers ?? {} }
    );
    ws = socket;

    clearConnectTimer();
    if (connectTimeoutMs > 0) {
      connectTimer = setUnrefTimeout(() => {
        attemptFailure = { code: 'ws_connect_timeout', error: new Error('Realtime websocket connect timeout') };
        try { socket.terminate(); } catch {}
      }, connectTimeoutMs);
    }

    socket.on('open', () => {
      opened = true;
      clearConnectTimer();
      queue.push({ type: 'open' });
    });

    socket.on('message', (data: unknown) => {
      const text = decodeWsMessage(data);
      queue.push({ type: 'message', data: text });
    });

    socket.on('error', (err: any) => {
      if (opened) {
        queue.push({ type: 'error', error: err, code: 'ws_error' });
        return;
      }

      if (attemptFailure.code === 'ws_close') {
        attemptFailure = { code: 'ws_error', error: err };
      }
      clearConnectTimer();
      try { socket.terminate(); } catch {}
    });

    socket.on('close', () => {
      clearConnectTimer();

      if (sendClosed) {
        endQueueOnce();
        return;
      }

      if (opened) {
        sendClosed = true;
        endQueueOnce();
        return;
      }

      if (attemptNo < maxConnectAttempts) {
        scheduleRetry(attemptNo - 1);
        return;
      }

      queue.push({ type: 'error', error: attemptFailure.error, code: attemptFailure.code });
      sendClosed = true;
      endQueueOnce();
    });
  };

  startConnectAttempt();

  return {
    send(data: string) {
      if (sendClosed) throw new Error('Transport is closed');
      if (ws.readyState !== WS_OPEN) throw new Error('Realtime websocket not open');
      ws.send(data);
    },
    events() {
      return queue.iterate();
    },
    close() {
      clearConnectTimer();
      clearRetryTimer();
      if (sendClosed) {
        endQueueOnce();
        return;
      }

      sendClosed = true;
      try {
        if (ws.readyState === WS_OPEN) {
          ws.close(1000, 'client_close');
        } else {
          ws.terminate();
        }
      } catch {}
      endQueueOnce();
    }
  };
}
