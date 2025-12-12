import { jest } from '@jest/globals';
import { createServer } from '@/utils/server/index.ts';
import {
  baseSpec,
  canBindToLocalhost,
  openSse,
  postJson,
  requestRaw
} from './test-helpers.ts';

let networkAvailable = true;

beforeAll(async () => {
  networkAvailable = await canBindToLocalhost();
});

describe('utils/server (integration) streaming semantics', () => {
  test('POST /stream responds with SSE headers', async () => {
    if (!networkAvailable) return;

    const events = [{ type: 'delta', content: 'Hi' }];

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: async function* () {
            for (const ev of events) yield ev;
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const res = await postJson(server.url, '/stream', baseSpec);
    await server.close();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.headers['cache-control'])).toContain('no-cache');
    expect(String(res.headers['connection'])).toContain('keep-alive');
    expect(res.body).toContain(`data: ${JSON.stringify(events[0])}`);
  });

  test('POST /stream closes coordinator on completion', async () => {
    if (!networkAvailable) return;

    const coordinator = {
      run: jest.fn(),
      runStream: async function* () {
        yield { type: 'delta', content: 'ok' };
      },
      close: jest.fn().mockResolvedValue(undefined)
    };

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue(coordinator),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const res = await postJson(server.url, '/stream', baseSpec);
    await server.close();

    expect(res.status).toBe(200);
    expect(coordinator.close).toHaveBeenCalled();
  });

  test('invalid JSON on /stream returns 400 JSON error (not SSE)', async () => {
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
      path: '/stream',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json}'
    });

    await server.close();

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body).error.code).toBe('invalid_json');
  });

  test('invalid spec on /stream returns 400 validation error (not SSE)', async () => {
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

    const res = await postJson(server.url, '/stream', { messages: [], settings: {} });
    await server.close();

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('validation_error');
  });

  test('POST /stream delivers first event before stream completes', async () => {
    if (!networkAvailable) return;

    const firstEvent = { type: 'delta', content: 'first' };
    const secondEvent = { type: 'delta', content: 'second' };

    let releaseSecond: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: async function* () {
            yield firstEvent;
            await gate;
            yield secondEvent;
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const client = openSse(server.url, '/stream', baseSpec);
    await client.ready;
    expect(client.getStatus()).toBe(200);

    await client.waitForEventCount(1, 2000);
    expect(client.events[0]).toEqual(firstEvent);

    releaseSecond?.();
    await client.waitForEventCount(2, 2000);
    await client.ended;

    await server.close();

    expect(client.events[1]).toEqual(secondEvent);
  });

  test('POST /stream maps mid-stream throw to SSE error event', async () => {
    if (!networkAvailable) return;

    const firstEvent = { type: 'delta', content: 'ok' };

    const server = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: async function* () {
            yield firstEvent;
            throw new Error('boom');
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    });

    const client = openSse(server.url, '/stream', baseSpec);
    await client.ready;
    await client.waitForEventCount(2, 2000);
    await client.ended;
    await server.close();

    expect(client.events[0]).toEqual(firstEvent);
    expect(client.events[1]).toMatchObject({
      type: 'error',
      error: { message: 'boom', code: 'internal' }
    });
  });

  test('POST /stream requestTimeoutMs closes SSE with timeout error', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      requestTimeoutMs: 100,
      streamIdleTimeoutMs: 0,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: async function* () {
            await new Promise(() => {});
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const client = openSse(server.url, '/stream', baseSpec);
    await client.ready;
    await client.waitForEventCount(1, 2000);
    await client.ended;
    await server.close();

    expect(client.events[0]).toMatchObject({
      type: 'error',
      error: { code: 'timeout' }
    });
  });

  test('POST /stream streamIdleTimeoutMs closes SSE with idle timeout error', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      requestTimeoutMs: 0,
      streamIdleTimeoutMs: 100,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: async function* () {
            await new Promise(() => {});
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    const client = openSse(server.url, '/stream', baseSpec);
    await client.ready;
    await client.waitForEventCount(1, 2000);
    await client.ended;
    await server.close();

    expect(client.events[0]).toMatchObject({
      type: 'error',
      error: { code: 'stream_idle_timeout' }
    });
  });
});
