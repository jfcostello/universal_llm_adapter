import { createRequire } from 'module';

import { AsyncQueue } from '../../../kernel/index.js';

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
  return String(data);
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
  return String(data);
}

export function createWsTransport(options: { url: string; headers?: Record<string, string> }): RealtimeTransport {
  const require = createRequire(import.meta.url);
  const wsLib = require('ws');

  const ws: WsLike = new wsLib.WebSocket(options.url, { headers: options.headers ?? {} });
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeTransportEvent>();

  // Split state: sendClosed guards send(), queueEnded guards queue termination
  let sendClosed = false;
  let queueEnded = false;

  const endQueueOnce = () => {
    if (queueEnded) return;
    queueEnded = true;
    queue.push({ type: 'close' });
    queue.close();
  };

  ws.on('open', () => {
    queue.push({ type: 'open' });
  });

  ws.on('message', (data: unknown) => {
    try {
      const text = decodeWsMessage(data);
      queue.push({ type: 'message', data: text });
    } catch (err: any) {
      /* istanbul ignore next -- defensive error handling for malformed ws messages */
      queue.push({ type: 'error', error: err, code: 'ws_message_decode_error' });
    }
  });

  ws.on('error', (err: any) => {
    queue.push({ type: 'error', error: err, code: 'ws_error' });
  });

  ws.on('close', () => {
    sendClosed = true;
    endQueueOnce();
  });

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
      if (sendClosed) return;
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
