import { jest } from '@jest/globals';
import crypto from 'crypto';

describe('utils/server auth config resolution', () => {
  const prevApiKeys = process.env.LLM_ADAPTER_API_KEYS;

  afterEach(() => {
    if (prevApiKeys === undefined) {
      delete process.env.LLM_ADAPTER_API_KEYS;
    } else {
      process.env.LLM_ADAPTER_API_KEYS = prevApiKeys;
    }
  });

  test('createServerHandlerWithDefaults loads apiKey keys from env when keys are omitted', async () => {
    jest.resetModules();

    const digest = crypto.createHash('sha256').update('unused').digest('hex');
    process.env.LLM_ADAPTER_API_KEYS = `dev:secret,empty:,tokenonly,sig:sha256:${digest}`;

    const { createServerHandlerWithDefaults } = await import('@/modules/server/index.ts');

    let captured: any;
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn().mockResolvedValue(undefined) } as any,
      auth: { mode: 'apiKey' } as any,
      authorize: async (ctx) => {
        captured = ctx;
        return true;
      }
    } as any);

    const res: any = {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn()
    };

    await handler(
      { method: 'GET', url: '/extensions/list', headers: { 'x-api-key': 'secret' } } as any,
      res
    );

    expect(captured).toEqual({ mode: 'apiKey', subject: 'dev' });
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
  });

  test('createServerHandlerWithDefaults treats legacy { enabled: true } auth as apiKey', async () => {
    jest.resetModules();
    process.env.LLM_ADAPTER_API_KEYS = 'dev:secret';

    const { createServerHandlerWithDefaults } = await import('@/modules/server/index.ts');

    let captured: any;
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn().mockResolvedValue(undefined) } as any,
      auth: { enabled: true } as any,
      authorize: async (ctx) => {
        captured = ctx;
        return true;
      }
    } as any);

    const res: any = {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn()
    };

    await handler(
      { method: 'GET', url: '/extensions/list', headers: { 'x-api-key': 'secret' } } as any,
      res
    );

    expect(captured).toEqual({ mode: 'apiKey', subject: 'dev' });
  });

  test('createServer throws on invalid auth config types', async () => {
    jest.resetModules();
    const { createServer } = await import('@/modules/server/index.ts');
    await expect(createServer({ auth: 'nope' as any } as any)).rejects.toThrow('Invalid auth config');
  });

  test('createServer throws when auth object is missing mode', async () => {
    jest.resetModules();
    const { createServer } = await import('@/modules/server/index.ts');
    await expect(createServer({ auth: {} as any } as any)).rejects.toThrow('Auth mode is required');
  });

  test('createServer throws when apiKey auth has no keys', async () => {
    jest.resetModules();
    delete process.env.LLM_ADAPTER_API_KEYS;
    const { createServer } = await import('@/modules/server/index.ts');
    await expect(createServer({ auth: { mode: 'apiKey' } as any } as any)).rejects.toThrow(
      'apiKey auth requires at least one key'
    );
  });

  test('createServer maps jwt allowApiKeyHeader to allowHeader', async () => {
    jest.resetModules();

    let capturedAuth: any;
    (jest as any).unstable_mockModule('../../../../modules/server/internal/handler.js', () => ({
      createServerHandler: (opts: any) => {
        capturedAuth = opts?.config?.auth;
        return async (_req: any, res: any) => {
          res.statusCode = 200;
          res.end();
        };
      }
    }));

    const { createServer } = await import('@/modules/server/index.ts');
    const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };

    const running = await createServer({
      registry: registry as any,
      auth: { mode: 'jwt', allowApiKeyHeader: false } as any,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      } as any
    } as any);

    expect(capturedAuth).toMatchObject({ mode: 'jwt', allowHeader: false });
    await running.close();
  });

  test('createServer supports proxySigned auth mode passthrough', async () => {
    jest.resetModules();

    let capturedAuth: any;
    (jest as any).unstable_mockModule('../../../../modules/server/internal/handler.js', () => ({
      createServerHandler: (opts: any) => {
        capturedAuth = opts?.config?.auth;
        return async (_req: any, res: any) => {
          res.statusCode = 200;
          res.end();
        };
      }
    }));

    const { createServer } = await import('@/modules/server/index.ts');
    const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };

    const running = await createServer({
      registry: registry as any,
      auth: { mode: 'proxySigned' } as any,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      } as any
    } as any);

    expect(capturedAuth).toMatchObject({ mode: 'proxySigned' });
    await running.close();
  });

  test('createServer throws on unsupported auth modes', async () => {
    jest.resetModules();
    const { createServer } = await import('@/modules/server/index.ts');
    await expect(createServer({ auth: { mode: 'wat' } as any } as any)).rejects.toThrow(
      'Unsupported auth mode: wat'
    );
  });
});
