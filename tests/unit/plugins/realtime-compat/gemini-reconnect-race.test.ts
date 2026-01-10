import { jest } from '@jest/globals';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const wsLib = require('ws');

async function startWsServer(options?: { closeOnSetup?: boolean }) {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  const messages: any[] = [];

  let socket: any | undefined;
  wss.on('connection', (ws: any) => {
    socket = ws;
    ws.on('message', (data: any) => {
      const shouldClose = options?.closeOnSetup === true;
      try {
        const parsed = JSON.parse(data.toString());
        messages.push(parsed);
        if (shouldClose && parsed?.setup) {
          try { ws.close(); } catch {}
        }
      } catch {
        messages.push({ type: '__unparsed__', raw: data.toString() });
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const urlTemplate = `ws://127.0.0.1:${address.port}/live`;

  const close = async () => {
    try { socket?.close?.(); } catch {}
    await new Promise<void>(resolve => wss.close(() => resolve()));
  };

  return { urlTemplate, messages, close };
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

describe('plugins/realtime-compat/gemini session (reconnect race)', () => {
  test('does not reconnect after close even if reconnect callback executes', async () => {
    const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
    if (!unstableMockModule) {
      throw new Error('jest.unstable_mockModule is not available in this environment');
    }

    jest.resetModules();

    await unstableMockModule('../../../../modules/shared/index.js', async () => {
      return {
        __esModule: true,
        calculateBackoffDelay: () => 0,
        setUnrefTimeout: (cb: () => void, ms: number) => {
          const msFloor = Math.max(0, Math.floor(Number(ms)));
          if (msFloor === 0) {
            const dummy = setTimeout(() => {}, 1);
            (dummy as any).unref?.();
            const fire = setTimeout(cb, 25);
            (fire as any).unref?.();
            return dummy as any;
          }
          const timer = setTimeout(cb, msFloor);
          (timer as any).unref?.();
          return timer as any;
        }
      };
    });

    const { createGeminiRealtimeCompatSession } = await import('@/plugins/realtime-compat/gemini/internal/session.ts');

    const server = await startWsServer({ closeOnSetup: true });
    try {
      const session = createGeminiRealtimeCompatSession({
        provider: {
          id: 'google',
          compat: 'gemini',
          endpoint: { urlTemplate: server.urlTemplate, headers: {} }
        } as any,
        // Keep setupComplete deadline far away; this test is about reconnect-after-close.
        spec: { provider: 'google', model: 'm', handshake: { readyFallbackMs: 60000 } }
      } as any);

      await waitForMessage(server.messages, m => m?.setup?.model === 'models/m', 2000);

      // Allow the server-side close to trigger reconnect scheduling.
      await new Promise(res => setTimeout(res, 5));

      await session.close();

      // Wait long enough for the mocked reconnect callback to run.
      await new Promise(res => setTimeout(res, 100));

      const setupCount = server.messages.filter(m => m?.setup?.model === 'models/m').length;
      expect(setupCount).toBe(1);
    } finally {
      await server.close();
    }
  });
});
