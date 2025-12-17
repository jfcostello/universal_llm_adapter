import { createRequire } from 'module';

import { AsyncQueue } from '../../../../../modules/kernel/index.js';

import type { IRealtimeTransport, RealtimeTransportEvent } from './types.js';

type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

export function createWsTransport(options: { url: string; headers?: Record<string, string> }): IRealtimeTransport {
  const require = createRequire(import.meta.url);
  const wsLib = require('ws');

  const ws: WsLike = new wsLib.WebSocket(options.url, { headers: options.headers ?? {} });
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeTransportEvent>();
  let closed = false;

  const closeOnce = () => {
    if (closed) return;
    closed = true;
    queue.push({ type: 'close' });
    queue.close();
  };

  ws.on('open', () => {
    queue.push({ type: 'open' });
  });

  ws.on('message', (data: any) => {
    const text = Buffer.from(data as any).toString('utf-8');
    queue.push({ type: 'message', data: text });
  });

  ws.on('error', (err: any) => {
    queue.push({ type: 'error', error: err, code: 'ws_error' });
  });

  ws.on('close', () => {
    closeOnce();
  });

  return {
    send(data: string) {
      if (closed) throw new Error('Transport is closed');
      if (ws.readyState !== WS_OPEN) throw new Error('Realtime websocket not open');
      ws.send(data);
    },
    events() {
      return queue.iterate();
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (ws.readyState === WS_OPEN) {
          ws.close(1000, 'client_close');
        } else {
          ws.terminate();
        }
      } catch {}
      closeOnce();
    }
  };
}
