import { jest } from '@jest/globals';
import http from 'http';
import { Readable } from 'stream';

import { createVoiceServerRegistration } from '../../internal/server.js';
import { createInMemoryVoiceCallConfigStore } from '../../internal/call-config-store/index.js';

function createMockRes() {
  return { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() } as any;
}

describe('extensions/voice: server http handlers', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
  const prevTtl = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS;
  const prevMetricsEnabled = process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;
  const prevPublicBaseUrl = process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL;
  const prevTrustProxyHeaders = process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS;

  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    } else {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;
    }
    if (prevTtl === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS;
    } else {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS = prevTtl;
    }
    if (prevMetricsEnabled === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;
    } else {
      process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = prevMetricsEnabled;
    }
    if (prevPublicBaseUrl === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL;
    } else {
      process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL = prevPublicBaseUrl;
    }
    if (prevTrustProxyHeaders === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS;
    } else {
      process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS = prevTrustProxyHeaders;
    }
  });

  test('ignores non-/voice paths', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/health', method: 'GET' } as any, res)).resolves.toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  test('/voice/webhook validates method and callConfigId', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn() };

	    const reg = await createVoiceServerRegistration({
	      server: {} as any,
	      registry: {},
	      pluginsPath: './plugins',
	      upgradeRouter: {} as any,
	      store,
	      providerPlugins: providerPlugins as any
	    });

    const resA = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook', method: 'PUT' } as any, resA)).resolves.toBe(true);
    expect(String(resA.writeHead.mock.calls[0][0])).toBe('405');

    const resB = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook', method: 'GET' } as any, resB)).resolves.toBe(true);
    expect(String(resB.writeHead.mock.calls[0][0])).toBe('400');
  });

  test('/voice/webhook returns 404 for unknown callConfigId', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn() };

		    const reg = await createVoiceServerRegistration({
		      server: {} as any,
		      registry: {},
		      pluginsPath: './plugins',
		      upgradeRouter: {} as any,
		      store,
		      providerPlugins: providerPlugins as any
		    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=missing', method: 'POST' } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('404');
  });

  test('/voice/webhook rejects call configs missing voiceProvider', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_missing_provider',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: undefined
      } as any,
      { ttlSeconds: 60 }
    );

    const providerPlugins = { getCompat: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_missing_provider', method: 'GET' } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('400');
  });

  test('/voice/webhook delegates to compat and mints ws URL from forwarded proto/host', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS = '1';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async (options: any) => ({
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<x>${options.mediaWsUrl}</x>`
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'GET',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(createWebhookResponse).toHaveBeenCalled();
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://example.com/voice/media?token=');
  });

  test('/voice/webhook ignores x-forwarded-* when trust proxy headers is disabled', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    delete process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS;

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async (options: any) => ({
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<x>${options.mediaWsUrl}</x>`
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'GET',
      headers: { host: 'local.test:123', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('ws://local.test:123/voice/media?token=');
  });

  test('/voice/webhook prefers explicit public base URL over headers', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL = 'https://public.example';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async (options: any) => ({
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<x>${options.mediaWsUrl}</x>`
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'GET',
      headers: { host: 'local.test:123', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://public.example/voice/media?token=');
  });

  test('/voice/webhook returns 500 when LLM_ADAPTER_VOICE_PUBLIC_BASE_URL is not a URL', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL = 'not-a-url';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn();
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = { url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'local.test' }, socket: {} } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('500');
    expect(createWebhookResponse).not.toHaveBeenCalled();
  });

  test('/voice/webhook returns 500 when LLM_ADAPTER_VOICE_PUBLIC_BASE_URL has an invalid protocol', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL = 'ws://public.example';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn();
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = { url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'local.test' }, socket: {} } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('500');
    expect(createWebhookResponse).not.toHaveBeenCalled();
  });

  test('/voice/webhook invokes compat signature validation when provided (failure blocks)', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async () => {
      const err = new Error('Unauthorized');
      (err as any).statusCode = 401;
      (err as any).code = 'unauthorized';
      throw err;
    });
    const createWebhookResponse = jest.fn();
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('401');
    expect(createWebhookResponse).not.toHaveBeenCalled();
    expect(validateWebhookRequest).toHaveBeenCalled();
  });

	  test('/voice/webhook metrics: compat validation errors increment counter when enabled', async () => {
	    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';
	    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async () => {
      const err = new Error('Unauthorized');
      (err as any).statusCode = 401;
      (err as any).code = 'unauthorized';
      throw err;
    });
    const providerPlugins = {
      getCompat: jest.fn(async () => ({
        validateWebhookRequest,
        createWebhookResponse: jest.fn()
      }))
    };

	    const reg = await createVoiceServerRegistration({
	      server: {} as any,
	      registry: {},
	      pluginsPath: './plugins',
	      upgradeRouter: {} as any,
	      store,
	      providerPlugins: providerPlugins as any,
	      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
	    });

    const resWebhook = createMockRes();
    await expect(
      reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, resWebhook)
    ).resolves.toBe(true);
    expect(String(resWebhook.writeHead.mock.calls[0][0])).toBe('401');

    const resMetrics = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/metrics', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMetrics)).resolves.toBe(true);
    expect(String(resMetrics.writeHead.mock.calls[0][0])).toBe('200');
    const metrics = JSON.parse(String(resMetrics.end.mock.calls[0][0]));
    const samples: any[] = Array.isArray(metrics.metrics) ? metrics.metrics : [];
    const sample = samples.find(
      (m) => m?.name === 'voice.compat.error_total' && m?.labels?.voiceProvider === 'test' && m?.labels?.stage === 'webhook_validate'
    );
    expect(sample?.value).toBe(1);
  });

  test('/voice/webhook metrics: compat response errors increment counter when enabled', async () => {
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async () => {
      const err = new Error('boom');
      (err as any).statusCode = 500;
      (err as any).code = 'provider_error';
      throw err;
    });
    const providerPlugins = {
      getCompat: jest.fn(async () => ({
        createWebhookResponse
      }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const resWebhook = createMockRes();
    await expect(
      reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, resWebhook)
    ).resolves.toBe(true);
    expect(String(resWebhook.writeHead.mock.calls[0][0])).toBe('500');

    const resMetrics = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/metrics', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMetrics)).resolves.toBe(true);
    expect(String(resMetrics.writeHead.mock.calls[0][0])).toBe('200');
    const metrics = JSON.parse(String(resMetrics.end.mock.calls[0][0]));
    const samples: any[] = Array.isArray(metrics.metrics) ? metrics.metrics : [];
    const sample = samples.find(
      (m) => m?.name === 'voice.compat.error_total' && m?.labels?.voiceProvider === 'test' && m?.labels?.stage === 'webhook_response'
    );
    expect(sample?.value).toBe(1);
  });

  test('/voice/webhook invokes compat signature validation when provided (success continues)', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async () => {});
    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: '<ok/>' }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(validateWebhookRequest).toHaveBeenCalled();
    expect(createWebhookResponse).toHaveBeenCalled();
  });

  test('/voice/webhook (POST) parses x-www-form-urlencoded body into params for signature validation', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async (options: any) => {
      expect(options.method).toBe('POST');
      expect(options.params).toEqual({ CallSid: 'CA123', From: '+1' });
      expect(options.providerDefaults).toEqual({ foo: 'bar' });
    });
    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
    const providerPlugins = {
      getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })),
      getManifest: jest.fn(async () => ({ defaults: { foo: 'bar' } }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { bodyReadTimeoutMs: Number.POSITIVE_INFINITY }
    });

    const res = createMockRes();
    const req = Object.assign(Readable.from(['CallSid=CA123&From=%2B1']), {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' },
      socket: {}
    }) as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(validateWebhookRequest).toHaveBeenCalledTimes(1);
    expect(createWebhookResponse).toHaveBeenCalledTimes(1);
  });

  test('/voice/webhook (POST) reads body but does not parse params for non-form content-type', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async (options: any) => {
      expect(options.method).toBe('POST');
      expect(options.params).toEqual({});
    });
    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = Object.assign(Readable.from(['CallSid=CA123&From=%2B1']), {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      socket: {}
    }) as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(validateWebhookRequest).toHaveBeenCalledTimes(1);
    expect(createWebhookResponse).toHaveBeenCalledTimes(1);
  });

  test('/voice/webhook (POST) tolerates missing req.headers when reading body for validation', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async (options: any) => {
      expect(options.method).toBe('POST');
      expect(options.params).toEqual({});
    });
    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = Object.assign(Readable.from(['x=1']), {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'POST',
      socket: {}
    }) as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(validateWebhookRequest).toHaveBeenCalledTimes(1);
    expect(createWebhookResponse).toHaveBeenCalledTimes(1);
  });

  test('/voice/webhook uses /voice/webhook default when req.url is undefined during signature validation', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async (options: any) => {
      expect(String(options.url)).toBe('http://localhost/voice/webhook');
    });
    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    let reads = 0;
    const req = {
      get url() {
        reads += 1;
        return reads === 1 ? '/voice/webhook?callConfigId=cfg_1' : undefined;
      },
      method: 'GET',
      headers: { host: 'localhost' },
      socket: {}
    } as any;

    const res = createMockRes();
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(validateWebhookRequest).toHaveBeenCalledTimes(1);
  });

  test('/voice/webhook (POST) rejects with 413 when maxRequestBytes is exceeded while reading body', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async () => {});
    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { maxRequestBytes: 1 }
    });

    const res = createMockRes();
    const req = Object.assign(Readable.from(['aa']), {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' },
      socket: {}
    }) as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('413');
    expect(validateWebhookRequest).not.toHaveBeenCalled();
    expect(createWebhookResponse).not.toHaveBeenCalled();
  });

  test('/voice/webhook (POST) rejects with 408 when reading request body times out', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async () => {});
    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { bodyReadTimeoutMs: 5 }
    });

    let started = false;
    const readable = new Readable({
      read() {
        if (started) return;
        started = true;
        setTimeout(() => {
          this.push('CallSid=CA123');
          this.push(null);
        }, 20);
      }
    });

    const req = Object.assign(readable, {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' },
      socket: {}
    }) as any;

    const res = createMockRes();
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('408');
    expect(validateWebhookRequest).not.toHaveBeenCalled();
    expect(createWebhookResponse).not.toHaveBeenCalled();

    await new Promise(resolve => setTimeout(resolve, 25));
  });

  test('/voice/webhook supports a valid explicit ws token TTL override', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS = '2.9';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async () => ({
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: '<ok/>'
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
  });

  test('/voice/webhook tolerates partial compat webhook responses (defaults)', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async () => ({
      // status omitted
      headers: 'bad',
      body: undefined
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(res.writeHead.mock.calls[0][1]).toEqual({});
    expect(String(res.end.mock.calls[0][0] ?? '')).toBe('');
  });

  test('/voice/webhook base-url inference tolerates missing req.headers', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async (options: any) => ({
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<x>${options.mediaWsUrl}</x>`
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = { url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', socket: {} } as any;
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(createWebhookResponse).toHaveBeenCalled();
    expect(String(createWebhookResponse.mock.calls[0][0].mediaWsUrl)).toContain('ws://localhost/voice/media?token=');
  });

  test('/voice/webhook maps errors when token config is missing/invalid', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const providerPlugins = { getCompat: jest.fn() };
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    const resA = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, resA)).resolves.toBe(true);
    expect(String(resA.writeHead.mock.calls[0][0])).toBe('500');

    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS = '0';
    const resB = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, resB)).resolves.toBe(true);
    expect(String(resB.writeHead.mock.calls[0][0])).toBe('500');
  });

  test('/voice returns ok and other /voice/* returns 404', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn() };
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const resA = createMockRes();
    await expect(reg.handleHttp({ url: '/voice', method: 'GET' } as any, resA)).resolves.toBe(true);
    expect(String(resA.writeHead.mock.calls[0][0])).toBe('200');

    const resB = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/unknown', method: 'GET' } as any, resB)).resolves.toBe(true);
    expect(String(resB.writeHead.mock.calls[0][0])).toBe('404');
  });

  test('host/proto inference falls back to localhost and socket.encrypted', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const createWebhookResponse = jest.fn(async (options: any) => ({
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<x>${options.mediaWsUrl}</x>`
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    const req = {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'GET',
      headers: {},
      socket: { encrypted: true }
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://localhost/voice/media?token=');
  });

  test('/voice/calls defaults missing method to GET and returns 405', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn(), getManifest: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls' } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('405');
  });

  test('/voice/calls can compute rate limit key as unknown when no auth and no client ip', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn(), getManifest: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { auth: { enabled: false }, rateLimit: { enabled: true, requestsPerMinute: 1, burst: 1 } }
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls', method: 'POST', headers: {}, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('501');
  });

  test('CORS preflight OPTIONS is handled before route logic', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn(), getManifest: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: {
        cors: { enabled: true, allowedOrigins: '*', allowedHeaders: ['content-type'], allowCredentials: false }
      }
    });

    const res = createMockRes();
    const req = { url: '/voice/calls', method: 'OPTIONS', headers: { origin: 'https://example.com' }, socket: {} } as any;
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('204');
  });

  test('close terminates without throwing', async () => {
    const server = http.createServer();
    const reg = await createVoiceServerRegistration({
      server,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: { getCompat: jest.fn() } as any
    });
    await expect(reg.close()).resolves.toBeUndefined();
  });
});
