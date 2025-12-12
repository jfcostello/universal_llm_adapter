import { jest } from '@jest/globals';
import http from 'http';
import { createServer } from '@/utils/server/index.ts';
import {
  baseSpec,
  canBindToLocalhost,
  delay,
  postJson,
  requestRaw
} from './test-helpers.ts';

let networkAvailable = true;

beforeAll(async () => {
  networkAvailable = await canBindToLocalhost();
});

describe('utils/server (integration) transport + timeouts', () => {
  test('POST /run returns wrapped response and closes coordinator', async () => {
    if (!networkAvailable) return;

    const fakeResponse = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
    const coordinator = {
      run: jest.fn().mockResolvedValue(fakeResponse),
      runStream: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined)
    };

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue(coordinator),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/run', baseSpec);
    await server.close();

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('response');
    expect(parsed.data.content[0].text).toBe('ok');
    expect(coordinator.close).toHaveBeenCalled();
  });

  test('invalid JSON returns 400 with error wrapper', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
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

    const res = await requestRaw(server.url, {
      method: 'POST',
      path: '/run',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json}'
    });
    await server.close();

    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('error');
    expect(parsed.error.code).toBe('invalid_json');
  });

  test('invalid spec returns 400 validation error', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
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

    const res = await postJson(server.url, '/run', { messages: [], settings: {} });
    await server.close();

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('validation_error');
  });

  test('unsupported content-type returns 415', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
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

    const res = await requestRaw(server.url, {
      method: 'POST',
      path: '/run',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(baseSpec)
    });
    await server.close();

    expect(res.status).toBe(415);
    expect(JSON.parse(res.body).error.code).toBe('unsupported_media_type');
  });

  test('too-large body returns 413', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      maxRequestBytes: 50,
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

    const large = { ...baseSpec, metadata: { big: 'x'.repeat(100) } };
    const res = await postJson(server.url, '/run', large);
    await server.close();

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe('payload_too_large');
  });

  test('unknown path returns 404', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
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

    const res = await postJson(server.url, '/nope', baseSpec);
    await server.close();

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.message).toContain('Not found');
  });

  test('non-POST method returns 405', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
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

    const res = await requestRaw(server.url, { method: 'GET', path: '/run' });
    await server.close();

    expect(res.status).toBe(405);
    expect(JSON.parse(res.body).error.message).toContain('Method not allowed');
  });

  test('POST /run accepts missing Content-Type', async () => {
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

    const res = await postJson(server.url, '/run', baseSpec, {});
    await server.close();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  test('POST /run accepts application/json; charset=utf-8', async () => {
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

    const res = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json; charset=utf-8'
    });
    await server.close();

    expect(res.status).toBe(200);
  });

  test('POST /run requestTimeoutMs returns 504 and does not deadlock limiter', async () => {
    if (!networkAvailable) return;

    let runCount = 0;
    const gate = new Promise<void>(resolve => setTimeout(resolve, 250));

    const server = await createServer({
      maxConcurrentRequests: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 500,
      requestTimeoutMs: 100,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockImplementation(async () => {
            runCount += 1;
            if (runCount === 1) {
              await gate;
            }
            return { ok: true };
          }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        })),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const firstRes = await postJson(server.url, '/run', baseSpec);
    expect(firstRes.status).toBe(504);
    expect(JSON.parse(firstRes.body).error.code).toBe('timeout');

    const secondPromise = postJson(server.url, '/run', baseSpec);
    const raced = await Promise.race([
      secondPromise.then(() => 'done'),
      delay(30).then(() => 'pending')
    ]);
    expect(raced).toBe('pending');

    const secondRes = await secondPromise;
    await server.close();

    expect(secondRes.status).toBe(200);
  });

  test('POST /run bodyReadTimeoutMs returns 408 when client stalls body', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      bodyReadTimeoutMs: 100,
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

    const target = new URL('/run', server.url);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '1000'
          }
        },
        (response) => {
          let body = '';
          response.on('data', chunk => (body += chunk.toString()));
          response.on('end', () => {
            req.destroy();
            resolve({ status: response.statusCode ?? 0, body });
          });
        }
      );
      req.on('error', reject);
      // Write a single byte to ensure the server starts reading the body, but never finish it.
      req.write(' ');
    });

    await server.close();

    expect(res.status).toBe(408);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('error');
    expect(parsed.error.code).toBe('body_read_timeout');
  });
});
