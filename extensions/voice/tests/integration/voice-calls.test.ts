import { jest } from '@jest/globals';
import http from 'http';
import * as path from 'path';

import voiceExtension from '../../index.ts';
import { createInMemoryVoiceCallConfigStore } from '../../internal/call-config-store/index.js';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';
import { closeServerAndSockets, trackServerSockets, unrefServer } from '../helpers/http-server.ts';

async function startHarness(options: { store: any; providerPlugins: any; httpConfig: any }) {
  let handleHttp: any = async () => false;
  const server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleHttp(req, res);
      if (handled) return;
      res.statusCode = 404;
      res.end('not found');
    })();
  });

  const sockets = trackServerSockets(server);

  const upgradeRouter = attachUpgradeRouter(server);

  const reg = await (voiceExtension as any).registerServer({
    server,
    registry: {},
    pluginsPath: path.resolve(process.cwd(), 'plugins'),
    upgradeRouter,
    store: options.store,
    providerPlugins: options.providerPlugins,
    httpConfig: options.httpConfig
  });

  handleHttp = reg.handleHttp;
  const unregister = upgradeRouter.register(reg.handleUpgrade);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  unrefServer(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    unregister();
    upgradeRouter.close();
    await reg.close?.();
    await closeServerAndSockets(server, sockets);
  };

  return { baseUrl, close };
}

describe('extensions/voice: /voice/calls', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;

  beforeEach(() => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
  });

  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    } else {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;
    }
  });

  test('rejects non-POST with 405', async () => {
    const harness = await startHarness({
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), { method: 'GET' });
      expect(res.status).toBe(405);
    } finally {
      await harness.close();
    }
  });

  test('returns 501 when auth is disabled (rate limit does not block)', async () => {
    const harness = await startHarness({
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() },
      httpConfig: {
        auth: { enabled: false },
        rateLimit: { enabled: true, requestsPerMinute: 0, burst: 1 }
      }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' })
      });
      expect(res.status).toBe(501);
    } finally {
      await harness.close();
    }
  });

  test('returns 401 when auth is enabled but credentials are missing', async () => {
    const harness = await startHarness({
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' })
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body?.error?.code).toBe('unauthorized');
    } finally {
      await harness.close();
    }
  });

  test('validates required fields and ttlSeconds', async () => {
    const harness = await startHarness({
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })) },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const resMissing = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({})
      });
      expect(resMissing.status).toBe(400);

      const resTtl = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test', ttlSeconds: 0 })
      });
      expect(resTtl.status).toBe(400);
    } finally {
      await harness.close();
    }
  });

  test('idempotency: returns cached response and does not call compat', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putIdempotency('idem_1', { callConfigId: 'cfg_cached', providerCallId: 'p_cached', status: 'queued' }, { ttlSeconds: 60 });

    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'p1' }));
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer k1',
          'Idempotency-Key': 'idem_1'
        },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ callConfigId: 'cfg_cached', providerCallId: 'p_cached', status: 'queued' });
      expect(createOutboundCall).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('idempotency: key may be supplied in JSON body', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'p1' }));
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const makeReq = () =>
        fetch(new URL('/voice/calls', harness.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
          body: JSON.stringify({
            to: 'to',
            from: 'from',
            realtimeSpec: { ok: true },
            voiceProvider: 'test',
            idempotencyKey: 'idem_body'
          })
        });

      const res1 = await makeReq();
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      const res2 = await makeReq();
      expect(res2.status).toBe(200);
      const body2 = await res2.json();

      expect(body2).toEqual(body1);
      expect(createOutboundCall).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  test('idempotency: long keys are hashed for storage', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const consumeNonceOnce = jest.spyOn(store as any, 'consumeNonceOnce');
    const putIdempotency = jest.spyOn(store as any, 'putIdempotency');

    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'p1' }));
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const longKey = 'k'.repeat(2000);

      const makeReq = () =>
        fetch(new URL('/voice/calls', harness.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1', 'Idempotency-Key': longKey },
          body: JSON.stringify({
            to: 'to',
            from: 'from',
            realtimeSpec: { ok: true },
            voiceProvider: 'test'
          })
        });

      const res1 = await makeReq();
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      const res2 = await makeReq();
      expect(res2.status).toBe(200);
      const body2 = await res2.json();

      expect(body2).toEqual(body1);
      expect(createOutboundCall).toHaveBeenCalledTimes(1);

      const normalizedKey = putIdempotency.mock.calls[0]?.[0];
      expect(String(normalizedKey)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(String(consumeNonceOnce.mock.calls[0]?.[0])).toBe(`idem:${normalizedKey}`);
    } finally {
      await harness.close();
    }
  });

  test('idempotency: concurrent requests only initiate once', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => {
      await new Promise(res => setTimeout(res, 100));
      return { providerCallId: 'p1' };
    });

    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const makeReq = () =>
        fetch(new URL('/voice/calls', harness.baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer k1',
            'Idempotency-Key': 'idem_concurrent'
          },
          body: JSON.stringify({
            to: 'to',
            from: 'from',
            systemPrompt: 'hello',
            realtimeSpec: { ok: true },
            voiceProvider: 'test',
            ttlSeconds: 60
          })
        });

      const [r1, r2] = await Promise.all([makeReq(), makeReq()]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
      expect(b2).toEqual(b1);
      expect(createOutboundCall).toHaveBeenCalledTimes(1);

      const cfg = await store.getConfig(String(b1.callConfigId));
      expect(cfg?.systemPrompt).toBe('hello');
      expect(cfg?.voiceProvider).toBe('test');
      expect(cfg?.expiresAtMs).toBeGreaterThan(cfg?.createdAtMs ?? 0);
    } finally {
      await harness.close();
    }
  });

  test('idempotency: in-progress lock returns 409 after wait timeout', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => {
      await new Promise(res => setTimeout(res, 150));
      return { providerCallId: 'p1' };
    });

    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: {
        auth: { enabled: true, apiKeys: ['k1'] },
        idempotencyWaitMs: 10,
        idempotencyLockTtlSeconds: 60
      }
    });

    try {
      const makeReq = () =>
        fetch(new URL('/voice/calls', harness.baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer k1',
            'Idempotency-Key': 'idem_timeout'
          },
          body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: { ok: true }, voiceProvider: 'test' })
        });

      const res1Promise = makeReq();
      await new Promise(res => setTimeout(res, 25));
      const res2 = await makeReq();
      expect(res2.status).toBe(409);
      const err = await res2.json();
      expect(err?.error?.code).toBe('idempotency_in_progress');

      const res1 = await res1Promise;
      expect(res1.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  test('returns 400 for unknown voiceProvider', async () => {
    const harness = await startHarness({
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: {
        getManifest: jest.fn(async () => {
          throw new Error('unknown');
        }),
        getCompat: jest.fn()
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'missing' })
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body?.error?.code).toBe('validation_error');
    } finally {
      await harness.close();
    }
  });

  test('returns 502 when compat omits providerCallId', async () => {
    const harness = await startHarness({
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall: async () => ({}) }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' })
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body?.error?.code).toBe('provider_error');
    } finally {
      await harness.close();
    }
  });

  test('returns 500 when stored call config cannot be loaded', async () => {
    const store = {
      putConfig: jest.fn(async () => {}),
      getConfig: jest.fn(async () => null),
      deleteConfig: jest.fn(async () => {}),
      putIdempotency: jest.fn(async () => {}),
      getIdempotency: jest.fn(async () => null),
      consumeNonceOnce: jest.fn(async () => true)
    };

    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall: jest.fn() }))
      },
      httpConfig: {
        auth: { enabled: true, apiKeys: ['k1'] },
        maxRequestBytes: 1024,
        bodyReadTimeoutMs: 50,
        securityHeadersEnabled: false
      }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' })
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body?.error?.code).toBe('internal');
    } finally {
      await harness.close();
    }
  });

  test('rate limit: second request returns 429', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'p1' }));

    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: {
        auth: { enabled: true, apiKeys: ['k1'] },
        rateLimit: { enabled: true, requestsPerMinute: 0, burst: 1 }
      }
    });

    try {
      const makeReq = () =>
        fetch(new URL('/voice/calls', harness.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
          body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' })
        });

      const res1 = await makeReq();
      expect(res1.status).toBe(200);

      const res2 = await makeReq();
      expect(res2.status).toBe(429);
      const body = await res2.json();
      expect(body?.error?.code).toBe('rate_limited');
    } finally {
      await harness.close();
    }
  });

  test('metrics: outbound call attempts and compat errors are tracked when enabled', async () => {
    const prevMetricsEnabled = process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';

    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => {
      const err = new Error('boom');
      (err as any).statusCode = 500;
      (err as any).code = 'provider_error';
      throw err;
    });

    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({ to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' })
      });
      expect(res.status).toBe(500);

      const metricsRes = await fetch(new URL('/voice/metrics', harness.baseUrl), {
        headers: { Authorization: 'Bearer k1' }
      });
      expect(metricsRes.status).toBe(200);
      const metricsBody = await metricsRes.json();

      const metrics: any[] = Array.isArray(metricsBody.metrics) ? metricsBody.metrics : [];
      const outboundAttempt = metrics.find(
        (m) => m?.name === 'voice.calls.outbound_attempt_total' && m?.labels?.voiceProvider === 'test'
      );
      expect(outboundAttempt?.value).toBe(1);

      const compatError = metrics.find(
        (m) =>
          m?.name === 'voice.compat.error_total' &&
          m?.labels?.voiceProvider === 'test' &&
          m?.labels?.stage === 'outbound_call'
      );
      expect(compatError?.value).toBe(1);
    } finally {
      await harness.close();
      if (prevMetricsEnabled === undefined) delete process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;
      else process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = prevMetricsEnabled;
    }
  });

  test('stores assistantFirstTurn config when provided', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'p1' }));
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({
          to: 'to',
          from: 'from',
          realtimeSpec: { ok: true },
          voiceProvider: 'test',
          timeouts: { callTimeoutMs: 12345, silenceTimeoutMs: 2345 },
          recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'dual' },
          assistantFirstTurn: {
            enabled: true,
            prompt: 'Greet the caller briefly and professionally.',
            role: 'user',
            delayMs: 123,
            missingPromptBehavior: 'reject'
          }
        })
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      const stored = await store.getConfig(body.callConfigId);
      expect(stored?.assistantFirstTurn).toEqual({
        enabled: true,
        prompt: 'Greet the caller briefly and professionally.',
        role: 'user',
        delayMs: 123,
        missingPromptBehavior: 'reject'
      });
      expect(stored?.timeouts).toEqual({ callTimeoutMs: 12345, silenceTimeoutMs: 2345 });
      expect(stored?.recording).toEqual({ enabled: true, mode: 'provider', format: 'mp3', channels: 'dual' });
      expect(stored?.providerCallId).toBe('p1');
    } finally {
      await harness.close();
    }
  });

  test('rejects assistantFirstTurn enabled without prompt by default', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'p1' }));
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test' })),
        getCompat: jest.fn(async () => ({ createOutboundCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
        body: JSON.stringify({
          to: 'to',
          from: 'from',
          realtimeSpec: { ok: true },
          voiceProvider: 'test',
          assistantFirstTurn: { enabled: true }
        })
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body?.error?.code).toBe('validation_error');
    } finally {
      await harness.close();
    }
  });
});
