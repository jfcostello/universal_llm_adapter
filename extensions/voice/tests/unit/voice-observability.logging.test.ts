import { jest } from '@jest/globals';
import { Readable } from 'stream';

describe('extensions/voice: observability logging', () => {
  function createMockRes() {
    return { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() } as any;
  }

  function createCapturingLogger() {
    const logger: any = {
      withCorrelation: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warning: jest.fn(),
      error: jest.fn(),
      logLLMRequest: jest.fn(),
      logLLMResponse: jest.fn(),
      close: jest.fn(async () => {})
    };
    logger.withCorrelation.mockReturnValue(logger);
    return logger;
  }

  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    } else {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;
    }
  });

  test('swallows custom logging getter errors', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

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

    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: '<ok/>' }));
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn(async () => ({ createWebhookResponse })) } as any,
      logging: {
        getLogger: () => {
          throw new Error('boom');
        }
      }
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
  });

  test('swallows logging module import failures', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../../modules/logging/index.js', () => {
      throw new Error('logging module should not be imported in this test');
    });

    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

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

    const createWebhookResponse = jest.fn(async () => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: '<ok/>' }));
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn(async () => ({ createWebhookResponse })) } as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/webhook?callConfigId=cfg_1', method: 'GET', headers: { host: 'localhost' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
  });

  test('/voice/calls logs lifecycle events without leaking systemPrompt', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const logger = createCapturingLogger();

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

    const store = createInMemoryVoiceCallConfigStore();
    const createOutboundCall = jest.fn(async () => ({ providerCallId: 'p1' }));
    const providerPlugins = {
      getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      logging: { getLogger: () => logger }
    });

    const res = createMockRes();
    const req = Object.assign(
      Readable.from([
        JSON.stringify({
          to: 'to',
          from: 'from',
          systemPrompt: 'TOP_SECRET',
          realtimeSpec: { provider: 'realtime_p1' },
          voiceProvider: 'test'
        })
      ]),
      {
        url: '/voice/calls',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer k1' },
        socket: {}
      }
    ) as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');

    const payload = JSON.parse(String(res.end.mock.calls[0][0]));
    expect(payload.callConfigId).toMatch(/^voice_cfg_/);
    expect(payload.providerCallId).toBe('p1');

    const logged = JSON.stringify({ info: logger.info.mock.calls, warn: logger.warning.mock.calls, err: logger.error.mock.calls });
    expect(logged).toContain('voice.calls.accepted');
    expect(logged).toContain('voice.calls.queued');
    expect(logged).not.toContain('TOP_SECRET');
  });

  test('/voice/webhook logs without leaking ws token', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const logger = createCapturingLogger();

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

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
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: `<x>${options.mediaWsUrl}</x>`
    }));
    const providerPlugins = { getCompat: jest.fn(async () => ({ createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      logging: { getLogger: () => logger }
    });

    const res = createMockRes();
    const req = {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'GET',
      headers: { host: 'localhost' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');

    const logged = JSON.stringify({ info: logger.info.mock.calls, warn: logger.warning.mock.calls, err: logger.error.mock.calls });
    expect(logged).toContain('voice.webhook.request');
    expect(logged).toContain('voice.webhook.response');
    expect(logged).not.toContain('token=');
  });

  test('/voice/webhook validation failure logs 500s without requiring an error code', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const logger = createCapturingLogger();

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

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
      throw new Error('boom');
    });
    const createWebhookResponse = jest.fn();
    const providerPlugins = { getCompat: jest.fn(async () => ({ validateWebhookRequest, createWebhookResponse })) };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      logging: { getLogger: () => logger }
    });

    const res = createMockRes();
    const req = {
      url: '/voice/webhook?callConfigId=cfg_1',
      method: 'GET',
      headers: { host: 'localhost' },
      socket: {}
    } as any;

    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('500');

    const logged = JSON.stringify({ err: logger.error.mock.calls, warn: logger.warning.mock.calls });
    expect(logged).toContain('voice.webhook.validation_failed');
    expect(createWebhookResponse).not.toHaveBeenCalled();
  });

  test('/voice/calls idempotency log tolerates missing ids in stored response', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const logger = createCapturingLogger();

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

    const store = createInMemoryVoiceCallConfigStore();
    await store.putIdempotency('idem_1', { status: 'queued' }, { ttlSeconds: 60 });

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      logging: { getLogger: () => logger }
    });

    const req = Object.assign(
      Readable.from([
        JSON.stringify({
          to: 'to',
          from: 'from',
          realtimeSpec: { provider: 'realtime_p1' },
          voiceProvider: 'test'
        })
      ]),
      {
        url: '/voice/calls',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer k1', 'idempotency-key': 'idem_1' },
        socket: {}
      }
    ) as any;

    const res = createMockRes();
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');

    const logged = logger.info.mock.calls;
    const hit = logged.find(([msg]) => msg === 'voice.calls.idempotency_hit');
    expect(hit).toBeTruthy();
    expect(hit?.[1]).toEqual({ voiceProvider: 'test' });
  });

  test('/voice/calls idempotency wait-hit log tolerates missing ids in ready response', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const logger = createCapturingLogger();

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

    const baseStore = createInMemoryVoiceCallConfigStore();
    let returnEmptyReady = false;
    let lockReady: (() => void) | undefined;
    const lockConsumed = new Promise<void>(resolve => {
      lockReady = resolve;
    });

    const store: any = {
      ...baseStore,
      consumeNonceOnce: async (nonce: string, options: any) => {
        const ok = await baseStore.consumeNonceOnce(nonce, options);
        if (nonce === 'idem:idem_wait' && ok) lockReady?.();
        return ok;
      },
      putIdempotency: async (key: string, value: any, options: any) => {
        returnEmptyReady = true;
        await baseStore.putIdempotency(key, value, options);
      },
      getIdempotency: async (key: string) => {
        const value = await baseStore.getIdempotency(key);
        if (!value) return value;
        if (!returnEmptyReady) return value;
        return { ...value, callConfigId: undefined, providerCallId: undefined };
      }
    };

    const createOutboundCall = jest.fn(async () => {
      await new Promise(res => setTimeout(res, 50));
      return { providerCallId: 'p1' };
    });
    const providerPlugins = {
      getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: {} })),
      getCompat: jest.fn(async () => ({ createOutboundCall }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      logging: { getLogger: () => logger }
    });

    const makeReq = () =>
      Object.assign(
        Readable.from([
          JSON.stringify({ to: 'to', from: 'from', realtimeSpec: { provider: 'realtime_p1' }, voiceProvider: 'test', ttlSeconds: 60 })
        ]),
        {
          url: '/voice/calls',
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer k1', 'idempotency-key': 'idem_wait' },
          socket: {}
        }
      ) as any;

    const res1 = createMockRes();
    const req1 = makeReq();
    const p1 = reg.handleHttp(req1, res1);

    await lockConsumed;

    const res2 = createMockRes();
    const req2 = makeReq();
    const p2 = reg.handleHttp(req2, res2);

    await Promise.all([p1, p2]);

    expect(String(res1.writeHead.mock.calls[0][0])).toBe('200');
    expect(String(res2.writeHead.mock.calls[0][0])).toBe('200');
    expect(createOutboundCall).toHaveBeenCalledTimes(1);

    const hit = logger.info.mock.calls.find(([msg]) => msg === 'voice.calls.idempotency_hit');
    expect(hit).toBeTruthy();
    expect(JSON.stringify(hit?.[1] ?? {})).not.toContain('callConfigId');
    expect(JSON.stringify(hit?.[1] ?? {})).not.toContain('providerCallId');
  });

  test('/voice/calls error logging handles missing callConfigId and missing error metadata', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const logger = createCapturingLogger();

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store: {
        ...store,
        getIdempotency: async () => {
          throw new Error('boom');
        }
      },
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() } as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      logging: { getLogger: () => logger }
    });

    const req = Object.assign(
      Readable.from([
        JSON.stringify({
          to: 'to',
          from: 'from',
          realtimeSpec: { provider: 'realtime_p1' },
          voiceProvider: 'test',
          idempotencyKey: 'idem_throw'
        })
      ]),
      {
        url: '/voice/calls',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer k1' },
        socket: {}
      }
    ) as any;

    const res = createMockRes();
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('500');

    const logged = JSON.stringify({ warn: logger.warning.mock.calls, err: logger.error.mock.calls });
    expect(logged).toContain('voice.calls.error');
    expect(logged).not.toContain('callConfigId');
  });

  test('/voice/calls error logging distinguishes warning from error and includes error codes', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const logger = createCapturingLogger();

    const { createVoiceServerRegistration } = await import('../../internal/server.js');
    const { createInMemoryVoiceCallConfigStore } = await import('../../internal/call-config-store/index.js');

    const store = createInMemoryVoiceCallConfigStore();
    const providerPlugins = {
      getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: {} })),
      getCompat: jest.fn(async () => ({
        createOutboundCall: async () => {
          const err: any = new Error('bad request');
          err.statusCode = 400;
          throw err;
        }
      }))
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: providerPlugins as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      logging: { getLogger: () => logger }
    });

    const req = Object.assign(
      Readable.from([
        JSON.stringify({
          to: 'to',
          from: 'from',
          realtimeSpec: { provider: 'realtime_p1' },
          voiceProvider: 'test'
        })
      ]),
      {
        url: '/voice/calls',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer k1' },
        socket: {}
      }
    ) as any;

    const res = createMockRes();
    await expect(reg.handleHttp(req, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('400');
    expect(logger.warning.mock.calls.some(([msg]) => msg === 'voice.calls.error')).toBe(true);

    const providerPlugins500 = {
      getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: {} })),
      getCompat: jest.fn(async () => ({
        createOutboundCall: async () => {
          const err: any = new Error('provider error');
          err.statusCode = 500;
          err.code = 'provider_error';
          throw err;
        }
      }))
    };

    const reg500 = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: providerPlugins500 as any,
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      logging: { getLogger: () => logger }
    });

    const req500 = Object.assign(
      Readable.from([
        JSON.stringify({
          to: 'to',
          from: 'from',
          realtimeSpec: { provider: 'realtime_p1' },
          voiceProvider: 'test'
        })
      ]),
      {
        url: '/voice/calls',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer k1' },
        socket: {}
      }
    ) as any;

    const res500 = createMockRes();
    await expect(reg500.handleHttp(req500, res500)).resolves.toBe(true);
    expect(String(res500.writeHead.mock.calls[0][0])).toBe('500');
    expect(logger.error.mock.calls.some(([msg]) => msg === 'voice.calls.error')).toBe(true);
    expect(JSON.stringify(logger.error.mock.calls)).toContain('provider_error');
  });
});
