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
  const config = {
    maxRequestBytes: 1024,
    bodyReadTimeoutMs: 1000,
    requestTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
    maxConcurrentRequests: 10,
    maxConcurrentStreams: 10,
    maxQueueSize: 10,
    queueTimeoutMs: 1000
  };

  test('returns 405 for non-POST methods', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      },
      config
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
      },
      config
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
      },
      config
    });

    const req = makeReq('POST', '/unknown', JSON.stringify({}));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(404);
    const parsed = JSON.parse(out.body);
    expect(parsed.type).toBe('error');
  });

  test('rejects unsupported content-type with 415', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      },
      config
    });

    const req = makeReq('POST', '/run', JSON.stringify({}));
    req.headers['content-type'] = 'text/plain';
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(415);
    expect(JSON.parse(out.body).error.code).toBe('unsupported_media_type');
  });

  test('invokes close listener on /run client disconnect', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    const pending = handler(req, out.res);
    req.emit('close');
    await pending;
    expect(out.status).toBe(200);
  });

  test('invokes close listener on /stream client disconnect', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          runStream: async function* () {
            yield { type: 'response', data: { ok: true } } as any;
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, streamIdleTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    const pending = handler(req, out.res);
    req.emit('close');
    await pending;
    expect(out.status).toBe(200);
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
      },
      config
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
      },
      config
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
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
      },
      config
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
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
      },
      config
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('data:');
    expect(out.body).toContain('stream boom');
  });

  test('streams SSE response for /stream success', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          runStream: async function* () {
            yield { type: 'response', data: { ok: true } } as any;
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, streamIdleTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('data:');
    expect(out.body).toContain('"type":"response"');
  });

  test('times out /run when requestTimeoutMs exceeded', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 20));
            return { ok: true };
          }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, requestTimeoutMs: 5 }
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(504);
    expect(JSON.parse(out.body).error.code).toBe('timeout');
  });

  test('completes /run before timeout when requestTimeoutMs set', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, requestTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);
    expect(out.status).toBe(200);
  });

  test('timeout path handles later coordinator rejection', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 20));
            throw new Error('late boom');
          }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, requestTimeoutMs: 5 }
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);
    await new Promise(r => setTimeout(r, 30));
    expect(out.status).toBe(504);
  });

  test('handles coordinator error within timeout branch', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockRejectedValue(new Error('boom-timeout-branch')),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, requestTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(500);
    expect(JSON.parse(out.body).error.message).toContain('boom-timeout-branch');
  });

  test('times out /stream on request timeout', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          runStream: async function* () {
            await new Promise(() => {});
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, requestTimeoutMs: 5, streamIdleTimeoutMs: 1000 }
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('timeout');
  });

  test('swallows iterator.return rejection when coordinator close fails on timeout', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          runStream: async function* () {
            await new Promise(r => setTimeout(r, 20));
            yield { type: 'response', data: { ok: true } } as any;
          },
          close: jest.fn().mockRejectedValue(new Error('close boom'))
        }),
        closeLogger: jest.fn()
      },
      config: { ...config, requestTimeoutMs: 5, streamIdleTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);
    await new Promise(r => setTimeout(r, 40));

    expect(out.status).toBe(200);
    expect(out.body).toContain('timeout');
  });

  test('outer catch writes SSE error when writeHead throws after headers sent', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      },
      config
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );

    const out = makeRes();
    // Force writeHead to throw after setting headersSent
    out.res.writeHead = (code: number, h: any) => {
      out.res.headersSent = true;
      out.res.statusCode = code;
      throw new Error('writeHead boom');
    };

    await handler(req, out.res);

    expect(out.body).toContain('writeHead boom');
  });
});
