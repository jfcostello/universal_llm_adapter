import { jest } from '@jest/globals';
import { createRequire } from 'module';

import { createWsTransport } from '@/plugins/realtime-compat/openai/internal/transport/ws.ts';
import { createOpenAIRealtimeWsCompatSession } from '@/plugins/realtime-compat/openai/internal/session-ws.ts';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

async function startWsServer() {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  const received: string[] = [];

  wss.on('connection', (ws: any) => {
    ws.on('message', (data: any) => {
      received.push(String(data));
    });
  });

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');

  const url = `ws://127.0.0.1:${address.port}/realtime`;

  const close = async () => {
    await new Promise<void>(resolve => wss.close(() => resolve()));
  };

  return { url, received, close };
}

async function waitForEvent<T>(
  iter: AsyncIterator<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const next = await iter.next();
    if (next.done) throw new Error('Iterator closed');
    if (predicate(next.value)) return next.value;
  }
  throw new Error('Timed out waiting for event');
}

describe('plugins/realtime-compat/openai — ws transport', () => {
  test('guards send() before open, supports send() after open, and close() is idempotent', async () => {
    const server = await startWsServer();
    try {
      const transport = createWsTransport({ url: server.url });

      // Before open: should throw (covers ws.readyState guard).
      expect(() => transport.send('x')).toThrow('Realtime websocket not open');

      const it = transport.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'open');

      transport.send('hello');
      await new Promise(res => setTimeout(res, 25));
      expect(server.received).toContain('hello');

      transport.close();
      transport.close(); // idempotent (covers early return branch)

      expect(() => transport.send('nope')).toThrow('Transport is closed');
    } finally {
      await server.close();
      jest.restoreAllMocks();
    }
  });

  test('ws session falls back to empty headers when provider config omits headers', async () => {
    const server = await startWsServer();
    try {
      const session = createOpenAIRealtimeWsCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.url, headers: undefined }
        } as any,
        spec: { provider: 'openai', model: 'm' }
      } as any);

      const it = session.events()[Symbol.asyncIterator]();
      // session.update will be sent after transport open, then server will echo session.updated only if it parses it.
      // For this unit case, just ensure we can close cleanly without throwing.
      await new Promise(res => setTimeout(res, 25));
      await session.close();
      await it.next();
    } finally {
      await server.close();
    }
  });
});
