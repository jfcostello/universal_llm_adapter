import crypto from 'crypto';
import { jest } from '@jest/globals';
import http from 'http';
import { createServer } from '@/utils/server/index.ts';
import {
  baseSpec,
  canBindToLocalhost,
  delay,
  openSse,
  postJson,
  requestRaw
} from './test-helpers.ts';

let networkAvailable = true;

beforeAll(async () => {
  networkAvailable = await canBindToLocalhost();
});

describe('utils/server (integration) security + concurrency', () => {
  test('adds security headers by default', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/run', baseSpec);
    await server.close();

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  test('security headers can be disabled', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      securityHeadersEnabled: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/run', baseSpec);
    await server.close();

    expect(res.headers['x-content-type-options']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  test('CORS preflight and POST include CORS headers when enabled', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      cors: {
        enabled: true,
        allowedOrigins: ['https://example.com'],
        allowedHeaders: ['content-type', 'authorization'],
        allowCredentials: false
      },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const preflight = await requestRaw(server.url, {
      method: 'OPTIONS',
      path: '/run',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization'
      }
    });

    const res = await requestRaw(server.url, {
      method: 'POST',
      path: '/run',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify(baseSpec)
    });

    await server.close();

    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(String(res.headers['access-control-allow-headers'])).toContain('content-type');
  });

  test('auth rejects missing credentials before parsing body', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      auth: { enabled: true, apiKeys: ['k1'] },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await requestRaw(server.url, {
      method: 'POST',
      path: '/run',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json}'
    });

    await server.close();

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('unauthorized');
  });

  test('auth supports custom headerName and allow toggles', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      auth: {
        enabled: true,
        apiKeys: ['k2'],
        headerName: 'x-custom-key',
        allowBearer: false,
        allowApiKeyHeader: true
      },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const bearerRejected = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer k2'
    });

    const ok = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      'x-custom-key': 'k2'
    });

    await server.close();

    expect(bearerRejected.status).toBe(401);
    expect(ok.status).toBe(200);
  });

  test('auth supports hashedKeys', async () => {
    if (!networkAvailable) return;

    const token = 'k3';
    const digest = crypto.createHash('sha256').update(token).digest('hex');

    const server = await createServer({
      auth: {
        enabled: true,
        hashedKeys: [`sha256:${digest}`]
      },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const ok = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      'x-api-key': token
    });
    await server.close();

    expect(ok.status).toBe(200);
  });

  test('authorize callback can deny (403)', async () => {
    if (!networkAvailable) return;

    const authorize = jest.fn().mockResolvedValue(false);

    const server = await createServer({
      auth: { enabled: true, apiKeys: ['k4'] },
      authorize,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer k4'
    });
    await server.close();

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('forbidden');
    expect(authorize).toHaveBeenCalled();
  });

  test('rateLimit trustProxyHeaders uses x-forwarded-for when enabled', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      rateLimit: { enabled: true, requestsPerMinute: 0, burst: 1, trustProxyHeaders: true },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const first = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.1.1.1'
    });
    const second = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      'x-forwarded-for': '2.2.2.2'
    });

    await server.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test('rateLimit ignores x-forwarded-for when trustProxyHeaders is false', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      rateLimit: { enabled: true, requestsPerMinute: 0, burst: 1, trustProxyHeaders: false },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const first = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.1.1.1'
    });
    const second = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      'x-forwarded-for': '2.2.2.2'
    });

    await server.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(JSON.parse(second.body).error.code).toBe('rate_limited');
  });

  test('rateLimit uses auth identity over IP when auth enabled', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      auth: { enabled: true, apiKeys: ['k5'] },
      rateLimit: { enabled: true, requestsPerMinute: 0, burst: 1, trustProxyHeaders: true },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const first = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer k5',
      'x-forwarded-for': '1.1.1.1'
    });
    const second = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer k5',
      'x-forwarded-for': '2.2.2.2'
    });

    await server.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  test('queues /run requests when saturated', async () => {
    if (!networkAvailable) return;

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const server = await createServer({
      maxConcurrentRequests: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 1000,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockImplementation(async () => {
            await firstGate;
            return { ok: true };
          }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        })),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const firstPromise = postJson(server.url, '/run', baseSpec);
    await delay(10);
    const secondPromise = postJson(server.url, '/run', baseSpec);

    const raced = await Promise.race([
      secondPromise.then(() => 'done'),
      delay(30).then(() => 'pending')
    ]);
    expect(raced).toBe('pending');

    releaseFirst?.();
    const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
    await server.close();

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
  });

  test('queue full rejects /run with 503 server_busy', async () => {
    if (!networkAvailable) return;

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const server = await createServer({
      maxConcurrentRequests: 1,
      maxQueueSize: 0,
      queueTimeoutMs: 1000,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockImplementation(async () => {
            await firstGate;
            return { ok: true };
          }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        })),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const firstPromise = postJson(server.url, '/run', baseSpec);
    await delay(10);
    const secondRes = await postJson(server.url, '/run', baseSpec);

    releaseFirst?.();
    await firstPromise;
    await server.close();

    expect(secondRes.status).toBe(503);
    expect(JSON.parse(secondRes.body).error.code).toBe('server_busy');
  });

  test('queueTimeoutMs rejects queued /run with 503 queue_timeout', async () => {
    if (!networkAvailable) return;

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const server = await createServer({
      maxConcurrentRequests: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 100,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockImplementation(async () => {
            await firstGate;
            return { ok: true };
          }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        })),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const firstPromise = postJson(server.url, '/run', baseSpec);
    await delay(10);
    const secondRes = await postJson(server.url, '/run', baseSpec);

    releaseFirst?.();
    await firstPromise;
    await server.close();

    expect(secondRes.status).toBe(503);
    expect(JSON.parse(secondRes.body).error.code).toBe('queue_timeout');
  });

  test('run and stream concurrency limiters are isolated', async () => {
    if (!networkAvailable) return;

    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>(resolve => {
      releaseRun = resolve;
    });

    const server = await createServer({
      maxConcurrentRequests: 1,
      maxConcurrentStreams: 1,
      maxQueueSize: 0,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockImplementation(async () => {
            await runGate;
            return { ok: true };
          }),
          runStream: async function* () {
            yield { type: 'delta', content: 'ok' };
          },
          close: jest.fn().mockResolvedValue(undefined)
        })),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const runPromise = postJson(server.url, '/run', baseSpec);
    await delay(10);

    const streamClient = openSse(server.url, '/stream', baseSpec);
    await streamClient.ready;
    await streamClient.waitForEventCount(1, 2000);
    await streamClient.ended;

    releaseRun?.();
    const runRes = await runPromise;
    await server.close();

    expect(streamClient.getStatus()).toBe(200);
    expect(runRes.status).toBe(200);
  });

  test('CORS preflight handled even when method is OPTIONS', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      cors: {
        enabled: true,
        allowedOrigins: ['https://example.com'],
        allowedHeaders: ['content-type'],
        allowCredentials: false
      },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const target = new URL('/run', server.url);
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'OPTIONS',
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          headers: {
            Origin: 'https://example.com',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
          }
        },
        (response) => {
          response.resume();
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

    await server.close();

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
  });
});
