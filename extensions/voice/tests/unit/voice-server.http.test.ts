import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';

import { createVoiceServerRegistration } from '../../internal/server.js';
import { createInMemoryVoiceCallConfigStore } from '../../internal/call-config-store/index.js';

function createMockRes() {
  return { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() } as any;
}

function createJsonReq(options: { url: string; method: string; body?: any; headers?: Record<string, any> }) {
  const bodyText = JSON.stringify(options.body ?? {});
  const req = Readable.from([bodyText]) as any;
  req.url = options.url;
  req.method = options.method;
  req.headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  req.socket = {};
  return req;
}

function createFormReq(options: { url: string; method: string; form?: Record<string, string>; headers?: Record<string, any> }) {
  const bodyText = new URLSearchParams(options.form ?? {}).toString();
  const req = Readable.from([bodyText]) as any;
  req.url = options.url;
  req.method = options.method;
  req.headers = { 'content-type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) };
  req.socket = {};
  return req;
}

function createSseRes() {
  const res = new EventEmitter() as any;
  res.writeHead = jest.fn();
  res.setHeader = jest.fn();
  res.write = jest.fn();
  res.end = jest.fn();
  return res;
}

class MockStreamRes extends Writable {
  public writeHead = jest.fn();
  public setHeader = jest.fn();

  public chunks: Buffer[] = [];

  _write(chunk: any, encoding: any, callback: any) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

describe('extensions/voice: server http handlers', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
  const prevTtl = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS;
  const prevMetricsEnabled = process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;
  const prevPublicBaseUrl = process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL;
  const prevTrustProxyHeaders = process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS;
  const prevWebhookValidationRequired = process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED;

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
    if (prevWebhookValidationRequired === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED;
    } else {
      process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED = prevWebhookValidationRequired;
    }
  });

  test('ignores non-/voice paths', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse: jest.fn() })) };

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

  test('/voice/webhook logs provider plugin loader warnings when logging is available', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-server-plugins-'));
    try {
      await fs.mkdir(path.join(tmp, 'voice-providers'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'voice-providers', 'bad.json'), JSON.stringify('not-an-object'), 'utf-8');
      await fs.writeFile(path.join(tmp, 'voice-providers', 'test.json'), JSON.stringify({ id: 'test', kind: 'test' }, null, 2), 'utf-8');

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

      const logger: any = {
        withCorrelation: () => logger,
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn()
      };

      const reg = await createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: tmp,
        upgradeRouter: {} as any,
        store,
        logging: { getLogger: () => logger }
      });

      const res = createMockRes();
      await expect(
        reg.handleHttp(
          { url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost', 'x-test-signature': 'ok' }, socket: {} } as any,
          res
        )
      ).resolves.toBe(true);
      expect(String(res.writeHead.mock.calls[0][0])).toBe('200');

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(
        logger.warning.mock.calls.some(
          ([msg, data]: any[]) =>
            msg === 'voice.provider_plugins.manifest_skipped' && data?.manifestPath === 'voice-providers/bad.json'
        )
      ).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('/voice/webhook validates method and callConfigId', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse: jest.fn() })) };

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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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

  test('/voice/webhook ignores invalid x-forwarded-proto (falls back to socket encryption)', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { 'x-forwarded-proto': 'ftp', 'x-forwarded-host': 'example.com' },
      socket: { encrypted: true }
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://example.com/voice/media?token=');
  });

  test('/voice/webhook ignores invalid x-forwarded-host (falls back to Host header)', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { host: 'local.test:123', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example/path' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://local.test:123/voice/media?token=');
  });

  test('/voice/webhook ignores x-forwarded-host with invalid port (falls back safely)', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { host: 'local.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com:99999' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://local.test/voice/media?token=');
  });

  test('/voice/webhook ignores non-string x-forwarded-proto values', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { 'x-forwarded-proto': ['https'] as any, 'x-forwarded-host': 'example.com' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('ws://example.com/voice/media?token=');
  });

  test('/voice/webhook ignores non-string x-forwarded-host values', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { host: 'local.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': ['example.com'] as any },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://local.test/voice/media?token=');
  });

  test('/voice/webhook ignores x-forwarded-host with CRLF/whitespace injection', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { host: 'local.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com\r\nX-Evil: 1' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://local.test/voice/media?token=');
  });

  test('/voice/webhook ignores x-forwarded-host containing URL components', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { host: 'local.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com?x=1' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('wss://local.test/voice/media?token=');
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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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

  test('/voice/webhook falls back to localhost when Host is blank/invalid', async () => {
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

    const createWebhookResponse = jest.fn(async (options: any) => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: `<x>${options.mediaWsUrl}</x>` }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
      headers: { host: '   ' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    const mediaWsUrl = createWebhookResponse.mock.calls[0][0].mediaWsUrl;
    expect(String(mediaWsUrl)).toContain('ws://localhost/voice/media?token=');
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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
        validateWebhookRequest: jest.fn(async () => {}),
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

  test('/voice/webhook (GET) passes the full URL (including query string) to signature validation', async () => {
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
      expect(options.method).toBe('GET');
      expect(String(options.url)).toContain('http://localhost/voice/webhook?callConfigId=cfg_1');
      expect(String(options.url)).toContain('CallSid=CA123');
      expect(String(options.url)).toContain('From=%2B1');
      expect(options.params).toEqual({});
    });
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
    await expect(
      reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1&CallSid=CA123&From=%2B1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, res)
    ).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(validateWebhookRequest).toHaveBeenCalledTimes(1);
    expect(createWebhookResponse).toHaveBeenCalledTimes(1);
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
        expect(options.params).toEqual({ callId: 'CA123', from: '+1' });
        expect(options.providerDefaults).toEqual({ foo: 'bar' });
      });
      const createWebhookResponse = jest.fn(async (options: any) => {
        expect(options.params).toEqual({ callId: 'CA123', from: '+1' });
        return { status: 200, headers: {}, body: 'ok' };
      });
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
    const req = Object.assign(Readable.from(['callId=CA123&from=%2B1']), {
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

    test('/voice/webhook rejects missing signature validation by default', async () => {
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

      const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
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
      expect(String(res.writeHead.mock.calls[0][0])).toBe('501');
      expect(createWebhookResponse).not.toHaveBeenCalled();
    });

    test('/voice/webhook (POST) allows missing signature validation when validation-required is disabled', async () => {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED = '0';

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

      const createWebhookResponse = jest.fn(async (options: any) => {
        expect(options.params).toEqual({ callId: 'CA123', from: '+1' });
        return { status: 200, headers: {}, body: 'ok' };
      });
      const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

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
      const req = Object.assign(Readable.from(['callId=CA123&from=%2B1']), {
        url: '/voice/webhook?callConfigId=cfg_1',
        method: 'POST',
        headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' },
        socket: {}
      }) as any;

      await expect(reg.handleHttp(req, res)).resolves.toBe(true);
      expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
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
      const createWebhookResponse = jest.fn(async (options: any) => {
        expect(options.params).toEqual({});
        return { status: 200, headers: {}, body: 'ok' };
      });
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
    const req = Object.assign(Readable.from(['callId=CA123&from=%2B1']), {
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
          this.push('callId=CA123');
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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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

    test('/voice/webhook rejects ws token TTL override above max', async () => {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS = '86401';

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

      const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse: jest.fn() })) };

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
      expect(String(res.writeHead.mock.calls[0][0])).toBe('500');

      const payload = JSON.parse(String(res.end.mock.calls[0][0]));
      expect(String(payload?.error?.message)).toContain('Invalid LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS');
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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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

      const providerPlugins = {
        getCompat: jest.fn(async () => ({
          validateWebhookRequest: jest.fn(async () => {}),
          createWebhookResponse: jest.fn(async () => ({ status: 200, headers: {}, body: '' }))
        }))
      };
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
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}), createWebhookResponse })) };

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

  test('voice events hub parses numeric defaults when provided', async () => {
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
        extensions: {
          voice: {
            events: { maxActiveCalls: 10, maxBufferedEventsPerCall: 0, callTtlMs: 0, includeDeltas: true }
          }
        }
      }
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice', method: 'GET' } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    await reg.close();
  });

  test('POST /voice/calls validates and normalizes assistantFirstTurn/timeouts/recording', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

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
        auth: { enabled: true, apiKeys: ['k1'] },
        extensions: {
          voice: {
            timeouts: { callTimeoutMs: 10, silenceTimeoutMs: 20 },
            assistantFirstTurn: { enabled: false },
            recording: { enabled: false }
          }
        }
      }
    });

    const resBadTimeout = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: { timeouts: { callTimeoutMs: 0 } }
        }),
        resBadTimeout
      )
    ).resolves.toBe(true);
    expect(String(resBadTimeout.writeHead.mock.calls[0][0])).toBe('400');

    const resBadDelay = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: { assistantFirstTurn: { enabled: true, prompt: 'hi', delayMs: -1 } }
        }),
        resBadDelay
      )
    ).resolves.toBe(true);
    expect(String(resBadDelay.writeHead.mock.calls[0][0])).toBe('400');

    const resSkipPrompt = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: {
            timeouts: { callTimeoutMs: '15', silenceTimeoutMs: '' },
            recording: { enabled: true, mode: 'provider', format: 'wav', channels: 'dual' },
            assistantFirstTurn: { enabled: true, prompt: '   ', role: 'system', missingPromptBehavior: 'skip' }
          }
        }),
        resSkipPrompt
      )
    ).resolves.toBe(true);
    expect(String(resSkipPrompt.writeHead.mock.calls[0][0])).toBe('400');
  });

  test('POST /voice/calls uses defaults when raw assistantFirstTurn/recording omit enabled', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

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
        auth: { enabled: true, apiKeys: ['k1'] },
        extensions: {
          voice: {
            assistantFirstTurn: { enabled: true, prompt: 'Hello there', role: 'user', delayMs: 0, missingPromptBehavior: 'reject' },
            recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' },
            timeouts: {}
          }
        }
      }
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: { assistantFirstTurn: {}, recording: {}, timeouts: {} }
        }),
        res
      )
    ).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('400');
  });

  test('POST /voice/calls treats assistantFirstTurn/recording enabled as false when omitted', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn(), getManifest: jest.fn() };

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
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: { assistantFirstTurn: { prompt: 'hi' }, recording: { mode: 'provider' }, timeouts: {} }
        }),
        res
      )
    ).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('400');
  });

  test('POST /voice/calls accepts silenceAssistantAudio*FallbackMs and persists them to the call config', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();

    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'pc_1' }));
    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: {
            to: 'to',
            from: 'from',
            realtimeSpec: {},
            voiceProvider: 'test',
            timeouts: { silenceAssistantAudioStartFallbackMs: 111, silenceAssistantAudioEndFallbackMs: 222 }
          }
        }),
        res
      )
    ).resolves.toBe(true);

    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(createOutboundCall).toHaveBeenCalled();

    const response = JSON.parse(String(res.end.mock.calls[0][0]));
    expect(response).toMatchObject({ providerCallId: 'pc_1', status: 'queued' });

    const callConfig = await store.getConfig(String(response.callConfigId));
    expect(callConfig?.timeouts).toMatchObject({ silenceAssistantAudioStartFallbackMs: 111, silenceAssistantAudioEndFallbackMs: 222 });
  });

  test('POST /voice/calls rejects negative timeouts.firstTurnGraceMs', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();

    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall: jest.fn(async () => ({ providerCallId: 'pc_1' })) }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: {
            to: 'to',
            from: 'from',
            realtimeSpec: {},
            voiceProvider: 'test',
            timeouts: { firstTurnGraceMs: -1 }
          }
        }),
        res
      )
    ).resolves.toBe(true);

    expect(String(res.writeHead.mock.calls[0][0])).toBe('400');
  });

  test('POST /voice/calls accepts timeouts.firstTurnGraceMs (including 0) and persists it to the call config', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();

    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'pc_1' }));
    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const resZero = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: {
            to: 'to',
            from: 'from',
            realtimeSpec: {},
            voiceProvider: 'test',
            timeouts: { firstTurnGraceMs: 0 }
          }
        }),
        resZero
      )
    ).resolves.toBe(true);

    expect(String(resZero.writeHead.mock.calls[0][0])).toBe('200');
    expect(createOutboundCall).toHaveBeenCalled();
    const responseZero = JSON.parse(String(resZero.end.mock.calls[0][0]));
    const callConfigZero = await store.getConfig(String(responseZero.callConfigId));
    expect(callConfigZero?.timeouts).toMatchObject({ firstTurnGraceMs: 0 });

    const resPositive = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: {
            to: 'to',
            from: 'from',
            realtimeSpec: {},
            voiceProvider: 'test',
            timeouts: { firstTurnGraceMs: '250' }
          }
        }),
        resPositive
      )
    ).resolves.toBe(true);

    expect(String(resPositive.writeHead.mock.calls[0][0])).toBe('200');
    const responsePositive = JSON.parse(String(resPositive.end.mock.calls[0][0]));
    const callConfigPositive = await store.getConfig(String(responsePositive.callConfigId));
    expect(callConfigPositive?.timeouts).toMatchObject({ firstTurnGraceMs: 250 });
  });

  test('POST /voice/calls uses backoff/jitter when idempotency lock is held', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

      const store = createInMemoryVoiceCallConfigStore();
      await store.consumeNonceOnce('idem:idem_locked', { ttlSeconds: 60 });

      const providerPlugins: any = {
        getManifest: jest.fn(async () => ({ defaults: {} })),
        getCompat: jest.fn(async () => ({ createOutboundCall: jest.fn() }))
      };

      const reg = await createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store,
        providerPlugins,
        httpConfig: {
          auth: { enabled: true, apiKeys: ['k1'] },
          idempotencyWaitMs: 200,
          idempotencyLockTtlSeconds: 60
        }
      });

      const res = createMockRes();
      const promise = reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost', 'idempotency-key': 'idem_locked' },
          body: { to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' }
        }),
        res
      );

      await jest.runAllTimersAsync();
      await expect(promise).resolves.toBe(true);

      expect(String(res.writeHead.mock.calls[0][0])).toBe('409');
      const payload = JSON.parse(String(res.end.mock.calls[0][0]));
      expect(payload?.error?.code).toBe('idempotency_in_progress');

      const delays = setTimeoutSpy.mock.calls
        .map((call: any[]) => call?.[1])
        .filter((ms: any) => typeof ms === 'number' && ms > 0 && ms <= 200);
      expect(delays.length).toBeGreaterThanOrEqual(2);

      // Old implementation slept 25ms repeatedly; backoff should grow at least once.
      expect(delays[0]).toBe(25);
      expect(delays[1]).toBe(50);
      expect(Math.max(...delays)).toBeGreaterThan(25);
    } finally {
      randomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('POST /voice/calls idempotency wait breaks when budget is exhausted between polls', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

      const store = createInMemoryVoiceCallConfigStore();
      const baseGetIdempotency = store.getIdempotency.bind(store);
      (store as any).getIdempotency = jest.fn(async (key: string) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return baseGetIdempotency(key);
      });
      await store.consumeNonceOnce('idem:idem_slow', { ttlSeconds: 60 });

      const providerPlugins: any = {
        getManifest: jest.fn(async () => ({ defaults: {} })),
        getCompat: jest.fn(async () => ({ createOutboundCall: jest.fn() }))
      };

      const reg = await createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store,
        providerPlugins,
        httpConfig: {
          auth: { enabled: true, apiKeys: ['k1'] },
          idempotencyWaitMs: 25,
          idempotencyLockTtlSeconds: 60
        }
      });

      const res = createMockRes();
      const promise = reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost', 'idempotency-key': 'idem_slow' },
          body: { to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' }
        }),
        res
      );

      await jest.runAllTimersAsync();
      await expect(promise).resolves.toBe(true);

      expect(String(res.writeHead.mock.calls[0][0])).toBe('409');
      const payload = JSON.parse(String(res.end.mock.calls[0][0]));
      expect(payload?.error?.code).toBe('idempotency_in_progress');

      const delays = setTimeoutSpy.mock.calls.map((call: any[]) => call?.[1]);
      expect(delays).toContain(30);
      expect(delays).not.toContain(25);
    } finally {
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('POST /voice/calls returns 501 when adapter-side recording is requested', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = { getCompat: jest.fn(), getManifest: jest.fn() };

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
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: {
            to: 'to',
            from: 'from',
            realtimeSpec: {},
            voiceProvider: 'test',
            recording: { enabled: true, mode: 'adapter' }
          }
        }),
        res
      )
    ).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('501');
  });

  test('/voice/webhook/recording validates method/callConfigId/content-type and recording state', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED = '1';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_no_provider',
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
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_disabled',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: false, mode: 'provider', format: 'mp3', channels: 'mono' }
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_enabled',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' },
        metadata: { requestId: 'req_1' }
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_enabled_no_reqid',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        providerCallId: 'pc_1',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_enabled_no_provider_call_id',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
      } as any,
      { ttlSeconds: 60 }
    );

    const providerPlugins = { getCompat: jest.fn(async () => ({})) };
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const resMethod = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled', headers: {}, socket: {} } as any, resMethod)).resolves.toBe(true);
    expect(String(resMethod.writeHead.mock.calls[0][0])).toBe('405');

    const resMissingCall = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook/recording', method: 'POST' } as any, resMissingCall)).resolves.toBe(true);
    expect(String(resMissingCall.writeHead.mock.calls[0][0])).toBe('400');

    const resUnknownCall = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook/recording?callConfigId=missing', method: 'POST' } as any, resUnknownCall)).resolves.toBe(true);
    expect(String(resUnknownCall.writeHead.mock.calls[0][0])).toBe('404');

    const resMissingProvider = createMockRes();
    await expect(reg.handleHttp(createFormReq({ url: '/voice/webhook/recording?callConfigId=cfg_no_provider', method: 'POST' }) as any, resMissingProvider)).resolves.toBe(true);
    expect(String(resMissingProvider.writeHead.mock.calls[0][0])).toBe('400');

    const resMissingContentType = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled', method: 'POST', headers: {}, socket: {} } as any, resMissingContentType)).resolves.toBe(true);
    expect(String(resMissingContentType.writeHead.mock.calls[0][0])).toBe('400');

    const resBadContentType = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        }) as any,
        resBadContentType
      )
    ).resolves.toBe(true);
    expect(String(resBadContentType.writeHead.mock.calls[0][0])).toBe('400');

    const resMissingValidator = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1', providerCallId: 'c1' }
        }) as any,
        resMissingValidator
      )
    ).resolves.toBe(true);
    expect(String(resMissingValidator.writeHead.mock.calls[0][0])).toBe('501');

    (providerPlugins.getCompat as any).mockResolvedValueOnce({
      validateWebhookRequest: jest.fn(async () => {
        const err: any = new Error('bad');
        err.statusCode = 400;
        throw err;
      })
    });
    const resValidation400 = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled_no_reqid',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
        }) as any,
        resValidation400
      )
    ).resolves.toBe(true);
    expect(String(resValidation400.writeHead.mock.calls[0][0])).toBe('400');

    (providerPlugins.getCompat as any).mockResolvedValueOnce({
      validateWebhookRequest: jest.fn(async () => {
        throw new Error('boom');
      })
    });
    const resValidation500 = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled_no_reqid',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
        }) as any,
        resValidation500
      )
    ).resolves.toBe(true);
    expect(String(resValidation500.writeHead.mock.calls[0][0])).toBe('500');

    (providerPlugins.getCompat as any).mockResolvedValue({
      validateWebhookRequest: jest.fn(async () => {}),
      createWebhookResponse: jest.fn(),
      parseRecordingWebhook: jest.fn(async (options: any) => {
        const params = options?.params ?? {};
        return {
          recordingId: String(params.recordingId ?? ''),
          recordingUrl: String(params.recordingUrl ?? ''),
          recordingStatus: String(params.recordingStatus ?? ''),
          providerCallId: String(params.providerCallId ?? '')
        };
      })
    });

    const resRecordingDisabled = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_disabled',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
        }) as any,
        resRecordingDisabled
      )
    ).resolves.toBe(true);
    expect(String(resRecordingDisabled.writeHead.mock.calls[0][0])).toBe('409');

    const resMissingFields = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
          method: 'POST',
          form: { recordingId: 'r1' }
        }) as any,
        resMissingFields
      )
    ).resolves.toBe(true);
    expect(String(resMissingFields.writeHead.mock.calls[0][0])).toBe('400');

    const resMissingRecordingId = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled_no_reqid',
          method: 'POST',
          form: { recordingUrl: 'https://example.com/r1' }
        }) as any,
        resMissingRecordingId
      )
    ).resolves.toBe(true);
    expect(String(resMissingRecordingId.writeHead.mock.calls[0][0])).toBe('400');

    const resOk = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1', recordingStatus: 'completed', providerCallId: 'c1' }
        }) as any,
        resOk
      )
    ).resolves.toBe(true);
    expect(String(resOk.writeHead.mock.calls[0][0])).toBe('200');

    const resOkLowercase = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled_no_reqid',
          method: 'POST',
          form: { recordingId: 'r2', recordingUrl: 'https://example.com/r2' }
        }) as any,
        resOkLowercase
      )
    ).resolves.toBe(true);
    expect(String(resOkLowercase.writeHead.mock.calls[0][0])).toBe('200');

    const resOkNoProviderCallId = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled_no_provider_call_id',
          method: 'POST',
          form: { recordingId: 'r3', recordingUrl: 'https://example.com/r3' }
        }) as any,
        resOkNoProviderCallId
      )
    ).resolves.toBe(true);
    expect(String(resOkNoProviderCallId.writeHead.mock.calls[0][0])).toBe('200');
  });

  test('/voice/webhook/recording returns 501 when compat is missing parseRecordingWebhook()', async () => {
    process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED = '0';

    const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_recording_enabled',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'inbound',
          realtimeSpec: {},
          voiceProvider: 'test',
          recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' },
          metadata: { requestId: 'req_1' }
        } as any,
        { ttlSeconds: 60 }
      );

    const providerPlugins = {
      getCompat: jest.fn(async () => ({ validateWebhookRequest: jest.fn(async () => {}) }))
    };
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
        }) as any,
        res
      )
    ).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('501');
  });

  test('/voice/webhook/recording surfaces parseRecordingWebhook validation errors', async () => {
    process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED = '0';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_enabled',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
      } as any,
      { ttlSeconds: 60 }
    );

    const providerPlugins = {
      getCompat: jest.fn(async () => ({
        validateWebhookRequest: jest.fn(async () => {}),
        parseRecordingWebhook: jest.fn(async () => {
          throw { statusCode: 400, code: 'validation_error', message: 'bad' };
        })
      }))
    };
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
        }) as any,
        res
      )
      ).resolves.toBe(true);
      expect(String(res.writeHead.mock.calls[0][0])).toBe('400');
    });

    test('/voice/webhook/recording surfaces parseRecordingWebhook errors missing statusCode/code as 500', async () => {
      process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED = '0';

      const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_recording_enabled',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'inbound',
          realtimeSpec: {},
          voiceProvider: 'test',
          recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' },
          metadata: { requestId: 'req_1' }
        } as any,
        { ttlSeconds: 60 }
      );

      const providerPlugins = {
        getCompat: jest.fn(async () => ({
          validateWebhookRequest: jest.fn(async () => {}),
          parseRecordingWebhook: jest.fn(async () => { throw {}; })
        }))
      };
      const reg = await createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store,
        providerPlugins: providerPlugins as any
      });

      const res = createMockRes();
      await expect(
        reg.handleHttp(
          createFormReq({
            url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
            method: 'POST',
            form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
          }) as any,
          res
        )
      ).resolves.toBe(true);
      expect(String(res.writeHead.mock.calls[0][0])).toBe('500');
    });

    test('/voice/webhook/recording returns 400 when parseRecordingWebhook returns missing fields', async () => {
      process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED = '0';

      const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_recording_enabled',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'inbound',
          realtimeSpec: {},
          voiceProvider: 'test',
          recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
        } as any,
        { ttlSeconds: 60 }
      );

      const providerPlugins = {
        getCompat: jest.fn(async () => ({
          validateWebhookRequest: jest.fn(async () => {}),
          parseRecordingWebhook: jest.fn(async () => ({}))
        }))
      };
      const reg = await createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store,
        providerPlugins: providerPlugins as any
      });

      const res = createMockRes();
      await expect(
        reg.handleHttp(
          createFormReq({
            url: '/voice/webhook/recording?callConfigId=cfg_recording_enabled',
            method: 'POST',
            form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
          }) as any,
          res
        )
      ).resolves.toBe(true);
      expect(String(res.writeHead.mock.calls[0][0])).toBe('400');
    });

    test('/voice/webhook/recording falls back to a default TTL when expiresAtMs is invalid', async () => {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_ttl_fallback',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
      } as any,
      { ttlSeconds: 60 }
    );

    const origGet = store.getConfig.bind(store);
    (store as any).getConfig = jest.fn(async (callConfigId: string) => {
      const cfg = await origGet(callConfigId);
      return cfg ? ({ ...(cfg as any), expiresAtMs: 0 } as any) : cfg;
    });

    const origPut = store.putConfig.bind(store);
    (store as any).putConfig = jest.fn(async (cfg: any, opts: any) => origPut(cfg, opts));

    const providerPlugins = {
      getCompat: jest.fn(async () => ({
        validateWebhookRequest: jest.fn(async () => {}),
        parseRecordingWebhook: jest.fn(async (options: any) => {
          const params = options?.params ?? {};
          return { recordingId: String(params.recordingId ?? ''), recordingUrl: String(params.recordingUrl ?? '') };
        })
      }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createFormReq({
          url: '/voice/webhook/recording?callConfigId=cfg_recording_ttl_fallback',
          method: 'POST',
          form: { recordingId: 'r1', recordingUrl: 'https://example.com/r1' }
        }) as any,
        res
      )
    ).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect((store as any).putConfig.mock.calls.some((c: any[]) => c?.[1]?.ttlSeconds === 60)).toBe(true);
  });

  test('/voice/calls/:id/events supports SSE, keepalive, and teardown', async () => {
    jest.useFakeTimers();

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const subscribe = jest.fn((_id: string, _opts: any, _onEvent: any) => ({
      accepted: true,
      replay: [{ callConfigId: 'cfg_events', atMs: Date.now(), event: undefined as any }],
      unsubscribe: jest.fn()
    }));
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] }, extensions: { voice: { events: { includeDeltas: true, keepAliveIntervalMs: 5000 } } } },
      eventsHub: eventsHub as any
    });

    const resMethod = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_events/events', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMethod)).resolves.toBe(true);
    expect(String(resMethod.writeHead.mock.calls[0][0])).toBe('405');

    const regNoAuth = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: false } },
      eventsHub: eventsHub as any
    });
    const resNoAuth = createMockRes();
    await expect(regNoAuth.handleHttp({ url: '/voice/calls/cfg_events/events', method: 'GET' } as any, resNoAuth)).resolves.toBe(true);
    expect(String(resNoAuth.writeHead.mock.calls[0][0])).toBe('501');

    const resUnknown = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/missing/events', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resUnknown)).resolves.toBe(true);
    expect(String(resUnknown.writeHead.mock.calls[0][0])).toBe('404');

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events/events';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
    expect(res.write.mock.calls.some((c: any[]) => String(c[0]).includes('event: message'))).toBe(true);

    jest.advanceTimersByTime(5000);
    expect(res.write.mock.calls.some((c: any[]) => String(c[0]).includes(': keepalive'))).toBe(true);

      req.emit('close');
      res.emit('close');
      jest.useRealTimers();
    });

  test('/voice/calls/:id/events queues events that arrive before SSE headers are written', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events_preheaders',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const unsubscribe = jest.fn();
    const subscribe = jest.fn((_id: string, _opts: any, onEvent: any) => {
      onEvent({
        callConfigId: 'cfg_events_preheaders',
        atMs: Date.now(),
        event: { type: 'assistant_transcript.final', text: 'early' }
      });
      return { accepted: true, replay: [], unsubscribe };
    });
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: eventsHub as any
    });

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events_preheaders/events';
    req.method = 'GET';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    res.write.mockReturnValue(true);

    try {
      await expect(reg.handleHttp(req, res)).resolves.toBe(true);
      expect(String(res.writeHead.mock.calls[0][0])).toBe('200');

      const chunks = res.write.mock.calls.map((c: any[]) => String(c[0])).join('');
      expect(chunks).toContain('event: assistant_transcript.final');
      expect(chunks).toContain('"text":"early"');

      req.emit('close');
      res.emit('close');
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      await reg.close();
    }
  });

  test('/voice/calls/:id/events logs call-events saturation warnings', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events_sat_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events_sat_2',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const logger: any = {
      withCorrelation: () => logger,
      debug: jest.fn(),
      info: jest.fn(),
      warning: jest.fn(),
      error: jest.fn()
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      logging: { getLogger: () => logger },
      httpConfig: {
        auth: { enabled: true, apiKeys: ['k1'] },
        extensions: { voice: { events: { maxActiveCalls: 1, keepAliveIntervalMs: 0 } } }
      }
    });

    try {
      const reqA = new EventEmitter() as any;
      reqA.url = '/voice/calls/cfg_events_sat_1/events';
      reqA.method = 'GET';
      reqA.headers = { authorization: 'Bearer k1', host: 'localhost' };
      reqA.socket = {};

      const resA = createSseRes();
      await expect(reg.handleHttp(reqA, resA)).resolves.toBe(true);
      expect(String(resA.writeHead.mock.calls[0][0])).toBe('200');

      const reqB = new EventEmitter() as any;
      reqB.url = '/voice/calls/cfg_events_sat_2/events';
      reqB.method = 'GET';
      reqB.headers = { authorization: 'Bearer k1', host: 'localhost' };
      reqB.socket = {};

      const resB = createSseRes();
      await expect(reg.handleHttp(reqB, resB)).resolves.toBe(true);
      expect(String(resB.writeHead.mock.calls[0][0])).toBe('503');
      expect(JSON.parse(String(resB.end.mock.calls[0][0]))).toEqual({
        type: 'error',
        error: { message: 'Voice call events hub is saturated', code: 'call_events_saturated' }
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(
        logger.warning.mock.calls.some(
          ([msg, data]: any[]) =>
            msg === 'voice.call_events.saturated' && data?.callConfigId === 'cfg_events_sat_2' && data?.maxActiveCalls === 1
        )
      ).toBe(true);

      reqA.emit('close');
      resA.emit('close');
      reqB.emit('close');
      resB.emit('close');
    } finally {
      await reg.close();
    }
  });

    test('/voice/calls/:id/events ignores empty eventTypes allowlist query param', async () => {
      const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_events',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'inbound',
          realtimeSpec: {},
          voiceProvider: 'test'
        } as any,
        { ttlSeconds: 60 }
      );

      const subscribe = jest.fn((_id: string, _opts: any, _onEvent: any) => ({ accepted: true, replay: [], unsubscribe: jest.fn() }));
      const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

      const reg = await createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store,
        providerPlugins: { getCompat: jest.fn() } as any,
        httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
        eventsHub: eventsHub as any
      });

      const req = new EventEmitter() as any;
      req.url = '/voice/calls/cfg_events/events?eventTypes=,';
      req.method = 'GET';
      req.headers = { authorization: 'Bearer k1', host: 'localhost' };
      req.socket = {};

      const res = createSseRes();
      await expect(reg.handleHttp(req, res)).resolves.toBe(true);
      expect(subscribe).toHaveBeenCalled();
      expect(subscribe.mock.calls[0][1]?.eventTypes).toBeUndefined();

      req.emit('close');
      res.emit('close');
    });

    test('/voice/calls/:id/events uses default keepalive interval when not configured', async () => {
      jest.useFakeTimers();

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const subscribe = jest.fn((_id: string, _opts: any, _onEvent: any) => ({ accepted: true, replay: [], unsubscribe: jest.fn() }));
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: eventsHub as any
    });

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events/events';
    req.method = 'GET';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);

    jest.advanceTimersByTime(14999);
    expect(res.write.mock.calls.some((c: any[]) => String(c[0]).includes(': keepalive'))).toBe(false);

    jest.advanceTimersByTime(1);
    expect(res.write.mock.calls.some((c: any[]) => String(c[0]).includes(': keepalive'))).toBe(true);

      req.emit('close');
      res.emit('close');
      jest.useRealTimers();
    });

    test('/voice/calls/:id/events uses default keepalive interval when keepAliveIntervalMs is invalid', async () => {
      jest.useFakeTimers();
      const prevProxyTimeout = process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;
  
      try {
        process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = 'nope';
  
        const store = createInMemoryVoiceCallConfigStore();
        await store.putConfig(
          {
            version: 1,
            callConfigId: 'cfg_events',
            createdAtMs: 0,
            expiresAtMs: 0,
            to: 'to',
            from: 'from',
            direction: 'inbound',
            realtimeSpec: {},
            voiceProvider: 'test'
          } as any,
          { ttlSeconds: 60 }
        );
  
        const subscribe = jest.fn((_id: string, _opts: any, _onEvent: any) => ({ accepted: true, replay: [], unsubscribe: jest.fn() }));
        const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };
  
        const reg = await createVoiceServerRegistration({
          server: {} as any,
          registry: {},
          pluginsPath: './plugins',
          upgradeRouter: {} as any,
          store,
          providerPlugins: { getCompat: jest.fn() } as any,
          httpConfig: {
            auth: { enabled: true, apiKeys: ['k1'] },
            extensions: { voice: { events: { keepAliveIntervalMs: 'nope', maxWriteQueueBytes: 'nope' } } }
          },
          eventsHub: eventsHub as any
        });
  
        const req = new EventEmitter() as any;
        req.url = '/voice/calls/cfg_events/events';
        req.method = 'GET';
        req.headers = { authorization: 'Bearer k1', host: 'localhost' };
        req.socket = {};
  
        const res = createSseRes();
        await expect(reg.handleHttp(req, res)).resolves.toBe(true);
  
        jest.advanceTimersByTime(14999);
        expect(res.write.mock.calls.some((c: any[]) => String(c[0]).includes(': keepalive'))).toBe(false);
  
        jest.advanceTimersByTime(1);
        expect(res.write.mock.calls.some((c: any[]) => String(c[0]).includes(': keepalive'))).toBe(true);
  
        req.emit('close');
        res.emit('close');
      } finally {
        if (prevProxyTimeout === undefined) {
          delete process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;
        } else {
          process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = prevProxyTimeout;
        }
        jest.useRealTimers();
      }
    });

    test('/voice/calls/:id/events disables keepalive when keepAliveIntervalMs <= 0', async () => {
      jest.useFakeTimers();
      const prevProxyTimeout = process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;
  
      try {
        process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = '0';
  
        const store = createInMemoryVoiceCallConfigStore();
        await store.putConfig(
          {
            version: 1,
            callConfigId: 'cfg_events',
            createdAtMs: 0,
            expiresAtMs: 0,
            to: 'to',
            from: 'from',
            direction: 'inbound',
            realtimeSpec: {},
            voiceProvider: 'test'
          } as any,
          { ttlSeconds: 60 }
        );
  
        const subscribe = jest.fn((_id: string, _opts: any, _onEvent: any) => ({ accepted: true, replay: [], unsubscribe: jest.fn() }));
        const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };
  
        const reg = await createVoiceServerRegistration({
          server: {} as any,
          registry: {},
          pluginsPath: './plugins',
          upgradeRouter: {} as any,
          store,
          providerPlugins: { getCompat: jest.fn() } as any,
          httpConfig: {
            auth: { enabled: true, apiKeys: ['k1'] },
            extensions: { voice: { events: { keepAliveIntervalMs: 0, maxWriteQueueBytes: 0 } } }
          },
          eventsHub: eventsHub as any
        });
  
        const req = new EventEmitter() as any;
        req.url = '/voice/calls/cfg_events/events';
        req.method = 'GET';
        req.headers = { authorization: 'Bearer k1', host: 'localhost' };
        req.socket = {};
  
        const res = createSseRes();
        await expect(reg.handleHttp(req, res)).resolves.toBe(true);
  
        jest.advanceTimersByTime(20000);
        expect(res.write.mock.calls.some((c: any[]) => String(c[0]).includes(': keepalive'))).toBe(false);
  
        req.emit('close');
        res.emit('close');
      } finally {
        if (prevProxyTimeout === undefined) {
          delete process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;
        } else {
          process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = prevProxyTimeout;
        }
        jest.useRealTimers();
      }
    });

    test('/voice/calls/:id/events queues writes while backpressured and flushes on drain', async () => {
      const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
        version: 1,
        callConfigId: 'cfg_events',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const unsubscribe = jest.fn();
    let onEvent: any;
    const subscribe = jest.fn((_id: string, _opts: any, cb: any) => {
      onEvent = cb;
      return {
        accepted: true,
        replay: [{ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'user_transcript.final', text: 'hi' } }],
        unsubscribe
      };
    });
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: eventsHub as any
    });

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events/events';
    req.method = 'GET';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    res.write.mockImplementationOnce(() => false).mockImplementation(() => true);

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);

    expect(typeof onEvent).toBe('function');
    onEvent({ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'assistant_transcript.final', text: 'queued' } });

    // Backpressured: should not write the queued event yet.
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();

      res.emit('drain');
      expect(res.write).toHaveBeenCalledTimes(2);
    });

    test('/voice/calls/:id/events ignores drain + events after connection is closed', async () => {
      const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_events_closed',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'inbound',
          realtimeSpec: {},
          voiceProvider: 'test'
        } as any,
        { ttlSeconds: 60 }
      );

      const unsubscribe = jest.fn();
      let onEvent: any;
      const subscribe = jest.fn((_id: string, _opts: any, cb: any) => {
        onEvent = cb;
        return {
          accepted: true,
          replay: [{ callConfigId: 'cfg_events_closed', atMs: Date.now(), event: { type: 'user_transcript.final', text: 'hi' } }],
          unsubscribe
        };
      });
      const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

      const reg = await createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store,
        providerPlugins: { getCompat: jest.fn() } as any,
        httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
        eventsHub: eventsHub as any
      });

      const req = new EventEmitter() as any;
      req.url = '/voice/calls/cfg_events_closed/events';
      req.method = 'GET';
      req.headers = { authorization: 'Bearer k1', host: 'localhost' };
      req.socket = {};

      const res = createSseRes();
      res.off = jest.fn(() => {
        throw new Error('boom');
      });
      res.write.mockImplementationOnce(() => false).mockImplementation(() => true);

      await expect(reg.handleHttp(req, res)).resolves.toBe(true);
      expect(typeof onEvent).toBe('function');
      expect(res.write).toHaveBeenCalledTimes(1);

      req.emit('close');
      expect(unsubscribe).toHaveBeenCalledTimes(1);

      onEvent({ callConfigId: 'cfg_events_closed', atMs: Date.now(), event: { type: 'assistant_transcript.final', text: 'late' } });
      expect(res.write).toHaveBeenCalledTimes(1);

      res.emit('drain');
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    test('/voice/calls/:id/events handles repeated backpressure while flushing queued writes', async () => {
      const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
        version: 1,
        callConfigId: 'cfg_events',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const unsubscribe = jest.fn();
    let onEvent: any;
    const subscribe = jest.fn((_id: string, _opts: any, cb: any) => {
      onEvent = cb;
      return {
        accepted: true,
        replay: [{ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'user_transcript.final', text: 'hi' } }],
        unsubscribe
      };
    });
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: eventsHub as any
    });

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events/events';
    req.method = 'GET';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    res.write
      .mockImplementationOnce(() => false) // initial backpressure (replay)
      .mockImplementationOnce(() => false) // backpressured again while flushing the queued event
      .mockImplementation(() => true);

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);

    expect(typeof onEvent).toBe('function');
    onEvent({ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'assistant_transcript.final', text: 'queued1' } });

    // Queued while backpressured.
    expect(res.write).toHaveBeenCalledTimes(1);

    res.emit('drain');
    expect(res.write).toHaveBeenCalledTimes(2);

    onEvent({ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'assistant_transcript.final', text: 'queued2' } });
    expect(res.write).toHaveBeenCalledTimes(2);

    res.emit('drain');
    expect(res.write).toHaveBeenCalledTimes(3);
  });

  test('/voice/calls/:id/events closes on flush write errors', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const unsubscribe = jest.fn();
    let onEvent: any;
    const subscribe = jest.fn((_id: string, _opts: any, cb: any) => {
      onEvent = cb;
      return {
        accepted: true,
        replay: [{ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'user_transcript.final', text: 'hi' } }],
        unsubscribe
      };
    });
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: eventsHub as any
    });

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events/events';
    req.method = 'GET';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    res.write
      .mockImplementationOnce(() => false) // initial backpressure
      .mockImplementationOnce(() => { throw new Error('boom'); }) // flush write fails
      .mockImplementation(() => true);

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(typeof onEvent).toBe('function');
    onEvent({ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'assistant_transcript.final', text: 'queued' } });

    res.emit('drain');
    expect(unsubscribe).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  test('/voice/calls/:id/events closes on initial write errors', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const unsubscribe = jest.fn();
    const subscribe = jest.fn((_id: string, _opts: any, _cb: any) => ({
      accepted: true,
      replay: [{ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'user_transcript.final', text: 'hi' } }],
      unsubscribe
    }));
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: eventsHub as any
    });

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events/events';
    req.method = 'GET';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    res.write.mockImplementationOnce(() => { throw new Error('boom'); });

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  test('/voice/calls/:id/events closes when write queue exceeds maxWriteQueueBytes', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_events',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );

    const unsubscribe = jest.fn();
    let onEvent: any;
    const subscribe = jest.fn((_id: string, _opts: any, cb: any) => {
      onEvent = cb;
      return { accepted: true, replay: [], unsubscribe };
    });
    const eventsHub = { emit: jest.fn(), subscribe, snapshot: jest.fn(() => ({ activeCalls: 0, totalSubscribers: 0, calls: [] })), close: jest.fn() };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] }, extensions: { voice: { events: { maxWriteQueueBytes: 1 } } } },
      eventsHub: eventsHub as any
    });

    const req = new EventEmitter() as any;
    req.url = '/voice/calls/cfg_events/events';
    req.method = 'GET';
    req.headers = { authorization: 'Bearer k1', host: 'localhost' };
    req.socket = {};

    const res = createSseRes();
    res.write.mockReturnValue(false);

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(typeof onEvent).toBe('function');

    onEvent({ callConfigId: 'cfg_events', atMs: Date.now(), event: { type: 'assistant_transcript.final', text: 'x' } });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test('/voice/calls/:id/end handles auth/missing config/provider and success', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_end_missing_provider',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: undefined
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_end_missing_call',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_end_ready',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        providerCallId: 'c1'
      } as any,
      { ttlSeconds: 60 }
    );

    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({}))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const resMethod = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_end_ready/end', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMethod)).resolves.toBe(true);
    expect(String(resMethod.writeHead.mock.calls[0][0])).toBe('405');

    const regNoAuth = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: false } }
    });
    const resNoAuth = createMockRes();
    await expect(regNoAuth.handleHttp({ url: '/voice/calls/cfg_end_ready/end', method: 'POST' } as any, resNoAuth)).resolves.toBe(true);
    expect(String(resNoAuth.writeHead.mock.calls[0][0])).toBe('501');

    const resUnknown = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/missing/end', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resUnknown)).resolves.toBe(true);
    expect(String(resUnknown.writeHead.mock.calls[0][0])).toBe('404');

    const resMissingProvider = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_end_missing_provider/end', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMissingProvider)).resolves.toBe(true);
    expect(String(resMissingProvider.writeHead.mock.calls[0][0])).toBe('400');

    const resMissingProviderCallId = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_end_missing_call/end', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMissingProviderCallId)).resolves.toBe(true);
    expect(String(resMissingProviderCallId.writeHead.mock.calls[0][0])).toBe('409');

    providerPlugins.getManifest.mockRejectedValueOnce(new Error('nope'));
    const resUnknownProvider = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_end_ready/end', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resUnknownProvider)).resolves.toBe(true);
    expect(String(resUnknownProvider.writeHead.mock.calls[0][0])).toBe('400');

    const resNoCompat = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_end_ready/end', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNoCompat)).resolves.toBe(true);
    expect(String(resNoCompat.writeHead.mock.calls[0][0])).toBe('501');

    const endCall = jest.fn(async () => {});
    providerPlugins.getCompat.mockResolvedValueOnce({ endCall });
    const resOk = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_end_ready/end', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resOk)).resolves.toBe(true);
    expect(String(resOk.writeHead.mock.calls[0][0])).toBe('200');
    expect(endCall).toHaveBeenCalled();
  });

  test('/voice/calls/:id/recording handles provider download and upstream failures', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_missing_provider',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: undefined
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_disabled',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_enabled',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_ready',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono', providerRecording: { id: 'r1', url: 'https://example.com/r1' } }
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_ready_id',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono', providerRecording: { id: 'r2' } }
      } as any,
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_recording_ready_wav',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        recording: { enabled: true, mode: 'provider', format: 'wav', channels: 'mono', providerRecording: { id: 'r3' } }
      } as any,
      { ttlSeconds: 60 }
    );

    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({}))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const resMethod = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'POST', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMethod)).resolves.toBe(true);
    expect(String(resMethod.writeHead.mock.calls[0][0])).toBe('405');

    const regNoAuth = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: false } }
    });
    const resNoAuth = createMockRes();
    await expect(regNoAuth.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording' } as any, resNoAuth)).resolves.toBe(true);
    expect(String(resNoAuth.writeHead.mock.calls[0][0])).toBe('501');

    const resUnknown = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/missing/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resUnknown)).resolves.toBe(true);
    expect(String(resUnknown.writeHead.mock.calls[0][0])).toBe('404');

    const resMissingProvider = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_missing_provider/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resMissingProvider)).resolves.toBe(true);
    expect(String(resMissingProvider.writeHead.mock.calls[0][0])).toBe('400');

    const resNotEnabled = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_disabled/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNotEnabled)).resolves.toBe(true);
    expect(String(resNotEnabled.writeHead.mock.calls[0][0])).toBe('409');

    const resNotReady = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_enabled/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNotReady)).resolves.toBe(true);
    expect(String(resNotReady.writeHead.mock.calls[0][0])).toBe('409');

    providerPlugins.getManifest.mockRejectedValueOnce(new Error('nope'));
    const resUnknownProvider = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resUnknownProvider)).resolves.toBe(true);
    expect(String(resUnknownProvider.writeHead.mock.calls[0][0])).toBe('400');

    const resNoCompat = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready_id/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNoCompat)).resolves.toBe(true);
    expect(String(resNoCompat.writeHead.mock.calls[0][0])).toBe('501');

    providerPlugins.getCompat.mockResolvedValueOnce({ getRecordingDownloadRequest: jest.fn(async () => ({ url: '' })) });
    const resNoUrl = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNoUrl)).resolves.toBe(true);
    expect(String(resNoUrl.writeHead.mock.calls[0][0])).toBe('502');

    providerPlugins.getCompat.mockResolvedValueOnce({ getRecordingDownloadRequest: jest.fn(async () => undefined) });
    const resNoDownload = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNoDownload)).resolves.toBe(true);
    expect(String(resNoDownload.writeHead.mock.calls[0][0])).toBe('502');

    const prevFetch = globalThis.fetch;
    const fromWebSpy = jest.spyOn(Readable, 'fromWeb').mockImplementation(() => {
      const stream = new Readable({ read() {} });
      queueMicrotask(() => stream.destroy(new Error('boom')));
      return stream as any;
    });
      try {
        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'nope', headers: new Headers(), body: null })) as any;
        providerPlugins.getCompat.mockResolvedValueOnce({ getRecordingDownloadRequest: jest.fn(async () => ({ url: 'https://example.com/r1', headers: { a: 'b' } })) });
        const resUpstreamFail = createMockRes();
        await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resUpstreamFail)).resolves.toBe(true);
        expect(String(resUpstreamFail.writeHead.mock.calls[0][0])).toBe('502');

        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => { throw new Error('boom'); }, headers: new Headers(), body: null })) as any;
        providerPlugins.getCompat.mockResolvedValueOnce({ getRecordingDownloadRequest: jest.fn(async () => ({ url: 'https://example.com/r1' })) });
        const resUpstreamTextError = createMockRes();
        await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resUpstreamTextError)).resolves.toBe(true);
        expect(String(resUpstreamTextError.writeHead.mock.calls[0][0])).toBe('502');

        globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '', headers: new Headers(), body: null })) as any;
        providerPlugins.getCompat.mockResolvedValueOnce({ getRecordingDownloadRequest: jest.fn(async () => ({ url: 'https://example.com/r1' })) });
        const resNoBody = createMockRes();
        await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNoBody)).resolves.toBe(true);
        expect(String(resNoBody.writeHead.mock.calls[0][0])).toBe('200');

        providerPlugins.getCompat.mockResolvedValueOnce({ getRecordingDownloadRequest: jest.fn(async () => ({ url: 'https://example.com/r3' })) });
        const resWav = createMockRes();
        await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready_wav/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resWav)).resolves.toBe(true);
        expect(String(resWav.writeHead.mock.calls[0][0])).toBe('200');
        expect(String(resWav.writeHead.mock.calls[0][1]?.['Content-Disposition'] ?? '')).toContain('cfg_recording_ready_wav.wav');

        const rs = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        }
      });
      globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '', headers: new Headers({ 'content-type': 'audio/mpeg' }), body: rs })) as any;
      providerPlugins.getCompat.mockResolvedValueOnce({ getRecordingDownloadRequest: jest.fn(async () => ({ url: 'https://example.com/r1' })) });

      const resStream = new MockStreamRes() as any;
      resStream.end = jest.fn(resStream.end.bind(resStream));

      await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resStream)).resolves.toBe(true);
      expect(String(resStream.writeHead.mock.calls[0][0])).toBe('200');
      expect(resStream.end).toHaveBeenCalled();
      } finally {
        globalThis.fetch = prevFetch;
        fromWebSpy.mockRestore();
      }
    });

    test('/voice/calls/:id/recording handles AbortError and thrown errors', async () => {
      const store = createInMemoryVoiceCallConfigStore();
      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_recording_ready',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'outbound',
          realtimeSpec: {},
          voiceProvider: 'test',
          recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono', providerRecording: { id: 'r1', url: 'https://example.com/r1' } }
        } as any,
        { ttlSeconds: 60 }
      );

      const providerPlugins: any = {
        getManifest: jest.fn(async () => ({ defaults: {} })),
        getCompat: jest.fn(async () => ({ getRecordingDownloadRequest: jest.fn(async () => ({ url: 'https://example.com/r1' })) }))
      };

      const prevFetch = globalThis.fetch;
      try {
        const reg = await createVoiceServerRegistration({
          server: {} as any,
          registry: {},
          pluginsPath: './plugins',
          upgradeRouter: {} as any,
          store,
          providerPlugins,
          httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
        });

        const abortErr: any = new Error('aborted');
        abortErr.name = 'AbortError';
        globalThis.fetch = jest.fn(async () => { throw abortErr; }) as any;

        const resAbort = createMockRes();
        await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resAbort)).resolves.toBe(true);
        expect(String(resAbort.writeHead.mock.calls[0][0])).toBe('502');

        const resAbortSent = createMockRes();
        resAbortSent.headersSent = true;
        await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resAbortSent)).resolves.toBe(true);
        expect(resAbortSent.end).toHaveBeenCalled();

          globalThis.fetch = jest.fn(async () => { throw new Error('boom'); }) as any;
          const resBoom = createMockRes();
          await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resBoom)).resolves.toBe(true);
          expect(String(resBoom.writeHead.mock.calls[0][0])).toBe('502');

          globalThis.fetch = jest.fn(async () => { throw {}; }) as any;
          const resNoMessage = createMockRes();
          await expect(reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, resNoMessage)).resolves.toBe(true);
          expect(String(resNoMessage.writeHead.mock.calls[0][0])).toBe('502');
        } finally {
          globalThis.fetch = prevFetch;
        }
      });

    test('/voice/calls/:id/recording ends the response when a timeout abort occurs after headers are sent', async () => {
      jest.useFakeTimers();
      const prevTimeout = process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;
      const prevFetch = globalThis.fetch;
      try {
        process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = '1';

        const store = createInMemoryVoiceCallConfigStore();
        await store.putConfig(
          {
            version: 1,
            callConfigId: 'cfg_recording_ready',
            createdAtMs: 0,
            expiresAtMs: 0,
            to: 'to',
            from: 'from',
            direction: 'outbound',
            realtimeSpec: {},
            voiceProvider: 'test',
            recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono', providerRecording: { id: 'r1', url: 'https://example.com/r1' } }
          } as any,
          { ttlSeconds: 60 }
        );

        const providerPlugins: any = {
          getManifest: jest.fn(async () => ({ defaults: {} })),
          getCompat: jest.fn(async () => ({ getRecordingDownloadRequest: jest.fn(async () => ({ url: 'https://example.com/r1' })) }))
        };

        const reg = await createVoiceServerRegistration({
          server: {} as any,
          registry: {},
          pluginsPath: './plugins',
          upgradeRouter: {} as any,
          store,
          providerPlugins,
          httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
        });

        globalThis.fetch = jest.fn((_url: any, init: any) => {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            const abort = () => {
              const err: any = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (signal?.aborted) return abort();
            signal?.addEventListener?.('abort', abort);
          });
        }) as any;

        const res = createMockRes();
        res.headersSent = true;
        const promise = reg.handleHttp({ url: '/voice/calls/cfg_recording_ready/recording', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, res);

        await jest.advanceTimersByTimeAsync(5);
        await expect(promise).resolves.toBe(true);
        expect(res.end).toHaveBeenCalled();
      } finally {
        if (prevTimeout === undefined) {
          delete process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;
        } else {
          process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = prevTimeout;
        }
        globalThis.fetch = prevFetch;
        jest.useRealTimers();
      }
    });

      test('POST /voice/calls fails fast when persisting providerCallId fails (and attempts cleanup)', async () => {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    const origGet = store.getConfig.bind(store);
    (store as any).getConfig = jest.fn(async (callConfigId: string) => {
      const cfg = await origGet(callConfigId);
      return cfg ? ({ ...(cfg as any), expiresAtMs: 0 } as any) : cfg;
    });
    const origPut = store.putConfig.bind(store);
    (store as any).putConfig = jest.fn(async (config: any, opts: any) => {
      if (typeof config?.providerCallId === 'string' && config.providerCallId) {
        throw 'db down';
      }
      return origPut(config, opts);
    });

    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'c1' }));
    const endCall = jest.fn(async () => ({ ok: true }));
    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall, endCall }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: { to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test', metadata: { requestId: 'req_1' } }
        }),
        res
      )
    ).resolves.toBe(true);

    expect(String(res.writeHead.mock.calls[0][0])).toBe('500');
    expect(createOutboundCall).toHaveBeenCalled();
      expect(endCall).toHaveBeenCalledWith(expect.objectContaining({ providerCallId: 'c1' }));
    });

    test('POST /voice/calls attempts cleanup even when compat endCall fails after providerCallId persist error', async () => {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    const origGet = store.getConfig.bind(store);
    (store as any).getConfig = jest.fn(async (callConfigId: string) => {
      const cfg = await origGet(callConfigId);
      return cfg ? ({ ...(cfg as any), expiresAtMs: 0 } as any) : cfg;
    });
    const origPut = store.putConfig.bind(store);
    (store as any).putConfig = jest.fn(async (config: any, opts: any) => {
      if (typeof config?.providerCallId === 'string' && config.providerCallId) {
        throw 'db down';
      }
      return origPut(config, opts);
    });

    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'c1' }));
    const endCall = jest.fn(async () => {
      throw 'end failed';
    });
    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall, endCall }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: { to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test', metadata: { requestId: 'req_1' } }
        }),
        res
      )
    ).resolves.toBe(true);

    expect(String(res.writeHead.mock.calls[0][0])).toBe('500');
      expect(createOutboundCall).toHaveBeenCalled();
      expect(endCall).toHaveBeenCalledWith(expect.objectContaining({ providerCallId: 'c1' }));
    });

    test('POST /voice/calls logs cleanup failures without requestId context', async () => {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const store = createInMemoryVoiceCallConfigStore();
    const origGet = store.getConfig.bind(store);
    (store as any).getConfig = jest.fn(async (callConfigId: string) => {
      const cfg = await origGet(callConfigId);
      return cfg ? ({ ...(cfg as any), expiresAtMs: 0 } as any) : cfg;
    });
    const origPut = store.putConfig.bind(store);
    (store as any).putConfig = jest.fn(async (config: any, opts: any) => {
      if (typeof config?.providerCallId === 'string' && config.providerCallId) {
        throw 'db down';
      }
      return origPut(config, opts);
    });

    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'c1' }));
    const endCall = jest.fn(async () => {
      throw new Error('end failed');
    });
    const providerPlugins: any = {
      getManifest: jest.fn(async () => ({ defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall, endCall }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    const res = createMockRes();
    await expect(
      reg.handleHttp(
        createJsonReq({
          url: '/voice/calls',
          method: 'POST',
          headers: { authorization: 'Bearer k1', host: 'localhost' },
          body: { to: 'to', from: 'from', realtimeSpec: {}, voiceProvider: 'test' }
        }),
        res
      )
    ).resolves.toBe(true);

    expect(String(res.writeHead.mock.calls[0][0])).toBe('500');
    expect(createOutboundCall).toHaveBeenCalled();
    expect(endCall).toHaveBeenCalledWith(expect.objectContaining({ providerCallId: 'c1' }));
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
