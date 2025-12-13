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
    setHeader: (key: string, value: any) => {
      headers[key.toLowerCase()] = value;
    },
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
    queueTimeoutMs: 1000,
    auth: { enabled: false },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    securityHeadersEnabled: true
  };

  test('handles /vector/run with vector coordinator', async () => {
    const vectorExecute = jest.fn().mockResolvedValue({ ok: true });
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(), // LLM coordinator (unused)
        createVectorCoordinator: jest.fn().mockResolvedValue({
          execute: vectorExecute,
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config
    });

    const req = makeReq(
      'POST',
      '/vector/run',
      JSON.stringify({ operation: 'query', store: 'test', input: { vector: [0.1], topK: 1 } })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    const parsed = JSON.parse(out.body);
    expect(parsed.type).toBe('response');
    expect(parsed.data).toEqual({ ok: true });
    expect(vectorExecute).toHaveBeenCalled();
  });

  test('returns 501 when /vector/run is requested but vector coordinator is missing', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      } as any,
      config
    });

    const req = makeReq('POST', '/vector/run', JSON.stringify({ operation: 'query', store: 'test' }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(501);
    expect(JSON.parse(out.body).error.code).toBe('not_implemented');
  });

  test('handles /vector/embeddings/run with embedding coordinator', async () => {
    const embeddingExecute = jest.fn().mockResolvedValue({ ok: true });
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(), // LLM coordinator (unused)
        createEmbeddingCoordinator: jest.fn().mockResolvedValue({
          execute: embeddingExecute,
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config
    });

    const req = makeReq(
      'POST',
      '/vector/embeddings/run',
      JSON.stringify({ operation: 'embed', embeddingPriority: [{ provider: 'p' }], input: { texts: ['hello'] } })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    const parsed = JSON.parse(out.body);
    expect(parsed.type).toBe('response');
    expect(parsed.data).toEqual({ ok: true });
    expect(embeddingExecute).toHaveBeenCalled();
  });

  test('returns 501 when /vector/embeddings/run is requested but embedding coordinator is missing', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      } as any,
      config
    });

    const req = makeReq('POST', '/vector/embeddings/run', JSON.stringify({ operation: 'embed' }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(501);
    expect(JSON.parse(out.body).error.code).toBe('not_implemented');
  });

  test('handles /vector/stream with vector coordinator', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(), // LLM coordinator (unused)
        createVectorCoordinator: jest.fn().mockResolvedValue({
          executeStream: async function* () {
            yield { type: 'progress', progress: { current: 0, total: 1 } } as any;
            yield { type: 'done' } as any;
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, streamIdleTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/vector/stream',
      JSON.stringify({ operation: 'embed', store: 'test' })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('data:');
    expect(out.body).toContain('"type":"progress"');
  });

  test('streams SSE error when /vector/stream fails after headers sent', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn()
      } as any,
      config
    });

    const req = makeReq('POST', '/vector/stream', JSON.stringify({ operation: 'embed', store: 'test' }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('data:');
    expect(out.body).toContain('not_implemented');
  });

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

  test('handles missing optional security/auth/rateLimit/cors config', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: {
        maxRequestBytes: 1024,
        bodyReadTimeoutMs: 1000,
        requestTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
        maxConcurrentRequests: 10,
        maxConcurrentStreams: 10,
        maxQueueSize: 10,
        queueTimeoutMs: 1000
      } as any
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

  test('handles /stream when auth config is omitted', async () => {
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
      config: {
        ...config,
        auth: undefined,
        rateLimit: undefined
      } as any
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);
    expect(out.status).toBe(200);
  });

  test('uses auth identity as rate limit key when enabled', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: {
        ...config,
        auth: { enabled: true, apiKeys: ['k1'] },
        rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1, trustProxyHeaders: false }
      } as any
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    req.headers.authorization = 'Bearer k1';
    req.socket = { remoteAddress: '127.0.0.1' } as any;
    const out = makeRes();
    await handler(req, out.res);
    expect(out.status).toBe(200);
  });

  test('uses client IP as rate limit key when no auth identity', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: {
        ...config,
        auth: { enabled: false },
        rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1, trustProxyHeaders: false }
      } as any
    });

    const req = makeReq(
      'POST',
      '/run',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    req.socket = { remoteAddress: '127.0.0.1' } as any;
    const out = makeRes();
    await handler(req, out.res);
    expect(out.status).toBe(200);
  });

  test('falls back to unknown rate limit key when no auth or IP', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      },
      config: {
        ...config,
        auth: { enabled: false },
        rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1, trustProxyHeaders: false }
      } as any
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

  test('streams SSE error when /vector/stream coordinator throws after headers sent', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn().mockResolvedValue({
          executeStream: async function* () {
            throw new Error('vector stream boom');
          },
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config
    });

    const req = makeReq('POST', '/vector/stream', JSON.stringify({ operation: 'embed', store: 'test' }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('data:');
    expect(out.body).toContain('vector stream boom');
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

  test('applies rate limiting for /stream when enabled', async () => {
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
      config: {
        ...config,
        rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1, trustProxyHeaders: false }
      } as any
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    req.socket = { remoteAddress: '127.0.0.1' } as any;
    const out = makeRes();
    await handler(req, out.res);
    expect(out.status).toBe(200);
  });

  test('uses auth identity for /stream rate limiting when enabled', async () => {
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
      config: {
        ...config,
        auth: { enabled: true, apiKeys: ['k1'] },
        rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1, trustProxyHeaders: false }
      } as any
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    req.headers.authorization = 'Bearer k1';
    const out = makeRes();
    await handler(req, out.res);
    expect(out.status).toBe(200);
  });

  test('falls back to unknown key for /stream rate limiting when no auth or IP', async () => {
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
      config: {
        ...config,
        auth: { enabled: false },
        rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1, trustProxyHeaders: false }
      } as any
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);
    expect(out.status).toBe(200);
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

  test('times out /vector/run when requestTimeoutMs exceeded', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 20));
            return { ok: true };
          }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 5 }
    });

    const req = makeReq(
      'POST',
      '/vector/run',
      JSON.stringify({ operation: 'query', store: 's', input: { vector: [0.1], topK: 1 } })
    );
    const out = makeRes();
    await handler(req, out.res);
    await new Promise(r => setTimeout(r, 30));

    expect(out.status).toBe(504);
    expect(JSON.parse(out.body).error.code).toBe('timeout');
  });

  test('completes /vector/run before timeout when requestTimeoutMs set', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockResolvedValue({ ok: true }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/vector/run',
      JSON.stringify({ operation: 'query', store: 's', input: { vector: [0.1], topK: 1 } })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).type).toBe('response');
  });

  test('timeout path handles later /vector/run coordinator rejection', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 20));
            throw new Error('late boom vector');
          }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 5 }
    });

    const req = makeReq(
      'POST',
      '/vector/run',
      JSON.stringify({ operation: 'query', store: 's', input: { vector: [0.1], topK: 1 } })
    );
    const out = makeRes();
    await handler(req, out.res);
    await new Promise(r => setTimeout(r, 30));

    expect(out.status).toBe(504);
    expect(JSON.parse(out.body).error.code).toBe('timeout');
  });

  test('handles /vector/run coordinator error within timeout branch', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockRejectedValue(new Error('boom-vector-timeout-branch')),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/vector/run',
      JSON.stringify({ operation: 'query', store: 's', input: { vector: [0.1], topK: 1 } })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(500);
    expect(JSON.parse(out.body).error.message).toContain('boom-vector-timeout-branch');
  });

  test('handles /vector/run coordinator error when requestTimeoutMs disabled', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockRejectedValue(new Error('boom-vector')),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 0 }
    });

    const req = makeReq(
      'POST',
      '/vector/run',
      JSON.stringify({ operation: 'query', store: 's', input: { vector: [0.1], topK: 1 } })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(500);
    expect(JSON.parse(out.body).error.message).toContain('boom-vector');
  });

  test('times out /vector/embeddings/run when requestTimeoutMs exceeded', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 20));
            return { ok: true };
          }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 5 }
    });

    const req = makeReq('POST', '/vector/embeddings/run', JSON.stringify({ operation: 'embed' }));
    const out = makeRes();
    await handler(req, out.res);
    await new Promise(r => setTimeout(r, 30));

    expect(out.status).toBe(504);
    expect(JSON.parse(out.body).error.code).toBe('timeout');
  });

  test('completes /vector/embeddings/run before timeout when requestTimeoutMs set', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockResolvedValue({ ok: true }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 50 }
    });

    const req = makeReq(
      'POST',
      '/vector/embeddings/run',
      JSON.stringify({ operation: 'embed', embeddingPriority: [{ provider: 'p' }], input: { texts: ['hello'] } })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).type).toBe('response');
  });

  test('timeout path handles later /vector/embeddings/run coordinator rejection', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 20));
            throw new Error('late boom embeddings');
          }),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 5 }
    });

    const req = makeReq('POST', '/vector/embeddings/run', JSON.stringify({ operation: 'embed' }));
    const out = makeRes();
    await handler(req, out.res);
    await new Promise(r => setTimeout(r, 30));

    expect(out.status).toBe(504);
    expect(JSON.parse(out.body).error.code).toBe('timeout');
  });

  test('handles /vector/embeddings/run coordinator error within timeout branch', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockRejectedValue(new Error('boom-embeddings-timeout-branch')),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 50 }
    });

    const req = makeReq('POST', '/vector/embeddings/run', JSON.stringify({ operation: 'embed' }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(500);
    expect(JSON.parse(out.body).error.message).toContain('boom-embeddings-timeout-branch');
  });

  test('handles /vector/embeddings/run coordinator error when requestTimeoutMs disabled', async () => {
    const handler = createServerHandler({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn().mockRejectedValue(new Error('boom-embeddings')),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
      config: { ...config, requestTimeoutMs: 0 }
    });

    const req = makeReq('POST', '/vector/embeddings/run', JSON.stringify({ operation: 'embed' }));
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(500);
    expect(JSON.parse(out.body).error.message).toContain('boom-embeddings');
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

  test('times out /stream on idle timeout', async () => {
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
      config: { ...config, requestTimeoutMs: 0, streamIdleTimeoutMs: 5 }
    });

    const req = makeReq(
      'POST',
      '/stream',
      JSON.stringify({ messages: [], llmPriority: [{ provider: 'p', model: 'm' }], settings: {} })
    );
    const out = makeRes();
    await handler(req, out.res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('stream_idle_timeout');
  });

	  test('swallows iterator.return errors on timeout', async () => {
	    const handler = createServerHandler({
	      registry,
	      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
	          runStream: () => ({
	            [Symbol.asyncIterator]: () => ({
	              next: async () => {
	                await new Promise(() => {});
	                return { value: undefined, done: true };
	              },
	              return: () =>
	                new Promise((_, reject) => {
	                  setTimeout(() => reject(new Error('return boom')), 1);
	                })
	            })
	          }),
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
	    await new Promise(r => setTimeout(r, 10));

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

  test('swallows iterator.return promise rejections via catch callback', async () => {
    jest.resetModules();

    let createServerHandlerWithMock!: typeof createServerHandler;

    (jest as any).unstable_mockModule('@/utils/coordinator-lifecycle/index.ts', () => ({
      runWithCoordinatorLifecycle: jest.fn(),
      streamWithCoordinatorLifecycle: jest.fn().mockImplementation(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: () => ({
            catch: (callback: any) => {
              callback();
            }
          })
        })
      }))
    }));

    await jest.isolateModulesAsync(async () => {
      ({ createServerHandler: createServerHandlerWithMock } = await import('@/utils/server/internal/handler.ts'));
    });

    const handler = createServerHandlerWithMock({
      registry,
      pluginsPath: './plugins',
      closeLoggerAfterRequest: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          run: jest.fn().mockResolvedValue({ ok: true }),
          runStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        closeLogger: jest.fn()
      } as any,
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
});
