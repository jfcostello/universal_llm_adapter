import { jest } from '@jest/globals';
import { createServer } from '@/utils/server/index.ts';
import { canBindToLocalhost, requestRaw } from './test-helpers.ts';
import path from 'path';

let networkAvailable = true;

beforeAll(async () => {
  networkAvailable = await canBindToLocalhost();
});

describe('utils/server (integration) health and readiness endpoints', () => {
  test('GET /health returns 200 with tiny JSON payload', async () => {
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

    const res = await requestRaw(server.url, { method: 'GET', path: '/health' });
    await server.close();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  test('GET /ready returns 200 when pluginsPath exists', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      pluginsPath: path.resolve(process.cwd(), 'plugins'),
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

    const res = await requestRaw(server.url, { method: 'GET', path: '/ready' });
    await server.close();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  test('GET /ready returns 503 when pluginsPath does not exist', async () => {
    if (!networkAvailable) return;

    const server = await createServer({
      pluginsPath: './this/path/does/not/exist',
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

    const res = await requestRaw(server.url, { method: 'GET', path: '/ready' });
    await server.close();

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: false });
  });
});
