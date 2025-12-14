import { jest } from '@jest/globals';

import { createServer, createServerHandlerWithDefaults } from '@/utils/server/index.ts';

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
