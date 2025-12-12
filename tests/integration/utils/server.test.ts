import { jest } from '@jest/globals';
import http from 'http';
import { createServer } from '@/utils/server/index.ts';
import type { LLMCallSpec } from '@/core/types.ts';

function postJson(
  url: string,
  path: string,
  payload: any,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const req = http.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers
      },
      (res) => {
        let body = '';
        res.on('data', chunk => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body
          });
        });
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function postJsonStream(
  url: string,
  path: string,
  payload: any,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return postJson(url, path, payload, headers);
}

function postRaw(
  url: string,
  path: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const req = http.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers
      },
      (res) => {
        let responseBody = '';
        res.on('data', chunk => (responseBody += chunk.toString()));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: responseBody
          })
        );
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let networkAvailable = true;

beforeAll(async () => {
  const probe = http.createServer((_, res) => res.end('ok'));
  try {
    await new Promise<void>((resolve, reject) => {
      probe.listen(0, '127.0.0.1', resolve);
      probe.on('error', reject);
    });
  } catch (error: any) {
    if (error?.code === 'EPERM') {
      networkAvailable = false;
    } else {
      throw error;
    }
  } finally {
    probe.close();
  }
});

describe('utils/server createServer', () => {
  const baseSpec: LLMCallSpec = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    llmPriority: [{ provider: 'test-provider', model: 'test-model' }],
    settings: { temperature: 0 }
  } as any;

  test('POST /run returns wrapped response', async () => {
    if (!networkAvailable) {
      console.warn('Skipping server network test: binding not permitted');
      return;
    }

    const coordinators: any[] = [];
    const fakeResponse = {
      provider: 'test-provider',
      model: 'test-model',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }]
    };

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => {
          const coordinator = {
            run: jest.fn().mockResolvedValue(fakeResponse),
            runStream: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined)
          };
          coordinators.push(coordinator);
          return coordinator;
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const res = await postJson(server.url, '/run', baseSpec);
    await server.close();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('response');
    expect(parsed.data.content[0].text).toBe('ok');
    expect(coordinators[0].close).toHaveBeenCalled();
  });

  test('POST /stream returns SSE events', async () => {
    if (!networkAvailable) {
      console.warn('Skipping server network test: binding not permitted');
      return;
    }

    const events = [
      { type: 'delta', content: 'Hi' },
      { type: 'done' }
    ];

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => ({
          run: jest.fn(),
          runStream: async function* () {
            for (const ev of events) yield ev;
          },
          close: jest.fn().mockResolvedValue(undefined)
        })),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const res = await postJsonStream(server.url, '/stream', baseSpec);
    await server.close();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain(`data: ${JSON.stringify(events[0])}`);
    expect(res.body).toContain(`data: ${JSON.stringify(events[1])}`);
  });

  test('invalid JSON returns 400 with error wrapper', async () => {
    if (!networkAvailable) {
      console.warn('Skipping server network test: binding not permitted');
      return;
    }

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({ run: jest.fn(), runStream: jest.fn(), close: jest.fn() }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const target = new URL('/run', server.url);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          headers: { 'Content-Type': 'application/json' }
        },
        (response) => {
          let body = '';
          response.on('data', chunk => (body += chunk.toString()));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.write('{bad json}');
      req.end();
    });

    await server.close();

    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.type).toBe('error');
    expect(parsed.error.message).toContain('Invalid JSON');
  });

  test('invalid spec returns 400 validation error', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({ run: jest.fn(), runStream: jest.fn(), close: jest.fn() }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const res = await postJson(server.url, '/run', { messages: [], settings: {} });
    await server.close();

    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('validation_error');
  });

  test('unsupported content-type returns 415', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({ run: jest.fn(), runStream: jest.fn(), close: jest.fn() }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const res = await postRaw(
      server.url,
      '/run',
      JSON.stringify(baseSpec),
      { 'Content-Type': 'text/plain' }
    );
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
        createCoordinator: jest.fn().mockResolvedValue({ run: jest.fn(), runStream: jest.fn(), close: jest.fn() }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const large = { ...baseSpec, metadata: { big: 'x'.repeat(100) } };
    const res = await postJson(server.url, '/run', large);
    await server.close();

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe('payload_too_large');
  });

  test('queues requests when saturated', async () => {
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

    const raced = await Promise.race([secondPromise.then(() => 'done'), delay(20).then(() => 'pending')]);
    expect(raced).toBe('pending');

    releaseFirst?.();
    const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
    await server.close();

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
  });

  test('queue full rejects with 503', async () => {
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

  test('stream idle timeout closes SSE with error', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      streamIdleTimeoutMs: 10,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockImplementation(() => ({
          run: jest.fn(),
          runStream: async function* () {
            await new Promise(() => {});
          },
          close: jest.fn().mockResolvedValue(undefined)
        })),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJsonStream(server.url, '/stream', baseSpec);
    await server.close();

    expect(res.status).toBe(200);
    expect(res.body).toContain('stream_idle_timeout');
  });

  test('auth enabled rejects missing key', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      auth: { enabled: true, apiKeys: ['k1'] },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({ run: jest.fn(), runStream: jest.fn(), close: jest.fn() }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/run', baseSpec);
    await server.close();
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('unauthorized');
  });

  test('auth enabled allows bearer token', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      auth: { enabled: true, apiKeys: ['k1'] },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn()
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer k1'
    });
    await server.close();
    expect(res.status).toBe(200);
  });

  test('auth enabled allows x-api-key', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      auth: { enabled: true, apiKeys: ['k2'] },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn()
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const res = await postJson(server.url, '/run', baseSpec, {
      'Content-Type': 'application/json',
      'x-api-key': 'k2'
    });
    await server.close();
    expect(res.status).toBe(200);
  });

  test('rate limiting returns 429 when exceeded', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1 },
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn()
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const first = await postJson(server.url, '/run', baseSpec);
    const second = await postJson(server.url, '/run', baseSpec);
    await server.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(JSON.parse(second.body).error.code).toBe('rate_limited');
  });

  test('CORS preflight handled when enabled', async () => {
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
        createCoordinator: jest.fn().mockResolvedValue({ run: jest.fn(), runStream: jest.fn(), close: jest.fn() }),
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
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
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
