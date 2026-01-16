import { jest } from '@jest/globals';

describe('utils/server realtime WS authorizeUpgrade wiring', () => {
  test('throws 403 when authorize callback denies', async () => {
    jest.resetModules();

    let authorizeUpgrade: ((req: any) => Promise<void>) | undefined;

    (jest as any).unstable_mockModule('../../../../modules/server/internal/realtime/ws.js', () => ({
      attachRealtimeWsServer: async (opts: any) => {
        authorizeUpgrade = opts.authorizeUpgrade;
        return { close: jest.fn().mockResolvedValue(undefined) };
      }
    }));

    const authenticate = jest.fn().mockResolvedValue({ mode: 'apiKey', subject: 'subj' });
    (jest as any).unstable_mockModule('../../../../modules/auth/index.js', () => ({
      createAuthenticator: () => ({ authenticate })
    }));

    const check = jest.fn();
    (jest as any).unstable_mockModule('../../../../modules/server/internal/security/rate-limiter.js', () => ({
      createRateLimiter: () => ({ check }),
      getClientIp: jest.fn()
    }));

    const { createServer } = await import('@/modules/server/index.ts');

    const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
    const authorize = jest.fn().mockResolvedValue(false);

    const running = await createServer({
      registry: registry as any,
      realtime: { enabled: true },
      auth: { mode: 'apiKey', keys: [{ id: 'k1', token: 'k1' }] },
      authorize,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      } as any
    } as any);

    expect(typeof authorizeUpgrade).toBe('function');
    await expect(authorizeUpgrade!({})).rejects.toMatchObject({ statusCode: 403, code: 'forbidden' });

    await running.close();
  });

  test('uses unknown auth identity when subject is missing', async () => {
    jest.resetModules();

    let authorizeUpgrade: ((req: any) => Promise<void>) | undefined;

    (jest as any).unstable_mockModule('../../../../modules/server/internal/realtime/ws.js', () => ({
      attachRealtimeWsServer: async (opts: any) => {
        authorizeUpgrade = opts.authorizeUpgrade;
        return { close: jest.fn().mockResolvedValue(undefined) };
      }
    }));

    (jest as any).unstable_mockModule('../../../../modules/auth/index.js', () => ({
      createAuthenticator: () => ({
        authenticate: jest.fn().mockResolvedValue({ mode: 'apiKey' })
      })
    }));

    const check = jest.fn();
    (jest as any).unstable_mockModule('../../../../modules/server/internal/security/rate-limiter.js', () => ({
      createRateLimiter: () => ({ check }),
      getClientIp: jest.fn()
    }));

    const { createServer } = await import('@/modules/server/index.ts');

    const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
    const authorize = jest.fn().mockResolvedValue(true);

    const running = await createServer({
      registry: registry as any,
      realtime: { enabled: true },
      auth: { mode: 'apiKey', keys: [{ id: 'k1', token: 'k1' }] },
      rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1 },
      authorize,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      } as any
    } as any);

    expect(typeof authorizeUpgrade).toBe('function');
    await expect(authorizeUpgrade!({})).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledWith('unknown');

    await running.close();
  });
});
