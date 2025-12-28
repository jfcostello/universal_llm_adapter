import { jest } from '@jest/globals';
import http from 'http';

import { createSignedWsToken } from '@/modules/security/index.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';

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
      registry
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

  test('createOutboundCall throws not implemented', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(compat.createOutboundCall()).rejects.toMatchObject({ statusCode: 501, code: 'not_implemented' });
  });
});
