import { jest } from '@jest/globals';

import { createServer, createServerHandlerWithDefaults } from '@/modules/server/index.ts';

const DEFAULTS_WITHOUT_NESTED = {
  server: {
    maxRequestBytes: 1,
    bodyReadTimeoutMs: 1,
    requestTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
    maxConcurrentRequests: 1,
    maxConcurrentStreams: 1,
    maxQueueSize: 0,
    queueTimeoutMs: 0,
    securityHeadersEnabled: true
  }
} as any;

const DEFAULTS_WITHOUT_SECURITY_HEADERS = {
  server: {
    maxRequestBytes: 1,
    bodyReadTimeoutMs: 1,
    requestTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
    maxConcurrentRequests: 1,
    maxConcurrentStreams: 1,
    maxQueueSize: 0,
    queueTimeoutMs: 0
  }
} as any;

describe('utils/server index default branches', () => {
  test('createServerHandlerWithDefaults tolerates missing nested defaults', async () => {
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn() } as any,
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_NESTED
      } as any
    } as any);
    expect(typeof handler).toBe('function');
  });

  test('createServerHandlerWithDefaults falls back to getDefaults when deps.getDefaults is missing', async () => {
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn() } as any,
      deps: { getDefaults: undefined } as any
    } as any);
    expect(typeof handler).toBe('function');
  });

  test('createServerHandlerWithDefaults falls back to enabling security headers when default is missing', async () => {
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn() } as any,
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_SECURITY_HEADERS
      } as any
    } as any);

    const req: any = { method: 'GET', url: '/' };
    const res: any = {
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn()
    };

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalled();
  });

  test('createServer tolerates missing nested defaults and uses final fallback', async () => {
    const running = await createServer({
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_NESTED,
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await running.close();
  });

  test('createServer falls back to getDefaults when deps.getDefaults is missing', async () => {
    const running = await createServer({
      deps: {
        getDefaults: undefined,
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    await running.close();
  });

  test('createServer falls back to enabling security headers when default is missing', async () => {
    const running = await createServer({
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_SECURITY_HEADERS,
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    await running.close();
  });

  test('createServer uses default options when omitted', async () => {
    const running = await createServer();
    await running.close();
  });

  test('createServer attaches realtime WS when enabled', async () => {
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });

    const session = {
      close: jest.fn().mockImplementation(async () => closeResolve?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's' };
        await closed;
        yield { type: 'closed', reason: 'client_close' };
      }
    };

    const createRealtimeSession = jest.fn().mockResolvedValue(session);

    const running = await createServer({
      realtime: { enabled: true, wsIdleTimeoutMs: 0, maxWsMessageBytes: 1024 },
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_NESTED,
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        createRealtimeSession,
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const url = new URL(running.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/realtime/ws';
    url.search = '';

    const ws = new WebSocket(url.toString());
    const messages: any[] = [];
    const closePromise = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });

    ws.onmessage = (evt: any) => {
      try {
        const text = typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf-8');
        messages.push(JSON.parse(text));
      } catch {
        // ignore
      }
    };

    await new Promise<void>((resolve, reject) => {
      ws.onerror = (err: any) => reject(err);
      ws.onopen = () => resolve();
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

    expect(createRealtimeSession).toHaveBeenCalled();
    expect(readySeen).toBe(true);

    ws.send(JSON.stringify({ type: 'close' }));
    await closePromise;
    try { ws.close(); } catch {}

    await running.close();
  });

  test('realtime WS errors when session factory is missing', async () => {
    const running = await createServer({
      realtime: { enabled: true, wsIdleTimeoutMs: 0, maxWsMessageBytes: 1024 },
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_NESTED,
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const url = new URL(running.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/realtime/ws';
    url.search = '';

    const ws = new WebSocket(url.toString());
    const messages: any[] = [];
    const closePromise = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });

    ws.onmessage = (evt: any) => {
      try {
        const text = typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf-8');
        messages.push(JSON.parse(text));
      } catch {
        // ignore
      }
    };

    await new Promise<void>((resolve, reject) => {
      ws.onerror = (err: any) => reject(err);
      ws.onopen = () => resolve();
    });

    ws.send(JSON.stringify({ type: 'open', protocolVersion: 1, spec: {} }));

    const start = Date.now();
    let found: any | undefined;
    while (Date.now() - start < 2000) {
      found = messages.find(m => m?.type === 'error');
      if (found) {
        break;
      }
      await new Promise(res => setTimeout(res, 10));
    }
    expect(found).toBeDefined();
    expect(String(found.error.message)).toContain('Realtime session factory unavailable');

    await closePromise;
    try { ws.close(); } catch {}
    await running.close();
  });

  test('createServer uses securityHeadersEnabled override when provided', async () => {
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn() } as any,
      securityHeadersEnabled: false,
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_NESTED
      } as any
    } as any);

    const req: any = { method: 'GET', url: '/' };
    const res: any = {
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn()
    };

    await handler(req, res);

    // If security headers are disabled, we should not set any security headers.
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
