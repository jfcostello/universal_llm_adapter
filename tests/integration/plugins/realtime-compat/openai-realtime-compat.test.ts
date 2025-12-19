import { createRequire } from 'module';

import OpenAIRealtimeCompat from '@/plugins/realtime-compat/openai/index.ts';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

async function startWsServer() {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  let socket: any | undefined;
  wss.on('connection', (ws: any) => {
    socket = ws;
    ws.on('message', (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed?.type === 'session.update') {
          ws.send(JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }));
        }
      } catch {
        // ignore
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const urlTemplate = `ws://127.0.0.1:${address.port}/realtime?model={model}`;

  const close = async () => {
    try {
      socket?.close?.();
    } catch {}
    await new Promise<void>(resolve => wss.close(() => resolve()));
  };

  return { urlTemplate, close };
}

describe('integration/realtime-compat/openai compat class', () => {
  test('default export implements IRealtimeCompat.createSession()', async () => {
    const server = await startWsServer();
    try {
      const compat = new (OpenAIRealtimeCompat as any)();
      const session = await Promise.resolve(compat.createSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        },
        spec: { provider: 'openai', model: 'm' }
      }));

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
