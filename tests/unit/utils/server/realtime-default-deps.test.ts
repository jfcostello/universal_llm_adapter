import { jest } from '@jest/globals';
import { createRequire } from 'module';

describe('utils/server default realtime dependency wiring', () => {
  test('realtime WS uses default createRealtimeSession factory (dynamic import)', async () => {
    jest.resetModules();

    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    const session = {
      sendText: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const createRealtimeSessionMock = jest.fn().mockResolvedValue(session);
    (jest as any).unstable_mockModule('../../../../modules/realtime/index.js', () => ({
      createRealtimeSession: createRealtimeSessionMock
    }));

    const { createServer } = await import('@/modules/server/index.ts');

    const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
    const running = await createServer({
      registry: registry as any,
      host: '127.0.0.1',
      port: 0,
      realtime: { enabled: true, wsIdleTimeoutMs: 0, maxWsMessageBytes: 1024 },
      auth: { enabled: true, apiKeys: ['test-key'] },
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      } as any
    });

    const require = createRequire(import.meta.url);
    const WsClient = require('ws');

    const url = new URL(running.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/realtime/ws';
    url.search = '';

    const ws = new WsClient(url.toString(), { headers: { 'x-api-key': 'test-key' } });
    const messages: any[] = [];

    const closePromise = new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });

    ws.on('message', (data: any) => {
      try {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
        messages.push(JSON.parse(text));
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('error', (err: any) => reject(err));
      ws.on('open', () => resolve());
    });

    ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));

    const start = Date.now();
    let readySeen = false;
    while (Date.now() - start < 2000) {
      const found = messages.find(m => m?.type === 'event' && m?.event?.type === 'ready');
      if (found) {
        readySeen = true;
        break;
      }
      await new Promise(res => setTimeout(res, 10));
    }

    expect(readySeen).toBe(true);
    expect(createRealtimeSessionMock).toHaveBeenCalledWith(registry, {});

    ws.send(JSON.stringify({ type: 'close' }));
    await closePromise;
    try { ws.close(); } catch {}

    await running.close();
  });
});

