import { jest } from '@jest/globals';
import crypto from 'crypto';
import http from 'http';

import { createSignedWsToken } from '@/modules/security/index.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';
import { ProviderExecutionError } from '@/kernel/index.ts';

import TwilioVoiceCompat from '../../index.ts';

function makeToken(secret: string, payload: Record<string, unknown> = {}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return createSignedWsToken({ secret, payload: { iat: nowSeconds, exp: nowSeconds + 60, nonce: 'n1', ...payload } });
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

function createRegistryHarnessWithCompatSession(options: { events: () => AsyncIterable<any> }) {
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
      yield* options.events();
      await compatClosed;
    }
  };

  const createSession = jest.fn(async (_options: any) => compatSession);

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
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

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
        realtimeSpec: { provider: 'realtime_p1', metadata: { existing: true } },
        metadata: { requestId: 'req_123' }
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
    expect(logged).toContain('req_123');
    expect(logged).not.toContain('sys');
  });

  test('handleMediaConnection triggers assistantFirstTurn (dynamic greeting) after ready', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

    const { registry, compatSession } = createRegistryHarness();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        realtimeSpec: { provider: 'realtime_p1' },
        assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
        metadata: { requestId: 'req_123' }
      },
      voiceProvider: 'twilio',
      registry
    });

    ws.emitMessage(startMessage());
    await flush();

    expect(compatSession.sendText).toHaveBeenCalledWith({ text: 'Say hello briefly.', role: 'user' });
    expect(compatSession.commit).toHaveBeenCalled();

    ws.emitMessage(stopMessage());
    await task;
  });

  test('silence timeout is armed after first assistant audio end when assistantFirstTurn is enabled', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sid: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          await new Promise(resolve => setTimeout(resolve, 2000));
          yield { type: 'assistant_audio.end' };
        }
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const taskPromise = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
          timeouts: { silenceTimeoutMs: 1000 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      try {
        // Silence timer should not start until assistant_audio.end (emitted at t=2000ms).
        await jest.advanceTimersByTimeAsync(1500);
        expect(fetchSpy).not.toHaveBeenCalled();

        // Cross assistant_audio.end (2000ms) and allow it to schedule the silence timer.
        await jest.advanceTimersByTimeAsync(600);

        // Past silenceTimeoutMs (1000ms).
        await jest.advanceTimersByTimeAsync(1000);

        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        ws.close();
        await taskPromise;
      }
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('assistant_audio.chunk does not schedule assistant audio end fallback after first assistant_audio.end', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          await new Promise(resolve => setTimeout(resolve, 10));
          yield { type: 'assistant_audio.end' };
          await new Promise(resolve => setTimeout(resolve, 10));
          yield {
            type: 'assistant_audio.chunk',
            frame: {
              format: 'g711_ulaw',
              sampleRateHz: 8000,
              channels: 1,
              dataBase64: Buffer.alloc(200).toString('base64')
            }
          };
        }
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const taskPromise = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
          timeouts: { silenceTimeoutMs: 1000 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(25);

      ws.emitMessage(stopMessage());
      await taskPromise;
    } finally {
      jest.useRealTimers();
    }
  });

  test('silence timeout is armed under fallback when assistant_audio.end is missing', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          await new Promise(resolve => setTimeout(resolve, 300));
          yield {
            type: 'assistant_audio.chunk',
            frame: {
              format: 'g711_ulaw',
              sampleRateHz: 8000,
              channels: 1,
              dataBase64: Buffer.alloc(200).toString('base64')
            }
          };
          // No assistant_audio.end event emitted.
        }
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const taskPromise = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
          timeouts: { silenceTimeoutMs: 1000 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      // Should not fire during the initial assistant audio window.
      await jest.advanceTimersByTimeAsync(1500);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Should eventually fire once assistant audio is considered ended under fallback + silenceTimeoutMs has elapsed.
      await jest.advanceTimersByTimeAsync(2000);
      expect(fetchSpy).toHaveBeenCalled();

      ws.close();
      await taskPromise;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('silence timeout fallback window is configurable via call config', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          await new Promise(resolve => setTimeout(resolve, 300));
          yield {
            type: 'assistant_audio.chunk',
            frame: {
              format: 'g711_ulaw',
              sampleRateHz: 8000,
              channels: 1,
              dataBase64: Buffer.alloc(200).toString('base64')
            }
          };
          // No assistant_audio.end event emitted.
        }
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const taskPromise = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
          timeouts: { silenceTimeoutMs: 1000, silenceAssistantAudioEndFallbackMs: 200 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      // With fallback=200ms and silenceTimeout=1000ms, end should happen at ~300ms (chunk) + 200ms + 1000ms = 1500ms.
      await jest.advanceTimersByTimeAsync(1400);
      expect(fetchSpy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(200);
      expect(fetchSpy).toHaveBeenCalled();

      ws.close();
      await taskPromise;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('silence timeout is armed even if no assistant audio events are emitted', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          // No assistant_audio.chunk/end events emitted.
        }
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const taskPromise = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
          timeouts: { silenceTimeoutMs: 1000, silenceAssistantAudioStartFallbackMs: 200 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      // Fallback=200ms + silenceTimeout=1000ms => should end by ~1200ms even without audio boundary events.
      await jest.advanceTimersByTimeAsync(1100);
      expect(fetchSpy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(200);
      expect(fetchSpy).toHaveBeenCalled();

      ws.close();
      await taskPromise;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('does not schedule silence fallback timers once the call is already ended', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(() => {
      return new Promise(resolve => {
        setTimeout(
          () =>
            resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any),
          100
        );
      });
    });

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry, compatSession } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          await new Promise(resolve => setTimeout(resolve, 10));
          yield {
            type: 'assistant_audio.chunk',
            frame: {
              format: 'g711_ulaw',
              sampleRateHz: 8000,
              channels: 1,
              dataBase64: Buffer.alloc(200).toString('base64')
            }
          };
        }
      });

      compatSession.commit.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const taskPromise = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
          timeouts: { silenceTimeoutMs: 1000, callTimeoutMs: 1 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      // End call via callTimeout before assistantFirstTurn commit finishes.
      await jest.advanceTimersByTimeAsync(2);
      expect(fetchSpy).toHaveBeenCalled();

      // Allow post-end realtime events to be observed while endCall is pending.
      await jest.advanceTimersByTimeAsync(50);

      // Resolve endCall and shutdown.
      await jest.advanceTimersByTimeAsync(200);
      await taskPromise;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('does not schedule assistant-audio-start fallback once assistant audio has already ended', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry, compatSession } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          await new Promise(resolve => setTimeout(resolve, 10));
          yield { type: 'assistant_audio.end' };
        }
      });

      compatSession.commit.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const taskPromise = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 },
          timeouts: { silenceTimeoutMs: 1000, silenceAssistantAudioStartFallbackMs: 25 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      // assistant_audio.end should arrive before the assistantFirstTurn commit finishes.
      await jest.advanceTimersByTimeAsync(60);
      expect(fetchSpy).not.toHaveBeenCalled();

      ws.close();
      await taskPromise;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('handleMediaConnection throws validation_error for invalid timeouts.callTimeoutMs', async () => {
    const { registry } = createRegistryHarness();
    const compat = new TwilioVoiceCompat();

    await expect(
      compat.handleMediaConnection({
        ws: new MockWebSocket() as any,
        req: { url: '/voice/media?token=x' } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          timeouts: { callTimeoutMs: 0 }
        },
        voiceProvider: 'twilio',
        registry
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('handleMediaConnection throws validation_error for invalid timeouts.silenceTimeoutMs', async () => {
    const { registry } = createRegistryHarness();
    const compat = new TwilioVoiceCompat();

    await expect(
      compat.handleMediaConnection({
        ws: new MockWebSocket() as any,
        req: { url: '/voice/media?token=x' } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          timeouts: { silenceTimeoutMs: -1 }
        },
        voiceProvider: 'twilio',
        registry
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('handleMediaConnection throws validation_error for invalid timeouts.silenceAssistantAudioEndFallbackMs', async () => {
    const { registry } = createRegistryHarness();
    const compat = new TwilioVoiceCompat();

    await expect(
      compat.handleMediaConnection({
        ws: new MockWebSocket() as any,
        req: { url: '/voice/media?token=x' } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          timeouts: { silenceAssistantAudioEndFallbackMs: 0 }
        },
        voiceProvider: 'twilio',
        registry
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('handleMediaConnection throws validation_error for invalid timeouts.silenceAssistantAudioStartFallbackMs', async () => {
    const { registry } = createRegistryHarness();
    const compat = new TwilioVoiceCompat();

    await expect(
      compat.handleMediaConnection({
        ws: new MockWebSocket() as any,
        req: { url: '/voice/media?token=x' } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          timeouts: { silenceAssistantAudioStartFallbackMs: 0 }
        },
        voiceProvider: 'twilio',
        registry
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('handleMediaConnection logs bridge_error when assistantFirstTurn.delayMs is invalid', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

    const { registry } = createRegistryHarness();
    const logger = createSpyLogger();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        realtimeSpec: { provider: 'realtime_p1' },
        assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: -1 }
      },
      voiceProvider: 'twilio',
      registry,
      logger
    });

    ws.emitMessage(startMessage());
    await task;

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('voice.media.bridge_error');
    expect(logged).toContain('Invalid assistantFirstTurn.delayMs');
  });

  test('handleMediaConnection delays assistantFirstTurn when delayMs > 0', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry, compatSession } = createRegistryHarness();

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 500 }
        },
        voiceProvider: 'twilio',
        registry
      });

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(400);
      expect(compatSession.sendText).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(200);
      expect(compatSession.sendText).toHaveBeenCalledWith({ text: 'Say hello briefly.', role: 'user' });
      expect(compatSession.commit).toHaveBeenCalled();

      ws.emitMessage(stopMessage());
      await task;
    } finally {
      jest.useRealTimers();
    }
  });

  test('handleMediaConnection ends the call when assistantFirstTurn fails', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry, compatSession } = createRegistryHarness();
      compatSession.sendText.mockImplementation(() => {
        throw new Error('nope');
      });

      const logger = createSpyLogger();

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'user', delayMs: 0 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' },
        logger
      } as any);

      ws.emitMessage(startMessage());
      await task;

      expect(fetchSpy).toHaveBeenCalled();
      expect(JSON.stringify(logger.error.mock.calls)).toContain('voice.assistant_first_turn.failed');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('handleMediaConnection supports assistantFirstTurn role=system and default delayMs=0', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

    const { registry, compatSession } = createRegistryHarness();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        realtimeSpec: { provider: 'realtime_p1' },
        assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', role: 'system' }
      },
      voiceProvider: 'twilio',
      registry
    } as any);

    ws.emitMessage(startMessage());
    await flush();

    expect(compatSession.sendText).toHaveBeenCalledWith({ text: 'Say hello briefly.', role: 'system' });
    expect(compatSession.commit).toHaveBeenCalled();

    ws.emitMessage(stopMessage());
    await task;
  });

  test('assistantFirstTurn enabled with missing prompt is treated as disabled (silence timeout starts at call start)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarness();

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true },
          timeouts: { silenceTimeoutMs: 10 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(20);
      expect(fetchSpy).toHaveBeenCalled();
      await task;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('call end request is idempotent (call_timeout then assistantFirstTurn failure does not emit twice)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const endRequestedEvents: any[] = [];
      const emit = jest.fn((event: any) => {
        if (event?.type === 'voice.call.end_requested') endRequestedEvents.push(event);
      });

      const { registry } = createRegistryHarness();

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.', delayMs: 50 },
          timeouts: { callTimeoutMs: 10 }
        },
        voiceProvider: 'twilio',
        registry,
        events: { emit }
      } as any);

      ws.emitMessage(
        JSON.stringify({
          event: 'start',
          streamSid: 'MZ123',
          start: {
            streamSid: 'MZ123',
            accountSid: 'AC123',
            callSid: '',
            customParameters: { from: '+15551234567', to: '+15557654321', direction: 'inbound', callConfigId: 'cfg_1' }
          }
        })
      );

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(20);
      await task;

      // Let the delayed assistantFirstTurn attempt run and fail after the call already ended.
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(0);

      expect(emit).toHaveBeenCalled();
      expect(endRequestedEvents).toHaveLength(1);
      expect(endRequestedEvents[0].reason).toBe('call_timeout');
      expect(endRequestedEvents[0].providerCallId).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('handleMediaConnection logs assistant_first_turn.failed with message fallback and code when sendText throws a non-Error', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

    const { registry, compatSession } = createRegistryHarness();
    compatSession.sendText.mockImplementation(() => {
      throw { code: 'bad' };
    });

    const logger = createSpyLogger();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        realtimeSpec: { provider: 'realtime_p1' },
        assistantFirstTurn: { enabled: true, prompt: 'Say hello briefly.' }
      },
      voiceProvider: 'twilio',
      registry,
      logger
    } as any);

    ws.emitMessage(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZ123',
        start: {
          streamSid: 'MZ123',
          accountSid: 'AC123',
          callSid: '',
          customParameters: { from: '+15551234567', to: '+15557654321', direction: 'inbound', callConfigId: 'cfg_1' }
        }
      })
    );
    await task;

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('voice.assistant_first_turn.failed');
    expect(logged).toContain('[object Object]');
    expect(logged).toContain('bad');
  });

  test('handleMediaConnection tolerates realtime events without a type field', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

    const { registry } = createRegistryHarnessWithCompatSession({
      events: async function* () {
        yield { type: 'ready', sessionId: 's1' };
        yield {};
      }
    });

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: { realtimeSpec: { provider: 'realtime_p1' } },
      voiceProvider: 'twilio',
      registry
    } as any);

    ws.emitMessage(startMessage());
    await flush();
    ws.emitMessage(stopMessage());
    await task;
  });

  test('handleMediaConnection sets and clears call timeout timer (unref) when configured', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

    const { registry } = createRegistryHarness();

    const compat = new TwilioVoiceCompat();
    const ws = new MockWebSocket();
    const task = compat.handleMediaConnection({
      ws: ws as any,
      req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
      callConfigId: 'cfg_1',
      callConfig: {
        realtimeSpec: { provider: 'realtime_p1' },
        timeouts: { callTimeoutMs: 60000 }
      },
      voiceProvider: 'twilio',
      registry,
      providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
    } as any);

    ws.emitMessage(startMessage());
    await flush();
    ws.emitMessage(stopMessage());
    await task;
  });

  test('handleMediaConnection logs end_failed when call timeout triggers but terminate fails', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarness();
      const logger = createSpyLogger();

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          timeouts: { callTimeoutMs: 10 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' },
        logger
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(20);
      await jest.advanceTimersByTimeAsync(0);

      await task;

      expect(fetchSpy).toHaveBeenCalled();
      expect(JSON.stringify(logger.error.mock.calls)).toContain('voice.call.end_failed');
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('handleMediaConnection logs end_failed with provider status when endCall throws an object', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarness();
      const logger = createSpyLogger();

      const compat = new TwilioVoiceCompat();
      (compat as any).endCall = jest.fn(async () => {
        throw { code: 'provider_down', status: 503 };
      });

      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'realtime_p1' }, timeouts: { callTimeoutMs: 10 } },
        voiceProvider: 'twilio',
        registry,
        logger
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(20);

      await task;

      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).toContain('voice.call.end_failed');
      expect(logged).toContain('provider_down');
      expect(logged).toContain('503');
    } finally {
      jest.useRealTimers();
    }
  });

  test('handleMediaConnection logs end_failed with undefined statusCode when endCall throws without status', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarness();
      const logger = createSpyLogger();

      const compat = new TwilioVoiceCompat();
      (compat as any).endCall = jest.fn(async () => {
        throw { code: 'provider_down' };
      });

      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: { provider: 'realtime_p1' }, timeouts: { callTimeoutMs: 10 } },
        voiceProvider: 'twilio',
        registry,
        logger
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(20);
      await task;

      const logged = JSON.stringify(logger.error.mock.calls);
      expect(logged).toContain('voice.call.end_failed');
      expect(logged).toContain('provider_down');
      expect(logged).not.toContain('statusCode');
    } finally {
      jest.useRealTimers();
    }
  });

  test('handleMediaConnection starts silence timeout at call start when assistantFirstTurn is disabled', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarness();

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          timeouts: { silenceTimeoutMs: 1000 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(999);
      expect(fetchSpy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(2);
      expect(fetchSpy).toHaveBeenCalled();

      await task;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('silence timeout clears on user_speech.started and assistant_audio.chunk events', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    try {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
      const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

      const { registry } = createRegistryHarnessWithCompatSession({
        events: async function* () {
          yield { type: 'ready', sessionId: 's1' };
          await new Promise(resolve => setTimeout(resolve, 300));
          yield {
            type: 'assistant_audio.chunk',
            frame: {
              format: 'g711_ulaw',
              sampleRateHz: 8000,
              channels: 1,
              dataBase64: Buffer.alloc(200).toString('base64')
            }
          };
          await new Promise(resolve => setTimeout(resolve, 100));
          yield { type: 'assistant_audio.end' };
          await new Promise(resolve => setTimeout(resolve, 300));
          yield { type: 'user_speech.started' };
          await new Promise(resolve => setTimeout(resolve, 100));
          yield { type: 'assistant_audio.end' };
        }
      });

      const compat = new TwilioVoiceCompat();
      const ws = new MockWebSocket();
      const task = compat.handleMediaConnection({
        ws: ws as any,
        req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any,
        callConfigId: 'cfg_1',
        callConfig: {
          realtimeSpec: { provider: 'realtime_p1' },
          timeouts: { silenceTimeoutMs: 1000 }
        },
        voiceProvider: 'twilio',
        registry,
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      } as any);

      ws.emitMessage(startMessage());
      await jest.advanceTimersByTimeAsync(0);

      // Past the original 1000ms but before the final 800ms+1000ms window.
      await jest.advanceTimersByTimeAsync(1100);
      expect(fetchSpy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(900);
      expect(fetchSpy).toHaveBeenCalled();

      await task;
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('handleMediaConnection logs bridge errors without leaking systemPrompt or media payload', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

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
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'twilio' });

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
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_2', voiceProvider: 'twilio' });

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
    const token = makeToken('secret', { purpose: 'voice_media', callConfigId: 'cfg_3', voiceProvider: 'twilio' });

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

  test('createOutboundCall includes recording + TimeLimit when configured', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sid: 'CA123' }), { status: 201, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      await compat.createOutboundCall({
        to: '+15551234567',
        from: '+15557654321',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        recordingStatusCallbackUrl: 'https://adapter.example/voice/webhook/recording?callConfigId=cfg_1',
        callConfig: {
          timeouts: { callTimeoutMs: 12345 },
          recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'dual' }
        },
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          apiBaseUrl: 'https://api.example.test',
          outbound: { mode: 'twiml' }
        }
      });

      const [_url, init] = fetchSpy.mock.calls[0];
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('TimeLimit')).toBe('13');
      expect(body.get('Record')).toBe('true');
      expect(body.get('RecordingChannels')).toBe('dual');
      expect(body.get('RecordingStatusCallback')).toBe('https://adapter.example/voice/webhook/recording?callConfigId=cfg_1');
      expect(body.get('RecordingStatusCallbackEvent')).toBe('completed');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall uses provider recording defaults and omits RecordingStatusCallback when missing', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sid: 'CA123' }), { status: 201, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      await compat.createOutboundCall({
        to: '+15551234567',
        from: '+15557654321',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        callConfig: {
          recording: { enabled: true }
        },
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          apiBaseUrl: 'https://api.example.test',
          outbound: { mode: 'twiml' }
        }
      } as any);

      const [_url, init] = fetchSpy.mock.calls[0];
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('Record')).toBe('true');
      expect(body.get('RecordingChannels')).toBe('mono');
      expect(body.get('RecordingStatusCallback')).toBeNull();
      expect(body.get('RecordingStatusCallbackEvent')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('createOutboundCall throws validation_error when timeouts.callTimeoutMs is invalid', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.createOutboundCall({
        to: '+15551234567',
        from: '+15557654321',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        callConfig: { timeouts: { callTimeoutMs: 0 } },
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          apiBaseUrl: 'https://api.example.test',
          outbound: { mode: 'twiml' }
        }
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('endCall updates call status to completed', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      const res = await compat.endCall({
        providerCallId: 'CA123',
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' }
      });
      expect(res).toEqual({ ok: true });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('https://api.example.test/2010-04-01/Accounts/AC123/Calls/CA123.json');
      expect(init?.method).toBe('POST');
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('Status')).toBe('completed');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('endCall throws validation_error when providerCallId is missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.endCall({ providerCallId: undefined, providerDefaults: { accountSid: 'AC123', authToken: 'token' } } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('endCall throws provider_config_error when credentials are missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.endCall({ providerCallId: 'CA123', providerDefaults: { accountSid: 'AC123' } } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('endCall wraps fetch failures in ProviderExecutionError', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockRejectedValue(new Error('boom'));
    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.endCall({ providerCallId: 'CA123', providerDefaults: { accountSid: 'AC123', authToken: 'token' } } as any)
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('endCall throws ProviderExecutionError on non-2xx', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429, headers: { 'Content-Type': 'text/plain' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.endCall({ providerCallId: 'CA123', providerDefaults: { accountSid: 'AC123', authToken: 'token' } } as any)
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('endCall treats non-object providerDefaults as empty', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(compat.endCall({ providerCallId: 'CA123', providerDefaults: 'nope' } as any)).rejects.toMatchObject({
      statusCode: 500,
      code: 'provider_config_error'
    });
  });

  test('endCall falls back to default apiBaseUrl when empty', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    );

    const compat = new TwilioVoiceCompat();
    try {
      await compat.endCall({
        providerCallId: 'CA123',
        providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: '   ' }
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Calls/CA123.json');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('endCall wraps fetch failures without message in ProviderExecutionError', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockRejectedValue({});
    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.endCall({ providerCallId: 'CA123', providerDefaults: { accountSid: 'AC123', authToken: 'token' } } as any)
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('endCall uses empty suffix when response text throws', async () => {
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn(async () => {
        throw new Error('boom');
      })
    } as any);

    const compat = new TwilioVoiceCompat();
    try {
      await expect(
        compat.endCall({ providerCallId: 'CA123', providerDefaults: { accountSid: 'AC123', authToken: 'token' } } as any)
      ).rejects.toBeInstanceOf(ProviderExecutionError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('parseRecordingWebhook returns normalized recording fields', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: {
          RecordingSid: 'r1',
          RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123',
          RecordingStatus: 'completed',
          CallSid: 'c1'
        },
        providerDefaults: { apiBaseUrl: 'https://api.twilio.com' }
      } as any)
    ).resolves.toEqual({
      recordingId: 'r1',
      recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123',
      recordingStatus: 'completed',
      providerCallId: 'c1'
    });
  });

  test('parseRecordingWebhook accepts alternate param names and callConfig providerCallId fallback', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { recordingSid: 'r1', recordingUrl: 'https://api.twilio.com/r1', recordingStatus: 'completed' },
        callConfig: { providerCallId: 'c1' },
        providerDefaults: { apiBaseUrl: 'https://api.twilio.com' }
      } as any)
    ).resolves.toEqual({
      recordingId: 'r1',
      recordingUrl: 'https://api.twilio.com/r1',
      recordingStatus: 'completed',
      providerCallId: 'c1'
    });
  });

  test('parseRecordingWebhook omits optional fields when not provided', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { RecordingSid: 'r1', RecordingUrl: 'https://api.twilio.com/r1' },
        providerDefaults: { apiBaseUrl: 'https://api.twilio.com' }
      } as any)
    ).resolves.toEqual({
      recordingId: 'r1',
      recordingUrl: 'https://api.twilio.com/r1'
    });
  });

  test('parseRecordingWebhook falls back to default apiBaseUrl when empty', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { RecordingSid: 'r1', RecordingUrl: 'https://api.twilio.com/r1' },
        providerDefaults: { apiBaseUrl: '' }
      } as any)
    ).resolves.toEqual({
      recordingId: 'r1',
      recordingUrl: 'https://api.twilio.com/r1'
    });
  });

  test('parseRecordingWebhook falls back to default apiBaseUrl when providerDefaults is missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { RecordingSid: 'r1', RecordingUrl: 'https://api.twilio.com/r1' }
      } as any)
    ).resolves.toEqual({
      recordingId: 'r1',
      recordingUrl: 'https://api.twilio.com/r1'
    });
  });

  test('parseRecordingWebhook throws provider_config_error when apiBaseUrl is invalid', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { RecordingSid: 'r1', RecordingUrl: 'https://api.twilio.com/r1' },
        providerDefaults: { apiBaseUrl: 'not-a-url' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('parseRecordingWebhook treats non-object params as missing fields', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({ params: 'nope' as any, providerDefaults: { apiBaseUrl: 'https://api.twilio.com' } } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('parseRecordingWebhook rejects non-https recordingUrl', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { RecordingSid: 'r1', RecordingUrl: 'http://api.twilio.com/r1' },
        providerDefaults: { apiBaseUrl: 'https://api.twilio.com' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('parseRecordingWebhook rejects unexpected recordingUrl origin', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { RecordingSid: 'r1', RecordingUrl: 'https://evil.example/r1' },
        providerDefaults: { apiBaseUrl: 'https://api.twilio.com' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('parseRecordingWebhook rejects malformed recordingUrl', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({
        params: { RecordingSid: 'r1', RecordingUrl: 'not-a-url' },
        providerDefaults: { apiBaseUrl: 'https://api.twilio.com' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('parseRecordingWebhook throws validation_error when required fields are missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.parseRecordingWebhook({ params: { RecordingSid: 'r1' } } as any)
    ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
  });

  test('getRecordingDownloadRequest appends extension and RequestedChannels', async () => {
    const compat = new TwilioVoiceCompat();
    const req = await compat.getRecordingDownloadRequest({
      callConfigId: 'cfg_1',
      callConfig: {
        recording: {
          enabled: true,
          mode: 'provider',
          format: 'mp3',
          channels: 'dual',
          providerRecording: { id: 'rec_1', url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123' }
        }
      },
      providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.twilio.com' }
    } as any);

    expect(req.url).toContain('https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123.mp3');
    expect(req.url).toContain('RequestedChannels=2');
    expect(req.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:token').toString('base64')}`);
  });

  test('getRecordingDownloadRequest throws recording_not_ready when provider URL is missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { recording: { enabled: true, mode: 'provider' } },
        providerDefaults: { accountSid: 'AC123', authToken: 'token' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 409, code: 'recording_not_ready' });
  });

  test('getRecordingDownloadRequest throws provider_config_error when credentials are missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: {
          recording: {
            enabled: true,
            mode: 'provider',
            providerRecording: { id: 'rec_1', url: 'https://recording.example/rec_1' }
          }
        },
        providerDefaults: { accountSid: 'AC123' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('getRecordingDownloadRequest throws provider_error when URL is invalid', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: {
          recording: {
            enabled: true,
            mode: 'provider',
            providerRecording: { id: 'rec_1', url: 'not a url' }
          }
        },
        providerDefaults: { accountSid: 'AC123', authToken: 'token' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_error' });
  });

  test('getRecordingDownloadRequest defaults callConfig when missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: undefined,
        providerDefaults: { accountSid: 'AC123', authToken: 'token' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 409, code: 'recording_not_ready' });
  });

  test('getRecordingDownloadRequest treats non-object recording config as missing', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: { recording: 123 },
        providerDefaults: { accountSid: 'AC123', authToken: 'token' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 409, code: 'recording_not_ready' });
  });

  test('getRecordingDownloadRequest treats non-object providerDefaults as empty', async () => {
    const compat = new TwilioVoiceCompat();
    await expect(
      compat.getRecordingDownloadRequest({
        callConfigId: 'cfg_1',
        callConfig: {
          recording: {
            enabled: true,
            mode: 'provider',
            providerRecording: { id: 'rec_1', url: 'https://recording.example/rec_1' }
          }
        },
        providerDefaults: 'nope'
      } as any)
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('getRecordingDownloadRequest appends wav extension when format is wav', async () => {
    const compat = new TwilioVoiceCompat();
    const req = await compat.getRecordingDownloadRequest({
      callConfigId: 'cfg_1',
      callConfig: {
        recording: {
          enabled: true,
          mode: 'provider',
          format: 'wav',
          providerRecording: { id: 'rec_1', url: 'https://recording.example/rec_1' }
        }
      },
      providerDefaults: { accountSid: 'AC123', authToken: 'token' }
    } as any);

    expect(req.url).toContain('https://recording.example/rec_1.wav');
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

  test('createOutboundCall throws provider_config_error when outbound timeoutMs is invalid', async () => {
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
          outbound: { mode: 'twiml', timeoutMs: 0 }
        }
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
  });

  test('createOutboundCall aborts with ProviderExecutionError on timeout', async () => {
    jest.useFakeTimers();

    const fetchSpy = jest
      .spyOn(globalThis as any, 'fetch')
      .mockImplementation((_url: any, init: any) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

    const compat = new TwilioVoiceCompat();
    try {
      const promise = compat.createOutboundCall({
        to: '+1',
        from: '+2',
        callConfigId: 'cfg_1',
        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
        providerDefaults: {
          accountSid: 'AC123',
          authToken: 'token',
          outbound: { mode: 'twiml', timeoutMs: 10 }
        }
      });
      const caught = promise.catch(err => err);

      await jest.advanceTimersByTimeAsync(20);

      const error = await caught;

      expect(error).toBeInstanceOf(ProviderExecutionError);
      expect(error).toMatchObject({ statusCode: 504 });
    } finally {
      fetchSpy.mockRestore();
      jest.useRealTimers();
    }
  }, 2000);

	  test('createOutboundCall wraps fetch failures in ProviderExecutionError', async () => {
	    const fetchSpy = jest
	      .spyOn(globalThis as any, 'fetch')
	      .mockRejectedValue(new Error('boom'));

	    const compat = new TwilioVoiceCompat();
	    try {
	      const promise = compat.createOutboundCall({
	        to: '+1',
	        from: '+2',
	        callConfigId: 'cfg_1',
	        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
	        providerDefaults: {
	          accountSid: 'AC123',
	          authToken: 'token',
	          outbound: { mode: 'twiml', timeoutMs: 10 }
	        }
	      });
	      const error = await promise.catch(err => err);

	      expect(error).toBeInstanceOf(ProviderExecutionError);
	      expect(error).toMatchObject({ statusCode: 502 });
	    } finally {
	      fetchSpy.mockRestore();
	    }
	  });

	  test('createOutboundCall wraps fetch failures without message in ProviderExecutionError', async () => {
	    const fetchSpy = jest
	      .spyOn(globalThis as any, 'fetch')
	      .mockRejectedValue({});

	    const compat = new TwilioVoiceCompat();
	    try {
	      const promise = compat.createOutboundCall({
	        to: '+1',
	        from: '+2',
	        callConfigId: 'cfg_1',
	        mediaWsUrl: 'wss://example.test/voice/media?token=abc',
	        providerDefaults: {
	          accountSid: 'AC123',
	          authToken: 'token',
	          outbound: { mode: 'twiml', timeoutMs: 10 }
	        }
	      });
	      const error = await promise.catch(err => err);

	      expect(error).toBeInstanceOf(ProviderExecutionError);
	      expect(error).toMatchObject({ statusCode: 502 });
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
