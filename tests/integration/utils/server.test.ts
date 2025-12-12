import { jest } from '@jest/globals';
import http from 'http';
import { createServer } from '@/utils/server/index.ts';
import type { LLMCallSpec } from '@/core/types.ts';

function postJson(url: string, path: string, payload: any): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const req = http.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { 'Content-Type': 'application/json' }
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

function postJsonStream(url: string, path: string, payload: any): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return postJson(url, path, payload);
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
});

