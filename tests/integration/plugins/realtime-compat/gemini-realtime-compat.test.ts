import { createRequire } from 'module';

import GeminiRealtimeCompat from '@/plugins/realtime-compat/gemini/index.ts';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

async function startWsServer() {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  let socket: any | undefined;
  wss.on('connection', (ws: any) => {
    socket = ws;
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

  const waitForConnection = async (timeoutMs = 2000) => {
    const start = Date.now();
    while (!socket) {
      if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for socket');
      await new Promise(res => setTimeout(res, 10));
    }
  };

  return { urlTemplate, sendToClient, close, waitForConnection };
}

describe('integration/realtime-compat/gemini compat class', () => {
  test('default export implements IRealtimeCompat.createSession()', async () => {
    const server = await startWsServer();
    try {
      const compat = new (GeminiRealtimeCompat as any)();
      const session = compat.createSession({
        provider: {
          id: 'google',
          compat: 'google',
          endpoint: { urlTemplate: 'SDK_BASED_NOT_USED', method: 'POST', headers: {} },
          realtime: { compat: 'gemini', endpoint: { urlTemplate: server.urlTemplate, headers: {} } }
        },
        spec: { provider: 'google', model: 'm' }
      });

      // The compat emits ready after setupComplete.
      await server.waitForConnection();
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
});
