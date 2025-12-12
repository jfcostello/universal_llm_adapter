import { jest } from '@jest/globals';
import { Readable } from 'stream';
import { createServerHandler } from '@/utils/server/internal/handler.ts';

function makeReq(method: string, url: string, body: string = ''): any {
  const req = new Readable({
    read() {
      if (body) this.push(body);
      this.push(null);
    }
  }) as any;
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function makeRes() {
  let status = 0;
  let headers: any = {};
  let body = '';

  const res: any = {
    headersSent: false,
    writeHead: (code: number, h: any) => {
      status = code;
      headers = h;
      res.headersSent = true;
    },
    write: (chunk: any) => {
      body += chunk.toString();
      res.headersSent = true;
      return true;
    },
    end: (chunk?: any) => {
      if (chunk) body += chunk.toString();
      res.headersSent = true;
    }
  };

  return { res, get status() { return status; }, get headers() { return headers; }, get body() { return body; } };
}

describe('utils/server createServerHandler', () => {
  const registry = { loadAll: jest.fn() } as any;

  test('returns 405 for non-POST methods', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      }
    });

    const req = makeReq('GET', '/run');
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(405);
    const parsed = JSON.parse(out.body);
    expect(parsed.type).toBe('error');
  });

  test('defaults missing method to GET and returns 405', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      }
    });

    const req = makeReq('POST', '/run', JSON.stringify({}));
    req.method = undefined;
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(405);
  });

  test('returns 404 for unknown routes', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      }
    });

    const req = makeReq('POST', '/unknown', JSON.stringify({}));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(404);
    const parsed = JSON.parse(out.body);
    expect(parsed.type).toBe('error');
  });

  test('defaults missing url to "/" and returns 404', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      }
    });

    const req = makeReq('POST', '/run', JSON.stringify({}));
    req.url = undefined;
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(404);
  });

  test('maps coordinator errors to 500 JSON error', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockRejectedValue(new Error('boom')),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      }
    });

    const req = makeReq('POST', '/run', JSON.stringify({ messages: [], llmPriority: [], settings: {} }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(500);
    const parsed = JSON.parse(out.body);
    expect(parsed.type).toBe('error');
    expect(parsed.error.message).toContain('boom');
  });

  test('uses default error message when error has no message', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockRejectedValue({ statusCode: 500 }),
        closeLogger: jest.fn()
      }
    });

    const req = makeReq('POST', '/run', JSON.stringify({ messages: [], llmPriority: [], settings: {} }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(500);
    expect(JSON.parse(out.body).error.message).toBe('Server error');
  });

  test('streams SSE error when /stream fails after headers sent', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn(),
          runStream: async function* () {
            throw new Error('stream boom');
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      }
    });

    const req = makeReq('POST', '/stream', JSON.stringify({ messages: [], llmPriority: [], settings: {} }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('data:');
    expect(out.body).toContain('stream boom');
  });
});
