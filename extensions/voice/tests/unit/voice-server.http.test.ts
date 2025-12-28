import { jest } from '@jest/globals';
import http from 'http';

import { createVoiceServerRegistration } from '../../internal/server.js';
import { createInMemoryVoiceCallConfigStore } from '../../internal/call-config-store/index.js';

function createMockRes() {
  return { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() } as any;
}

describe('extensions/voice: server http handlers', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
  const prevTtl = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS;

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
      providerPlugins: providerPlugins as any
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
