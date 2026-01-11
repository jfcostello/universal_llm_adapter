import { jest } from '@jest/globals';
import { createRequire } from 'module';
import fs from 'fs';
import http from 'http';
import path from 'path';

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
  afterEach(() => {
    delete process.env.LLM_ADAPTER_VALIDATE_PLUGINS;
  });

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
        createRealtimeSession: undefined,
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

  test('createServer loads enabled extensions and allows them to intercept /demo/*', async () => {
    const extensionDir = path.join(process.cwd(), 'extensions', 'demo');
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, 'index.ts'),
      `export default {\n` +
        `  name: 'demo',\n` +
        `  registerServer: () => ({\n` +
        `    handleHttp: (req, res) => {\n` +
        `      if (req.url?.startsWith('/demo/')) {\n` +
        `        res.statusCode = 200;\n` +
        `        res.setHeader('content-type', 'application/json');\n` +
        `        res.end(JSON.stringify({ ok: true }));\n` +
        `        return true;\n` +
        `      }\n` +
        `      return false;\n` +
        `    }\n` +
        `  })\n` +
        `};\n`,
      'utf-8'
    );

    let running: any;
    try {
      running = await createServer({
        extensions: { enabled: ['demo'] },
        deps: {
          getDefaults: () => DEFAULTS_WITHOUT_NESTED,
          createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
          createCoordinator: jest.fn(),
          closeLogger: jest.fn().mockResolvedValue(undefined)
        }
      } as any);

      const demoRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        http
          .get(`${running.url}/demo/test`, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.from(c)));
            res.on('end', () => {
              resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
            });
          })
          .on('error', reject);
      });

      expect(demoRes.statusCode).toBe(200);
      expect(JSON.parse(demoRes.body)).toEqual({ ok: true });

      const healthRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        http
          .get(`${running.url}/health`, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.from(c)));
            res.on('end', () => {
              resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
            });
          })
          .on('error', reject);
      });

      expect(healthRes.statusCode).toBe(200);
      expect(JSON.parse(healthRes.body)).toEqual({ ok: true });
    } finally {
      try {
        await running?.close?.();
      } catch {}
      fs.rmSync(extensionDir, { recursive: true, force: true });
    }
  });

  test('createServer optionally validates plugins once per registry when LLM_ADAPTER_VALIDATE_PLUGINS=1', async () => {
    process.env.LLM_ADAPTER_VALIDATE_PLUGINS = '1';

    const registry: any = {
      loadAll: jest.fn().mockResolvedValue(undefined),
      validateAll: jest.fn().mockResolvedValue(undefined)
    };

    const deps: any = {
      getDefaults: () => DEFAULTS_WITHOUT_NESTED,
      createRegistry: jest.fn().mockResolvedValue(registry),
      createCoordinator: jest.fn(),
      closeLogger: jest.fn().mockResolvedValue(undefined)
    };

    const first = await createServer({ deps } as any);
    await first.close();
    expect(registry.validateAll).toHaveBeenCalledTimes(1);

    const second = await createServer({ deps } as any);
    await second.close();
    expect(registry.validateAll).toHaveBeenCalledTimes(1);
  });

  test('createServer skips plugin validation when validateAll is not available', async () => {
    process.env.LLM_ADAPTER_VALIDATE_PLUGINS = '1';

    const registry: any = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const deps: any = {
      getDefaults: () => DEFAULTS_WITHOUT_NESTED,
      createRegistry: jest.fn().mockResolvedValue(registry),
      createCoordinator: jest.fn(),
      closeLogger: jest.fn().mockResolvedValue(undefined)
    };

    const running = await createServer({ deps } as any);
    await running.close();
  });

  test('createServer rejects realtime WS when auth is not enabled', async () => {
    await expect(createServer({
      realtime: { enabled: true },
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_NESTED,
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any)).rejects.toThrow('Realtime WS requires server auth to be enabled');
  });

  test('createServer attaches realtime WS when enabled', async () => {
    const require = createRequire(import.meta.url);
    const WsClient = require('ws');

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
      auth: { enabled: true, apiKeys: ['test-key'] },
      rateLimit: { enabled: true, requestsPerMinute: 60, burst: 10 },
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

    expect(createRealtimeSession).toHaveBeenCalled();
    expect(readySeen).toBe(true);

    ws.send(JSON.stringify({ type: 'close' }));
    await closePromise;
    try { ws.close(); } catch {}

    await running.close();
  });

  test('realtime WS errors when session factory is missing', async () => {
    const require = createRequire(import.meta.url);
    const WsClient = require('ws');

    const running = await createServer({
      realtime: { enabled: true, wsIdleTimeoutMs: 0, maxWsMessageBytes: 1024 },
      auth: { enabled: true, apiKeys: ['test-key'] },
      deps: {
        getDefaults: () => DEFAULTS_WITHOUT_NESTED,
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        createRealtimeSession: undefined,
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

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
