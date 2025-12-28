import { jest } from '@jest/globals';
import crypto from 'crypto';
import http from 'http';

import { createSignedWsToken } from '@/modules/security/index.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';
import { ProviderExecutionError } from '@/kernel/index.ts';

import TwilioVoiceCompat from '../../index.ts';

function makeToken(secret: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return createSignedWsToken({ secret, payload: { iat: nowSeconds, exp: nowSeconds + 60, nonce: 'n1' } });
}

function startMessage() {
  return JSON.stringify({
    event: 'start',
    streamSid: 'MZ123',
    start: {
      streamSid: 'MZ123',
      accountSid: 'AC123',
      callSid: 'CA123',
      customParameters: {
        from: '+15551234567',
        to: '+15557654321',
        direction: 'inbound',
        callConfigId: 'cfg_1'
      }
    }
  });
}

function stopMessage() {
  return JSON.stringify({ event: 'stop', streamSid: 'MZ123' });
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function createSpyLogger() {
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

function createSpyMetrics() {
  return { compatError: jest.fn() } as any;
}

function createRegistryHarness() {
  let closeCompat: (() => void) | undefined;
  const compatClosed = new Promise<void>(resolve => {
    closeCompat = resolve;
  });

  const compatSession: any = {
    sendText: jest.fn(),
    injectContext: jest.fn(),
    sendAudio: jest.fn(),
    commit: jest.fn(),
    interrupt: jest.fn(),
    sendToolResult: jest.fn(),
    close: jest.fn().mockImplementation(() => closeCompat?.()),
    events: async function* () {
      yield { type: 'ready', sessionId: 's1' };
      await compatClosed;
    }
  };

  const createSession = jest.fn(async (options: any) => {
    return compatSession;
  });

  const registry: any = {
    getRealtimeProvider: jest.fn(async (id: string) => ({ id, compat: 'mock' })),
    getRealtimeCompat: jest.fn(async () => ({ createSession })),
    getTools: jest.fn(async () => []),
    getProcessRoutes: jest.fn(async () => [])
  };

  return { registry, createSession, compatSession };
}

describe('plugins/voice-compat/twilio', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    else process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;
  });

  test('createWebhookResponse returns TwiML and includes stream url + parameters', async () => {
    const compat = new TwilioVoiceCompat();
    const res = await compat.createWebhookResponse({
      req: new http.IncomingMessage(null as any),
      callConfigId: 'cfg_1',
      callConfig: { to: '+1', from: '+2', direction: 'inbound' },
      voiceProvider: 'twilio',
      mediaWsUrl: 'wss://example.test/voice/media?token=abc'
    });

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/xml');
    expect(res.body).toContain('voice/media?token=abc');
    expect(res.body).toContain('callConfigId');
    expect(res.body).toContain('cfg_1');
    expect(res.body).toContain('direction');
    expect(res.body).toContain('inbound');
  });

  test('createWebhookResponse omits to/from when not strings', async () => {
    const compat = new TwilioVoiceCompat();
    const res = await compat.createWebhookResponse({
      req: new http.IncomingMessage(null as any),
      callConfigId: 'cfg_1',
      callConfig: { to: 123, from: null, direction: 'inbound' },
      voiceProvider: 'twilio',
      mediaWsUrl: 'wss://example.test/voice/media?token=abc'
    });

    expect(res.body).toContain('callConfigId');
    expect(res.body).not.toContain('name=\"to\"');
    expect(res.body).not.toContain('name=\"from\"');
  });

  test('createWebhookResponse tolerates missing callConfig', async () => {
    const compat = new TwilioVoiceCompat();
    const res = await compat.createWebhookResponse({
      req: new http.IncomingMessage(null as any),
      callConfigId: 'cfg_1',
      callConfig: undefined,
      voiceProvider: 'twilio',
      mediaWsUrl: 'wss://example.test/voice/media?token=abc'
    });

    expect(res.body).toContain('callConfigId');
    expect(res.body).toContain('cfg_1');
  });

  test('handleMediaConnection merges systemPrompt + metadata and bridges start/stop', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret');

    const { registry, createSession } = createRegistryHarness();
    const logger = createSpyLogger();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        to: '+15557654321',
        from: '+15551234567',
        direction: 'inbound',
        systemPrompt: 'sys',
        realtimeSpec: { provider: 'realtime_p1', metadata: { existing: true } }
      },
      voiceProvider: 'twilio',
      registry,
      logger
    });

    ws.emitMessage(startMessage());
    await flush();
    ws.emitMessage(stopMessage());
    await task;

    expect(createSession).toHaveBeenCalledTimes(1);
    const passed = createSession.mock.calls[0][0];
    expect(passed?.spec?.systemPrompt).toBe('sys');
    expect(passed?.spec?.metadata?.existing).toBe(true);
    expect(passed?.spec?.metadata?.callConfigId).toBe('cfg_1');
    expect(passed?.spec?.metadata?.voiceProvider).toBe('twilio');
    expect(passed?.spec?.metadata?.providerCallMetadata?.streamSid).toBe('MZ123');

    const logged = JSON.stringify({ info: logger.info.mock.calls, error: logger.error.mock.calls });
    expect(logged).toContain('voice.media.stream_started');
    expect(logged).toContain('voice.realtime.ready');
    expect(logged).toContain('providerStreamId');
    expect(logged).toContain('realtimeSessionId');
    expect(logged).not.toContain('sys');
  });

  test('handleMediaConnection logs bridge errors without leaking systemPrompt or media payload', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret');

    const { registry } = createRegistryHarness();
    const logger = createSpyLogger();
    const metrics = createSpyMetrics();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        systemPrompt: 'TOP_SECRET',
        realtimeSpec: { provider: 'realtime_p1' }
      },
      voiceProvider: 'twilio',
      registry,
      logger,
      metrics
    });

    ws.emitMessage(startMessage());
    await flush();

    ws.emitMessage(JSON.stringify({ event: 'media', streamSid: 'DIFF', media: { payload: 'QUJD' } }));
    await task;

    expect(logger.error).toHaveBeenCalled();
    const errorCalls = logger.error.mock.calls;
    expect(errorCalls.some(([msg]) => msg === 'voice.media.bridge_error')).toBe(true);

    const serialized = JSON.stringify({ info: logger.info.mock.calls, error: logger.error.mock.calls });
    expect(serialized).not.toContain('TOP_SECRET');
    expect(serialized).not.toContain('QUJD');

    expect(metrics.compatError).toHaveBeenCalledWith('media_bridge', 'twilio');
  });

  test('handleMediaConnection logs bridge errors when media arrives before start (no provider ids)', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret');

    const { registry } = createRegistryHarness();
    const logger = createSpyLogger();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        systemPrompt: 'TOP_SECRET',
        realtimeSpec: { provider: 'realtime_p1' }
      },
      voiceProvider: 'twilio',
      registry,
      logger
    });

    ws.emitMessage(JSON.stringify({ event: 'media', streamSid: 'MZ123', media: { payload: 'QUJD' } }));
    await task;

    const errorCalls = logger.error.mock.calls;
    const bridgeError = errorCalls.find(([msg]) => msg === 'voice.media.bridge_error');
    expect(bridgeError).toBeTruthy();
    expect(JSON.stringify(bridgeError?.[1] ?? {})).toContain('media_before_start');
    expect(JSON.stringify(bridgeError?.[1] ?? {})).not.toContain('providerStreamId');

    const serialized = JSON.stringify({ info: logger.info.mock.calls, error: logger.error.mock.calls });
    expect(serialized).not.toContain('TOP_SECRET');
    expect(serialized).not.toContain('QUJD');
  });

  test('handleMediaConnection handles missing systemPrompt and non-object metadata', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret');

    const { registry, createSession } = createRegistryHarness();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_2',
      callConfig: {
        direction: 'inbound',
        realtimeSpec: { provider: 'realtime_p1', metadata: ['not-object'] }
      },
      voiceProvider: 'twilio',
      registry
    });

    ws.emitMessage(startMessage());
    await flush();
    ws.emitMessage(stopMessage());
    await task;

    expect(createSession).toHaveBeenCalledTimes(1);
    const passed = createSession.mock.calls[0][0];
    expect(passed?.spec?.systemPrompt).toBeUndefined();
    expect(passed?.spec?.metadata?.callConfigId).toBe('cfg_2');
  });

  test('handleMediaConnection tolerates missing callConfig', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret');

    const { registry, createSession } = createRegistryHarness();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_3',
      callConfig: undefined,
      voiceProvider: 'twilio',
      registry
    });

    ws.emitMessage(startMessage());
    await flush();
    ws.emitMessage(stopMessage());
    await task;

    expect(createSession).toHaveBeenCalledTimes(1);
    const passed = createSession.mock.calls[0][0];
    expect(passed?.spec?.metadata?.callConfigId).toBe('cfg_3');
  });

  test('handleMediaConnection throws when ws token secret is missing', async () => {
    delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;

    const { registry } = createRegistryHarness();
    const compat = new TwilioVoiceCompat();

    await expect(
      compat.handleMediaConnection({
        ws: new MockWebSocket() as any,
        req: new http.IncomingMessage(null as any),
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'realtime_p1' } },
        voiceProvider: 'twilio',
        registry
      })
    ).rejects.toThrow('Missing LLM_ADAPTER_VOICE_WS_TOKEN_SECRET');
  });

  test('createOutboundCall validates required fields', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.createOutboundCall({
        to: '',
        from: '',
        callConfigId: '',
        mediaWsUrl: '',
        providerDefaults: { accountSid: 'AC123', authToken: 't' }
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('createOutboundCall treats undefined fields as empty for validation', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.createOutboundCall({
        to: undefined as any,
        from: undefined as any,
        callConfigId: undefined as any,
        mediaWsUrl: '',
        providerDefaults: { accountSid: 'AC123', authToken: 't' }
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('createOutboundCall throws provider_config_error when credentials are missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.createOutboundCall({
        to: '+1',
        from: '+2',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: {}
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('createOutboundCall treats non-object providerDefaults as empty', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.createOutboundCall({
        to: '+1',
        from: '+2',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: [] as any
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('createOutboundCall falls back to default apiBaseUrl when empty', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sid: 'CA777' }), { status: 201, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      const res = await compat.createOutboundCall({
        to: '+1',
        from: '+2',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: '' }
      });

      expect(res.providerCallId).toBe('CA777');
      expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall (twiml mode) posts inline TwiML and returns sid', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sid: 'CA123' }), { status: 201, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      const res = await compat.createOutboundCall({
        to: '+15551234567',
        from: '+15557654321',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          apiBaseUrl: 'https://api.example.test',
          outbound: { mode: 'twiml' }
        }
      });

      expect(res.providerCallId).toBe('CA123');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('https://api.example.test/2010-04-01/Accounts/AC123/Calls.json');
      expect(init?.method).toBe('POST');
      expect(init?.headers?.Authorization).toBe(`Basic ${Buffer.from('AC123:token').toString('base64')}`);
      expect(init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');

      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('To')).toBe('+15551234567');
      expect(body.get('From')).toBe('+15557654321');
      expect(body.get('Url')).toBeNull();
      expect(String(body.get('Twiml'))).toContain('voice/media?token=abc');
      expect(String(body.get('Twiml'))).toContain('cfg_1');
      expect(String(body.get('Twiml'))).toContain('outbound');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall (url mode) posts Url and returns sid', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sid: 'CA999' }), { status: 201, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      const res = await compat.createOutboundCall({
        to: '+15551234567',
        from: '+15557654321',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          apiBaseUrl: 'https://api.example.test',
          outbound: { mode: 'url', webhookUrl: 'https://example.test/voice/webhook' }
        }
      });

      expect(res.providerCallId).toBe('CA999');

      const [_url, init] = fetchSpy.mock.calls[0];
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('Twiml')).toBeNull();
      expect(body.get('Url')).toBe('https://example.test/voice/webhook?callConfigId=cfg_1');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall (url mode) throws provider_config_error when webhookUrl is missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.createOutboundCall({
        to: '+15551234567',
        from: '+15557654321',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          outbound: { mode: 'url' }
        }
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('createOutboundCall throws provider_config_error for unsupported mode', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.createOutboundCall({
        to: '+1',
        from: '+2',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          outbound: { mode: 'weird' }
        }
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('createOutboundCall throws ProviderExecutionError on non-2xx', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429 }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.createOutboundCall({
          to: '+1',
          from: '+2',
          callConfigId: 'cfg_1',
          mediaWsUrl: 'wss://example.test/voice/media?token=abc',
          providerDefaults: { accountSid: 'AC123', authToken: 'token' }
        })
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall uses empty suffix when response text throws', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('boom');
      }
    } as any);

    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.createOutboundCall({
          to: '+1',
          from: '+2',
          callConfigId: 'cfg_1',
          mediaWsUrl: 'wss://example.test/voice/media?token=abc',
          providerDefaults: { accountSid: 'AC123', authToken: 'token' }
        })
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall throws ProviderExecutionError when response JSON is invalid', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('not-json', { status: 201, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.createOutboundCall({
          to: '+1',
          from: '+2',
          callConfigId: 'cfg_1',
          mediaWsUrl: 'wss://example.test/voice/media?token=abc',
          providerDefaults: { accountSid: 'AC123', authToken: 'token' }
        })
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall throws ProviderExecutionError when sid is missing', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.createOutboundCall({
          to: '+1',
          from: '+2',
          callConfigId: 'cfg_1',
          mediaWsUrl: 'wss://example.test/voice/media?token=abc',
          providerDefaults: { accountSid: 'AC123', authToken: 'token' }
        })
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('validateWebhookRequest accepts valid signature', async () => {
    const compat = new TwilioVoiceCompat();

    const authToken = 'token';
    const url = 'https://example.test/voice/webhook?callConfigId=cfg_1';
    const params = { CallSid: 'CA123', From: '+1' };

    const data = url + 'CallSid' + 'CA123' + 'From' + '+1';
    const signature = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: { 'x-twilio-signature': signature } } as any,
        url,
        params,
        providerDefaults: { authToken }
      })
    ).resolves.toBeUndefined();
  });

  test('validateWebhookRequest rejects invalid signature', async () => {
    const compat = new TwilioVoiceCompat();

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: { 'x-twilio-signature': 'bad' } } as any,
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        params: { CallSid: 'CA123' },
        providerDefaults: { authToken: 'token' }
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('validateWebhookRequest throws provider_config_error when authToken is missing', async () => {
    const compat = new TwilioVoiceCompat();

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: { 'x-twilio-signature': 'sig' } } as any,
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        params: { CallSid: 'CA123' },
        providerDefaults: {}
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('validateWebhookRequest throws unauthorized when signature header is missing', async () => {
    const compat = new TwilioVoiceCompat();

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: {} } as any,
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        params: { CallSid: 'CA123' },
        providerDefaults: { authToken: 'token' }
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('validateWebhookRequest rejects empty signature header arrays', async () => {
    const compat = new TwilioVoiceCompat();

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: { 'x-twilio-signature': [] } } as any,
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        params: { CallSid: 'CA123' },
        providerDefaults: { authToken: 'token' }
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });

  test('validateWebhookRequest throws provider_config_error when providerDefaults are missing', async () => {
    const compat = new TwilioVoiceCompat();

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: { 'x-twilio-signature': 'sig' } } as any,
        url: 'https://example.test/voice/webhook?callConfigId=cfg_1',
        params: { CallSid: 'CA123' },
        providerDefaults: undefined
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('validateWebhookRequest accepts valid signature with array header and undefined param values', async () => {
    const compat = new TwilioVoiceCompat();

    const authToken = 'token';
    const url = 'https://example.test/voice/webhook?callConfigId=cfg_1';
    const params = { A: undefined as any };

    const data = url + 'A';
    const signature = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: { 'x-twilio-signature': [signature] } } as any,
        url,
        params,
        providerDefaults: { authToken }
      })
    ).resolves.toBeUndefined();
  });

  test('validateWebhookRequest treats non-object params as empty when verifying signature', async () => {
    const compat = new TwilioVoiceCompat();

    const authToken = 'token';
    const url = 'https://example.test/voice/webhook?callConfigId=cfg_1';

    const signature = crypto.createHmac('sha1', authToken).update(url, 'utf8').digest('base64');

    await expect(
      (compat as any).validateWebhookRequest({
        req: { headers: { 'x-twilio-signature': signature } } as any,
        url,
        params: 'bad' as any,
        providerDefaults: { authToken }
      })
    ).resolves.toBeUndefined();
  });
});
