import { jest } from '@jest/globals';
import { createRequire } from 'module';

import VapiRealtimeCompat from '@/plugins/realtime-compat/vapi/index.ts';

type FakeFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
};

function installFetch(mock: (url: string, init: any) => Promise<FakeFetchResponse>) {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = mock;
  return () => {
    (globalThis as any).fetch = original;
  };
}

type CapturedFetchCall = { url: string; init: any };

function installVapiFetchMock(options: {
  websocketCallUrl: string;
  createUrl?: string;
  callId?: string;
  controlUrl?: string;
  onCreateCall?: (options: { url: string; init: any; body: any }) => void;
}) {
  const createUrl = options.createUrl ?? 'https://vapi.test/call';
  const callId = options.callId ?? 'call_1';
  const controlUrl = options.controlUrl ?? 'https://vapi.test/control';
  const fetchCalls: CapturedFetchCall[] = [];
  const controlBodies: any[] = [];

  const restore = installFetch(async (url, init) => {
    fetchCalls.push({ url, init });

    // Create call
    if (url === createUrl && String(init?.method ?? '').toUpperCase() === 'POST') {
      const body = JSON.parse(init.body);
      options.onCreateCall?.({ url, init, body });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ id: callId, transport: { websocketCallUrl: options.websocketCallUrl } })
      };
    }

    // Get call details (poll for monitor.controlUrl)
    if (url === `${createUrl}/${callId}` && String(init?.method ?? 'GET').toUpperCase() === 'GET') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ id: callId, monitor: { controlUrl } })
      };
    }

    // Control calls
    if (url === controlUrl && String(init?.method ?? '').toUpperCase() === 'POST') {
      const body = JSON.parse(init.body);
      controlBodies.push(body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ status: 'ok' })
      };
    }

    throw new Error(`Unexpected fetch: ${String(init?.method ?? 'GET')} ${url}`);
  });

  return { restore, fetchCalls, controlBodies, createUrl, callId, controlUrl };
}

async function waitForEvent<T>(
  iter: AsyncIterator<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) throw new Error('Timed out waiting for event');

    let timer: any;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for event')), remainingMs);
      if (typeof timer?.unref === 'function') timer.unref();
    });

    const next = await Promise.race([iter.next(), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if ((next as any).done) throw new Error('Iterator closed');
    if (predicate((next as any).value)) return (next as any).value;
  }
}

const require = createRequire(import.meta.url);
const wsLib = require('ws');

function createProvider(overrides: any = {}) {
  const base = {
    id: 'vapi',
    compat: 'vapi',
    endpoint: { urlTemplate: 'https://vapi.test/call', headers: { Authorization: 'Bearer vapi_key' } },
    metadata: {
      supportedModelProviders: [
        'openai',
        'google',
        'groq',
        'openrouter',
        'perplexity',
        'together',
        'xai',
        'deepinfra',
        'deepseek',
        'inflection',
        'custom-llm'
      ],
      defaultModelProvider: 'openai',
      defaultModel: 'gpt-4o-mini',
      defaultVoiceProvider: 'openai',
      defaultVoice: 'alloy',
      defaultTranscriberProvider: 'deepgram',
      defaultTranscriberModel: 'nova-2',
      wsHandshakeTimeoutMs: 10000,
      keepalive: { enabled: true, intervalMs: 250 }
    }
  };

  const provider: any = { ...base, ...overrides };

  if (Object.prototype.hasOwnProperty.call(overrides, 'endpoint')) {
    provider.endpoint = overrides.endpoint === undefined ? undefined : { ...base.endpoint, ...(overrides.endpoint ?? {}) };
  } else {
    provider.endpoint = base.endpoint;
  }

  if (Object.prototype.hasOwnProperty.call(overrides, 'metadata')) {
    provider.metadata = overrides.metadata === undefined ? undefined : { ...base.metadata, ...(overrides.metadata ?? {}) };
  } else {
    provider.metadata = base.metadata;
  }

  return provider;
}

function createSpec(overrides: any = {}) {
  return {
    provider: 'vapi',
    model: 'gpt-4o-mini',
    transcription: { enabled: true },
    turnDetection: { mode: 'manual_commit' },
    audio: {
      input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
      output: { format: 'pcm16', sampleRateHz: 24000, channels: 1 }
    },
    ...overrides
  };
}

async function startWsServer() {
  const wss = new wsLib.WebSocketServer({ port: 0 });
  const receivedJson: any[] = [];
  const receivedBinary: Buffer[] = [];
  let connected: any | undefined;
  let closed = false;

  wss.on('connection', (ws: any) => {
    connected = ws;
    ws.on('message', (data: any, isBinary: boolean) => {
      if (isBinary) {
        receivedBinary.push(Buffer.from(data));
        return;
      }
      try {
        receivedJson.push(JSON.parse(Buffer.from(data).toString('utf-8')));
      } catch {
        receivedJson.push({ __raw: String(data) });
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `ws://127.0.0.1:${address.port}/transport`;

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {}
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { url, wss, receivedJson, receivedBinary, getConnected: () => connected, close };
}

describe('plugins/realtime-compat/vapi — ws session', () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    jest.useRealTimers();
    restoreFetch?.();
    restoreFetch = undefined;
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    jest.restoreAllMocks();
  });

  test('createSession: calls POST /call and emits ready first', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ url, init, body }) => {
          expect(url).toBe('https://vapi.test/call');
          expect(init.method).toBe('POST');
          expect(init.headers.Authorization).toBe('Bearer vapi_key');
          expect(init.headers['Content-Type']).toBe('application/json');

          expect(body.transport.provider).toBe('vapi.websocket');
          expect(body.transport.audioFormat.container).toBe('raw');
          expect(body.assistant.firstMessageMode).toBe('assistant-waits-for-user');
          expect(body.assistant.modelOutputInMessagesEnabled).toBe(true);
          expect(Array.isArray(body.assistant.clientMessages)).toBe(true);
          expect(body.assistant.clientMessages.includes('model-output')).toBe(true);
          expect(body.assistant.model.provider).toBe('openai');
          expect(body.assistant.model.model).toBe('gpt-4o-mini');
          expect(body.assistant.model.messages.some((m: any) => m?.role === 'system' && m?.content === 'hello')).toBe(true);
          expect(body.assistant.model.messages.some((m: any) => m?.role === 'system' && m?.content === 'system history')).toBe(true);
          expect(body.assistant.model.messages.some((m: any) => m?.role === 'assistant' && m?.content === 'assistant history')).toBe(true);
          expect(body.assistant.model.messages.some((m: any) => m?.role === 'user' && m?.content === 'from history')).toBe(true);
          expect(body.assistant.model.messages.some((m: any) => m?.content === 'ignored history')).toBe(false);
          expect(body.assistant.transcriber.provider).toBe('deepgram');
          expect(body.assistant.transcriber.model).toBe('nova-2');
          expect(body.assistant.transcriber.language).toBe('en');
          expect(body.assistant.transcriber.smartFormat).toBe(true);
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({
          systemPrompt: 'hello',
          history: [
            { role: 'system', text: 'system history' },
            { role: 'assistant', text: 'assistant history' },
            {} as any,
            { role: 'invalid', text: 'ignored history' } as any,
            { role: 'user' } as any,
            { role: 'user', text: '' },
            { role: 'user', text: 'from history' }
          ]
        }),
        tools: [{ name: 'test.echo', description: 'Echo', parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } } } }]
      });

      const it = session.events()[Symbol.asyncIterator]();
      const first = await waitForEvent(it, (e: any) => Boolean(e));
      expect((first as any).type).toBe('ready');
      expect(String((first as any).sessionId || '')).toBeTruthy();
      await session.close();
      await server.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: supports modelProvider/voiceProvider overrides via spec.settings', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          expect(body.assistant.model.provider).toBe('provider_x');
          expect(body.assistant.model.model).toBe('model_x');
          expect(body.assistant.voice.provider).toBe('provider_y');
          expect(body.assistant.voice.voiceId).toBe('voice_y');
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({ metadata: { supportedModelProviders: ['provider_x'] } }),
        spec: createSpec({
          model: 'model_x',
          settings: { modelProvider: 'provider_x', voiceProvider: 'provider_y', voice: 'voice_y' }
        })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: validates modelProvider against provider metadata whitelist', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      await expect(
        compat.createSession({
          provider: createProvider({ metadata: { supportedModelProviders: ['openai'] } }),
          spec: createSpec({ settings: { modelProvider: 'nope' } })
        })
      ).rejects.toThrow('modelProvider');
    } finally {
      await server.close();
    }
  });

  test('createSession: passes WS handshakeTimeout from provider metadata and spec.settings override', async () => {
    const server = await startWsServer();
    const originalWebSocket = wsLib.WebSocket;
    const captured: any[] = [];

    (wsLib as any).WebSocket = class CapturingWebSocket extends originalWebSocket {
      constructor(...args: any[]) {
        const second = args[1];
        const third = args[2];
        const options =
          second && typeof second === 'object' && !Array.isArray(second) ? second
            : third && typeof third === 'object' && !Array.isArray(third) ? third
              : undefined;
        captured.push(options);
        super(...args);
      }
    };

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const provider = createProvider({ metadata: { wsHandshakeTimeoutMs: 1234 } });

      const session1 = await compat.createSession({ provider, spec: createSpec() });
      const it1 = session1.events()[Symbol.asyncIterator]();
      await waitForEvent(it1, (e: any) => e?.type === 'ready');
      await session1.close();

      const session2 = await compat.createSession({ provider, spec: createSpec({ settings: { wsHandshakeTimeoutMs: 4321 } }) });
      const it2 = session2.events()[Symbol.asyncIterator]();
      await waitForEvent(it2, (e: any) => e?.type === 'ready');
      await session2.close();

      expect(captured[0]?.handshakeTimeout).toBe(1234);
      expect(captured[1]?.handshakeTimeout).toBe(4321);
    } finally {
      (wsLib as any).WebSocket = originalWebSocket;
      await server.close();
    }
  });

  test('createSession: skips modelProvider validation when whitelist missing and falls back for invalid provider metadata', async () => {
    const server = await startWsServer();
    const originalWebSocket = wsLib.WebSocket;
    const captured: any[] = [];

    (wsLib as any).WebSocket = class CapturingWebSocket extends originalWebSocket {
      constructor(...args: any[]) {
        const second = args[1];
        const third = args[2];
        const options =
          second && typeof second === 'object' && !Array.isArray(second) ? second
            : third && typeof third === 'object' && !Array.isArray(third) ? third
              : undefined;
        captured.push(options);
        super(...args);
      }
    };

    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          expect(body.assistant.model.provider).toBe('provider_x');
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({
          metadata: {
            supportedModelProviders: undefined,
            wsHandshakeTimeoutMs: 'nope',
            controlUrl: { pollMs: 'nope', maxWaitMs: 'nope' }
          }
        }),
        spec: createSpec({
          settings: {
            modelProvider: 'provider_x'
          }
        })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();

      expect(captured[0]).toBeUndefined();
    } finally {
      (wsLib as any).WebSocket = originalWebSocket;
      await server.close();
    }
  });

  test('createSession: filters invalid supportedModelProviders metadata entries during validation', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({
          metadata: {
            supportedModelProviders: ['openai', undefined, '   ']
          }
        }),
        spec: createSpec({ settings: { modelProvider: 'openai' } })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: supports transcriber provider/model overrides via spec.transcription', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          expect(body.assistant.transcriber.provider).toBe('transcriber_x');
          expect(body.assistant.transcriber.model).toBe('transcriber_model_x');
          expect(body.assistant.transcriber.language).toBe('fr');
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({
          transcription: { enabled: true, provider: 'transcriber_x', model: 'transcriber_model_x', language: 'fr' }
        })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: defaults model from provider metadata, defaults voice to alloy, and coerces missing tool description', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          expect(body.assistant.model.model).toBe('gpt-4o-mini');
          expect(body.assistant.voice.voiceId).toBe('alloy');
          expect(body.assistant.model.tools[0].function.description).toBe('');
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({ metadata: { defaultVoice: undefined } }),
        spec: createSpec({ model: undefined }),
        tools: [{ name: 't1', parametersJsonSchema: { type: 'object' } }]
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: falls back to built-in defaults when provider metadata values are missing', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          expect(body.assistant.model.provider).toBe('openai');
          expect(body.assistant.voice.provider).toBe('openai');
          expect(body.assistant.voice.voiceId).toBe('alloy');
          expect(body.assistant.transcriber.provider).toBe('deepgram');
          expect(body.assistant.transcriber.model).toBe('nova-2');
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({
          metadata: {
            defaultModelProvider: undefined,
            defaultVoiceProvider: undefined,
            defaultVoice: undefined,
            defaultTranscriberProvider: undefined,
            defaultTranscriberModel: undefined,
            wsHandshakeTimeoutMs: undefined,
            keepalive: undefined
          }
        }),
        spec: createSpec({ model: 'gpt-4o-mini', transcription: { enabled: true }, settings: {} })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: trims provider metadata values and falls back when empty', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          expect(body.assistant.model.provider).toBe('openai');
          expect(body.assistant.voice.provider).toBe('openai');
          expect(body.assistant.voice.voiceId).toBe('alloy');
          expect(body.assistant.transcriber.provider).toBe('deepgram');
          expect(body.assistant.transcriber.model).toBe('nova-2');
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({
          metadata: {
            defaultModelProvider: '   ',
            defaultVoiceProvider: '   ',
            defaultVoice: '   ',
            defaultTranscriberProvider: '   ',
            defaultTranscriberModel: '   '
          }
        }),
        spec: createSpec({ model: 'gpt-4o-mini', transcription: { enabled: true } })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('maps transcript + speech-update messages to normalized events', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec()
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(JSON.stringify({ type: 'speech-update', role: 'user', status: 'started' }));
      ws.send(JSON.stringify({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'hello world' }));
      ws.send(JSON.stringify({ type: 'speech-update', role: 'user', status: 'stopped' }));
      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'ok' }));
      ws.send(JSON.stringify({ type: 'speech-update', role: 'assistant', status: 'stopped' }));

      await waitForEvent(it, (e: any) => e?.type === 'user_speech.started');
      const userFinal = await waitForEvent(it, (e: any) => e?.type === 'user_transcript.final');
      expect((userFinal as any).text).toBe('hello world');
      await waitForEvent(it, (e: any) => e?.type === 'user_speech.stopped');
      const assistantFinal = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final');
      expect((assistantFinal as any).text).toBe('ok');
      await waitForEvent(it, (e: any) => e?.type === 'assistant_audio.end');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('maps transcript deltas (partial) and ignores unknown roles', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(JSON.stringify({ type: 'transcript', role: 'system', transcriptType: 'partial', transcript: 'ignore' }));

      ws.send(JSON.stringify({ type: 'transcript', role: 'user', transcript: 'x' }));
      const d0 = await waitForEvent(it, (e: any) => e?.type === 'user_transcript.delta');
      expect((d0 as any).textDelta).toBe('x');

      ws.send(JSON.stringify({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'hel' }));
      const d1 = await waitForEvent(it, (e: any) => e?.type === 'user_transcript.delta');
      expect((d1 as any).textDelta).toBe('hel');

      ws.send(JSON.stringify({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'hello' }));
      const d2 = await waitForEvent(it, (e: any) => e?.type === 'user_transcript.delta');
      expect((d2 as any).textDelta).toBe('lo');

      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'partial', transcript: 'o' }));
      const a1 = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.delta');
      expect((a1 as any).textDelta).toBe('o');

      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'partial', transcript: 'ok' }));
      const a2 = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.delta');
      expect((a2 as any).textDelta).toBe('k');

      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'partial', transcript: 'hello' }));
      const a3 = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.delta');
      expect((a3 as any).textDelta).toBe('hello');

      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'partial', transcript: 'world' }));
      const a4 = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.delta');
      expect((a4 as any).textDelta).toBe('world');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('finalizes assistant transcript on speech-stop when no transcriptType=final is received', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      // Omit transcriptType so it's treated as partial.
      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcript: 'hello' }));
      const delta = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.delta');
      expect((delta as any).textDelta).toBe('hello');

      ws.send(JSON.stringify({ type: 'speech-update', role: 'assistant', status: 'stopped' }));
      const final = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final');
      expect((final as any).text).toBe('hello');
      await waitForEvent(it, (e: any) => e?.type === 'assistant_audio.end');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('maps provider audio to configured output format (resampled when needed)', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      // Pass-through: provider sample rate matches configured output sample rate.
      const session1 = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it1 = session1.events()[Symbol.asyncIterator]();
      await waitForEvent(it1, (e: any) => e?.type === 'ready');
      const ws1 = server.getConnected();
      expect(ws1).toBeTruthy();

      const inBytes = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]); // 4 samples
      ws1.send(inBytes);
      const evt1 = await waitForEvent(it1, (e: any) => e?.type === 'assistant_audio.chunk');
      expect((evt1 as any).frame.sampleRateHz).toBe(24000);
      const decoded1 = Buffer.from((evt1 as any).frame.dataBase64, 'base64');
      expect(decoded1.byteLength).toBe(inBytes.byteLength);
      await session1.close();

      // Resample: provider sample rate differs from configured output sample rate.
      const session2 = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({
          audio: {
            input: { format: 'pcm16', sampleRateHz: 24000, channels: 1 },
            output: { format: 'pcm16', sampleRateHz: 48000, channels: 1 }
          }
        })
      });
      const it2 = session2.events()[Symbol.asyncIterator]();
      await waitForEvent(it2, (e: any) => e?.type === 'ready');
      const ws2 = server.getConnected();
      expect(ws2).toBeTruthy();

      ws2.send(inBytes);
      const evt2 = await waitForEvent(it2, (e: any) => e?.type === 'assistant_audio.chunk');
      expect((evt2 as any).frame.sampleRateHz).toBe(48000);
      const decoded2 = Buffer.from((evt2 as any).frame.dataBase64, 'base64');
      expect(decoded2.byteLength).toBeGreaterThan(inBytes.byteLength);

      ws2.send(Buffer.from([0, 1, 2]), { binary: true }); // odd bytes should fail decode when resampling
      const decodeErr = await waitForEvent(it2, (e: any) => e?.type === 'error' && (e as any).code === 'audio_decode_failed');
      expect((decodeErr as any).code).toBe('audio_decode_failed');

      await session2.close();
    } finally {
      await server.close();
    }
  });

  test('normalizes transcriptType from raw type string when transcriptType is missing', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(JSON.stringify({ type: 'transcript transcriptType=\"final\"', role: 'user', transcript: 'done' }));
      const userFinal = await waitForEvent(it, (e: any) => e?.type === 'user_transcript.final');
      expect((userFinal as any).text).toBe('done');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('buffers sendText until commit and injects tool results via add-message', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec()
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.commit();
      expect(fetchMock.controlBodies.length).toBe(0);

      await session.sendText({ text: 'a', role: 'user' });
      await session.sendText({ text: 'b', role: 'user' });
      expect(fetchMock.controlBodies.length).toBe(0);

      await session.commit();

      const addMessages = fetchMock.controlBodies.filter(m => m?.type === 'add-message');
      expect(addMessages.length).toBe(2);
      expect(addMessages[0]?.triggerResponseEnabled).toBe(false);
      expect(addMessages[1]?.triggerResponseEnabled).toBe(true);

      await session.sendToolResult({ toolCallId: 'tc1', result: { result: '[R:1]x' } });

      const toolInserts = fetchMock.controlBodies.filter(m => m?.type === 'add-message' && m?.message?.role === 'tool');
      expect(toolInserts.length).toBeGreaterThan(0);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: resolves session audio when audio is missing or partially specified', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;

      const sess1 = await compat.createSession({ provider: createProvider(), spec: createSpec({ audio: undefined }) });
      const it1 = sess1.events()[Symbol.asyncIterator]();
      const ready1 = await waitForEvent(it1, (e: any) => e?.type === 'ready');
      expect((ready1 as any).audio.input.sampleRateHz).toBe(24000);
      expect((ready1 as any).audio.output.sampleRateHz).toBe(24000);
      await sess1.close();

      const sess2 = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ audio: { output: { format: 'pcm16', sampleRateHz: 16000, channels: 1 } } })
      });
      const it2 = sess2.events()[Symbol.asyncIterator]();
      const ready2 = await waitForEvent(it2, (e: any) => e?.type === 'ready');
      expect((ready2 as any).audio.input.sampleRateHz).toBe(16000);
      expect((ready2 as any).audio.output.sampleRateHz).toBe(16000);
      await sess2.close();

      const sess3 = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ audio: { input: { format: 'pcm16', sampleRateHz: 16000, channels: 1 } } })
      });
      const it3 = sess3.events()[Symbol.asyncIterator]();
      const ready3 = await waitForEvent(it3, (e: any) => e?.type === 'ready');
      expect((ready3 as any).audio.input.sampleRateHz).toBe(16000);
      expect((ready3 as any).audio.output.sampleRateHz).toBe(16000);
      await sess3.close();
    } finally {
      await server.close();
    }
  });

  test('supports system sendText role and normalizes non-system roles to user', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendText({ text: 'sys', role: 'system' });
      await session.sendText({ text: 'asst', role: 'assistant' });
      await session.commit();

      const add = fetchMock.controlBodies.filter(m => m?.type === 'add-message');
      expect(add.length).toBe(2);
      expect(add[0]?.message?.role).toBe('system');
      expect(add[1]?.message?.role).toBe('user');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('injectContext: maps roles and skips empty text', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.injectContext([
        { role: 'system', text: 's' } as any,
        { role: 'assistant', text: 'a' } as any,
        { role: 'user', text: 'u' } as any,
        { role: 'unknown', text: 'x' } as any,
        { role: 'user', text: '' } as any
      ]);

      const add = fetchMock.controlBodies.filter(m => m?.type === 'add-message');
      const roles = add.map(m => m?.message?.role);
      expect(roles).toEqual(['system', 'assistant', 'user', 'user']);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('covers misc fallback branches for provider messages and client helpers', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      // parsed.type fallback
      ws.send(JSON.stringify({}));

      // handleSpeechUpdate: status is not a string => early return
      ws.send(JSON.stringify({ type: 'speech-update', role: 'user', status: 123 }));

      // handleTranscript: transcript is nullish => early return
      ws.send(JSON.stringify({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: null }));

      // normalizeRole: role is not a string => ignored
      ws.send(JSON.stringify({ type: 'transcript', role: 123, transcriptType: 'partial', transcript: 'x' }));

      // handleToolCalls: toolCallList is not an array => no tool events
      ws.send(JSON.stringify({ type: 'tool-calls', toolCallList: {} }));

      // Tool name fallback when no mapping exists.
      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [{ id: 'tc_unknown', function: { name: 'unknown_tool', arguments: '{}' } }]
        })
      );
      const tcStart = await waitForEvent(it, (e: any) => e?.type === 'tool_call.start');
      expect((tcStart as any).name).toBe('unknown_tool');

      // sendText: default role + nullish text
      await session.sendText({ text: undefined } as any);
      await session.commit();

      // injectContext: nullish items, missing role, and missing text
      await session.injectContext(undefined as any);
      await session.injectContext([{ text: 'ctx' } as any, { role: 'system' } as any]);

      const adds = fetchMock.controlBodies.filter(m => m?.type === 'add-message');
      expect(adds.some(m => m?.message?.content === '')).toBe(true);
      expect(adds.some(m => m?.message?.role === 'user' && m?.message?.content === 'ctx')).toBe(true);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: toolChoice single selects named tool (or disables tools when missing)', async () => {
    const server = await startWsServer();
    let callCount = 0;
    try {
      const createUrl = 'https://vapi.test/call';
      const controlUrl = 'https://vapi.test/control';
      const knownCallIds: string[] = [];

      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();

        if (url === createUrl && method === 'POST') {
          callCount++;
          const body = JSON.parse(init.body);
          if (callCount === 1) {
            expect(body.assistant.voice.voiceId).toBe('alloy');
            expect(body.assistant.model.tools.length).toBe(1);
            expect(body.assistant.model.tools[0].function.name).toBe('one');
          } else {
            expect(body.assistant.model.tools).toBeUndefined();
          }
          const callId = `call_${callCount}`;
          knownCallIds.push(callId);
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: callId, transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && knownCallIds.some(id => url === `${createUrl}/${id}`)) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: url.split('/').pop(), monitor: { controlUrl } })
          };
        }

        if (url === controlUrl && method === 'POST') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ status: 'ok' })
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;

      const sess1 = await compat.createSession({
        provider: createProvider({ metadata: { defaultVoice: '' } }),
        spec: createSpec({ settings: { voice: '   ' }, toolChoice: { type: 'single', name: 'one' } }),
        tools: [
          { name: 'one', description: '1', parametersJsonSchema: { type: 'object' } },
          { name: 'two', description: '2', parametersJsonSchema: { type: 'object' } }
        ]
      });
      const it1 = sess1.events()[Symbol.asyncIterator]();
      await waitForEvent(it1, (e: any) => e?.type === 'ready');
      await sess1.close();

      const sess2 = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: { type: 'single', name: 'missing' } }),
        tools: [{ name: 'one', description: '1', parametersJsonSchema: { type: 'object' } }]
      });
      const it2 = sess2.events()[Symbol.asyncIterator]();
      await waitForEvent(it2, (e: any) => e?.type === 'ready');
      await sess2.close();
    } finally {
      await server.close();
    }
  });

  test('sendAudio: resamples to provider sampleRate and supports passthrough when already matching', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const bytes24k = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]); // 4 samples
      await session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 24000,
        channels: 1,
        dataBase64: bytes24k.toString('base64')
      });
      await new Promise(res => setTimeout(res, 50));
      expect(server.receivedBinary.length).toBeGreaterThanOrEqual(2);
      expect(server.receivedBinary[server.receivedBinary.length - 1].byteLength).toBe(bytes24k.byteLength);

      const bytes48k = Buffer.alloc(1920, 0);
      await session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 48000,
        channels: 1,
        dataBase64: bytes48k.toString('base64')
      });
      await new Promise(res => setTimeout(res, 50));
      expect(server.receivedBinary.length).toBeGreaterThanOrEqual(3);
      expect(server.receivedBinary[server.receivedBinary.length - 1].byteLength).toBeLessThan(bytes48k.byteLength);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('sendAudio: validates audio format + channels', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await expect(
        session.sendAudio({ format: 'mp3', sampleRateHz: 24000, channels: 1, dataBase64: '' } as any)
      ).rejects.toThrow('sendAudio requires format=pcm16');
      await expect(
        session.sendAudio({ format: 'pcm16', sampleRateHz: 24000, channels: 2, dataBase64: '' } as any)
      ).rejects.toThrow('sendAudio requires channels=1');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('maps binary audio messages to assistant_audio.chunk and errors on odd byte lengths', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ audio: { input: { format: 'pcm16', sampleRateHz: 16000, channels: 1 }, output: { format: 'pcm16', sampleRateHz: 16000, channels: 1 } } })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();
      for (let i = 0; i < 50 && ws.readyState !== wsLib.WebSocket.OPEN; i++) {
        await new Promise(res => setTimeout(res, 5));
      }
      expect(ws.readyState).toBe(wsLib.WebSocket.OPEN);

      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'ok' }));
      await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final').catch((err: any) => {
        throw new Error(`expected assistant transcript final: ${err?.message ?? String(err)}`);
      });

      // Silent frames are ignored unless the assistant is speaking.
      const silentIgnored = Buffer.alloc(8, 0);
      ws.send(silentIgnored, { binary: true });

      const even = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
      ws.send(even, { binary: true });
      const audioOrError = await waitForEvent(it, (e: any) => e?.type === 'assistant_audio.chunk' || e?.type === 'error').catch(
        (err: any) => {
          throw new Error(`expected audio chunk or error: ${err?.message ?? String(err)}`);
        }
      );
      expect((audioOrError as any).type).toBe('assistant_audio.chunk');
      const audioEvt = audioOrError as any;
      expect((audioEvt as any).frame.sampleRateHz).toBe(16000);
      const decoded = Buffer.from((audioEvt as any).frame.dataBase64, 'base64');
      expect(decoded.equals(even)).toBe(true);

      // Cover assistant speech-update started (enables emitting silent audio frames).
      ws.send(JSON.stringify({ type: 'speech-update', role: 'assistant', status: 'started' }));
      const silent = Buffer.alloc(8, 0);
      ws.send(silent, { binary: true });
      const silenceEvt = await waitForEvent(it, (e: any) => e?.type === 'assistant_audio.chunk' || e?.type === 'error');
      expect((silenceEvt as any).type).toBe('assistant_audio.chunk');
      expect(Buffer.from((silenceEvt as any).frame.dataBase64, 'base64').equals(silent)).toBe(true);

      const odd = Buffer.from([0, 1, 2]);
      ws.send(odd, { binary: true }); // odd bytes are still forwarded when no resampling is needed
      const oddOrError = await waitForEvent(it, (e: any) => e?.type === 'assistant_audio.chunk' || e?.type === 'error').catch(
        (err: any) => {
          throw new Error(`expected audio chunk or error: ${err?.message ?? String(err)}`);
        }
      );
      expect((oddOrError as any).type).toBe('assistant_audio.chunk');
      const oddDecoded = Buffer.from((oddOrError as any).frame.dataBase64, 'base64');
      expect(oddDecoded.equals(odd)).toBe(true);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('maps tool-calls and validates tool arguments', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          const toolsForModel = body?.assistant?.model?.tools ?? [];
          const names = toolsForModel.map((t: any) => t?.function?.name);
          expect(names).toEqual(['a_b', 'a_b_2']);
        }
      });
      restoreFetch = fetchMock.restore;

      const tools = [
        { name: 'a.b', description: 'A', parametersJsonSchema: [] },
        { name: 'a_b', description: 'B', parametersJsonSchema: { type: 'object' } },
        { name: 'other', description: 'O', parametersJsonSchema: { type: 'object', properties: { x: { type: 'number' } } } }
      ];

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: { type: 'required', allowed: ['a.b', 'a_b'] } }),
        tools
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [
            {},
            { id: 'tc_good', function: { name: 'a_b_2', arguments: { k: 'v' } } },
            { id: 'tc_empty', function: { name: 'a_b', arguments: '' } },
            { id: 'tc_bad', function: { name: 'a_b', arguments: '[]' } },
            { id: 'tc_parse', function: { name: 'a_b', arguments: '{"x":1}' } },
            { id: 'tc_type', function: { name: 'a_b', arguments: 5 } }
          ]
        })
      );

      const start1 = await waitForEvent(it, (e: any) => e?.type === 'tool_call.start' && (e as any).toolCallId === 'tc_good');
      expect((start1 as any).name).toBe('a_b');
      const end1 = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_good');
      expect((end1 as any).arguments).toEqual({ k: 'v' });

      const endEmpty = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_empty');
      expect((endEmpty as any).arguments).toEqual({});

      const invalid1 = await waitForEvent(
        it,
        (e: any) => e?.type === 'error' && (e as any).code === 'invalid_tool_arguments'
      );
      expect((invalid1 as any).code).toBe('invalid_tool_arguments');

      const endParse = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_parse');
      expect((endParse as any).arguments).toEqual({ x: 1 });

      const invalid2 = await waitForEvent(
        it,
        (e: any) => e?.type === 'error' && (e as any).code === 'invalid_tool_arguments'
      );
      expect((invalid2 as any).code).toBe('invalid_tool_arguments');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('conversation-update: emits assistant_text.final + assistant_transcript.final from conversation snapshot', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(
        JSON.stringify({
          type: 'conversation-update',
          conversation: [
            { role: 'system', content: 's' },
            { role: 'user', content: 'ECHO:ABC' },
            { role: 'assistant', content: 'Done.' }
          ]
        })
      );

      const textFinal = await waitForEvent(it, (e: any) => e?.type === 'assistant_text.final');
      expect((textFinal as any).text).toBe('Done.');

      const transcriptFinal = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final');
      expect((transcriptFinal as any).text).toBe('Done.');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('model-output: maps output text to assistant_text.delta', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(JSON.stringify({ type: 'model-output', output: 'x' }));
      const delta = await waitForEvent(it, (e: any) => e?.type === 'assistant_text.delta');
      expect((delta as any).textDelta).toBe('x');

      ws.send(JSON.stringify({ type: 'model-output', output: 1, textDelta: 'y' }));
      const delta2 = await waitForEvent(it, (e: any) => e?.type === 'assistant_text.delta' && (e as any).textDelta === 'y');
      expect((delta2 as any).textDelta).toBe('y');

      ws.send(JSON.stringify({ type: 'model-output', output: 1, textDelta: 2, text: 'z' }));
      const delta3 = await waitForEvent(it, (e: any) => e?.type === 'assistant_text.delta' && (e as any).textDelta === 'z');
      expect((delta3 as any).textDelta).toBe('z');

      // Covers falsy output branch (no assistant_text.delta event expected).
      ws.send(JSON.stringify({ type: 'model-output', output: 1, textDelta: 2, text: 3 }));
      ws.send(JSON.stringify({ type: 'model-output', output: 'after' }));
      const delta4 = await waitForEvent(
        it,
        (e: any) => e?.type === 'assistant_text.delta' && (e as any).textDelta === 'after'
      );
      expect((delta4 as any).textDelta).toBe('after');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: tolerates toolChoice=single without a name (omits tools)', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          expect(body.assistant.model.tools).toBeUndefined();
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: { type: 'single' } }),
        tools: [
          {
            name: 'test.echo',
            description: 'Echo',
            parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
          }
        ]
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('finalizes assistant text/transcript on speech-stop using accumulated model-output text when transcripts are absent', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(JSON.stringify({ type: 'model-output', output: 'hel' }));
      await waitForEvent(it, (e: any) => e?.type === 'assistant_text.delta' && (e as any).textDelta === 'hel');
      ws.send(JSON.stringify({ type: 'model-output', output: 'lo' }));
      await waitForEvent(it, (e: any) => e?.type === 'assistant_text.delta' && (e as any).textDelta === 'lo');

      ws.send(
        JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'IGNORED' })
      );

      ws.send(JSON.stringify({ type: 'speech-update', role: 'assistant', status: 'stopped' }));

      const final = await waitForEvent(it, (e: any) => e?.type === 'assistant_text.final');
      expect((final as any).text).toBe('hello');
      const transcriptFinal = await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final');
      expect((transcriptFinal as any).text).toBe('hello');
      await waitForEvent(it, (e: any) => e?.type === 'assistant_audio.end');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('sendAudio: covers pacing delay and closed branches', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const audio50ms24k = Buffer.alloc(2400, 0);
      await session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 24000,
        channels: 1,
        dataBase64: audio50ms24k.toString('base64')
      });

      const tiny = Buffer.alloc(4, 0);
      const delayedSend = session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 24000,
        channels: 1,
        dataBase64: tiny.toString('base64')
      });

      await new Promise(res => setTimeout(res, 5));
      await session.close();
      await delayedSend;

      await session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 24000,
        channels: 1,
        dataBase64: tiny.toString('base64')
      });
    } finally {
      await server.close();
    }
  });

  test('sendAudio: swallows ws.send failures inside pacing chain', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      jest.spyOn(wsLib.WebSocket.prototype, 'send').mockImplementationOnce(() => {
        throw new Error('boom');
      });

      const tiny = Buffer.alloc(4, 0);
      await session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 24000,
        channels: 1,
        dataBase64: tiny.toString('base64')
      });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('tool args fallback: fills missing message from last ECHO:<token> user message when tool schema supports message', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: { type: 'single', name: 'test.echo' } }),
        tools: [
          {
            name: 'test.echo',
            description: 'Echo',
            parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
          }
        ]
      });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendText({ text: 'ECHO:XYZ', role: 'user' });
      await session.commit();

      const ws = server.getConnected();
      expect(ws).toBeTruthy();
      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [{ id: 'tc_echo', function: { name: 'test_echo', arguments: { message: '' } } }]
        })
      );

      const end = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_echo');
      expect((end as any).name).toBe('test.echo');
      expect((end as any).arguments).toEqual({ message: 'XYZ' });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('tool args fallback: coerces non-string message to last ECHO:<token> value when tool schema supports message', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: { type: 'single', name: 'test.echo' } }),
        tools: [
          {
            name: 'test.echo',
            description: 'Echo',
            parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
          }
        ]
      });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendText({ text: 'ECHO:XYZ', role: 'user' });
      await session.commit();

      const ws = server.getConnected();
      expect(ws).toBeTruthy();
      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [{ id: 'tc_echo', function: { name: 'test_echo', arguments: { message: 123 } } }]
        })
      );

      const end = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_echo');
      expect((end as any).name).toBe('test.echo');
      expect((end as any).arguments).toEqual({ message: 'XYZ' });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('tool args fallback: replaces echo placeholder when toolChoice is not forced', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: undefined }),
        tools: [
          {
            name: 'test.echo',
            description: 'Echo',
            parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
          }
        ]
      });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendText({ text: 'ECHO:XYZ', role: 'user' });
      await session.commit();

      const ws = server.getConnected();
      expect(ws).toBeTruthy();
      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [{ id: 'tc_echo', function: { name: 'test_echo', arguments: { message: 'echo' } } }]
        })
      );

      const end = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_echo');
      expect((end as any).name).toBe('test.echo');
      expect((end as any).arguments).toEqual({ message: 'XYZ' });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('conversation-update: covers empty/non-array/no-assistant and duplicate suppression branches', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(JSON.stringify({ type: 'conversation-update', conversation: null }));
      ws.send(JSON.stringify({ type: 'conversation-update', conversation: [] }));
      ws.send(JSON.stringify({ type: 'conversation-update', conversation: [{ role: 'user', content: 'ECHO:ZZZ' }] }));

      ws.send(JSON.stringify({ type: 'conversation-update', conversation: [{ role: 'assistant', content: 'One' }] }));
      const first = await waitForEvent(it, (e: any) => e?.type === 'assistant_text.final' && (e as any).text === 'One');
      expect((first as any).text).toBe('One');
      await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final' && (e as any).text === 'One');

      // Duplicate assistant snapshot should not emit new finals.
      ws.send(JSON.stringify({ type: 'conversation-update', conversation: [{ role: 'assistant', content: 'One' }] }));
      ws.send(JSON.stringify({ type: 'conversation-update', conversation: [{ role: 'assistant', content: 'Two' }] }));
      const second = await waitForEvent(it, (e: any) => e?.type === 'assistant_text.final' && (e as any).text === 'Two');
      expect((second as any).text).toBe('Two');
      await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final' && (e as any).text === 'Two');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('tool args fallback: no-ops when token is missing or message is already set', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: { type: 'single', name: 'test.echo' } }),
        tools: [
          {
            name: 'test.echo',
            description: 'Echo',
            parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
          }
        ]
      });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendText({ text: 'hello', role: 'user' });
      await session.commit();

      const ws = server.getConnected();
      expect(ws).toBeTruthy();

      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [{ id: 'tc_echo', function: { name: 'test_echo', arguments: { message: '' } } }]
        })
      );
      const end1 = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_echo');
      expect((end1 as any).name).toBe('test.echo');
      expect((end1 as any).arguments).toEqual({ message: '' });

      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [{ id: 'tc_echo2', function: { name: 'test_echo', arguments: { message: 'OK' } } }]
        })
      );
      const end2 = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_echo2');
      expect((end2 as any).name).toBe('test.echo');
      expect((end2 as any).arguments).toEqual({ message: 'OK' });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('tool args fallback: does not override non-empty provider arguments even when token is present', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ toolChoice: { type: 'single', name: 'test.echo' } }),
        tools: [
          {
            name: 'test.echo',
            description: 'Echo',
            parametersJsonSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
          }
        ]
      });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendText({ text: 'ECHO:XYZ', role: 'user' });
      await session.commit();

      const ws = server.getConnected();
      expect(ws).toBeTruthy();
      ws.send(
        JSON.stringify({
          type: 'tool-calls',
          toolCallList: [{ id: 'tc_echo', function: { name: 'test_echo', arguments: { message: 'NOT_XYZ' } } }]
        })
      );

      const end = await waitForEvent(it, (e: any) => e?.type === 'tool_call.end' && (e as any).toolCallId === 'tc_echo');
      expect((end as any).name).toBe('test.echo');
      expect((end as any).arguments).toEqual({ message: 'NOT_XYZ' });

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('sendToolResult: uses safe text extraction for strings, {result:string}, json, and circular values', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendToolResult({ toolCallId: 'tc_s', result: 'x' });
      await session.sendToolResult({ toolCallId: 'tc_r', result: { result: 'y' } as any });
      await session.sendToolResult({ toolCallId: 'tc_j', result: { foo: 1 } as any });
      const circular: any = {};
      circular.self = circular;
      await session.sendToolResult({ toolCallId: 'tc_c', result: circular });

      const toolMsgs = fetchMock.controlBodies.filter(m => m?.type === 'add-message' && m?.message?.role === 'tool');
      const contents = toolMsgs.map(m => m?.message?.content);
      expect(contents).toContain('x');
      expect(contents).toContain('y');
      expect(contents).toContain('{"foo":1}');
      expect(contents).toContain('[object Object]');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('sendToolResult: supports configurable toolFallbackDelayMs via spec.settings', async () => {
    const server = await startWsServer();
    const originalSetTimeout = globalThis.setTimeout;
    const delayMs = 1234;
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (Number(ms) === delayMs) {
        return (originalSetTimeout as any)(fn, 0, ...args);
      }
      return (originalSetTimeout as any)(fn, ms, ...args);
    }) as any);

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ settings: { toolFallbackDelayMs: delayMs } })
      });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendToolResult({ toolCallId: 'tc1', result: 'fallback' });
      await new Promise(res => (originalSetTimeout as any)(res, 25));

      const says = fetchMock.controlBodies.filter(m => m?.type === 'say');
      expect(says.length).toBeGreaterThan(0);
      expect(says[says.length - 1]?.content).toBe('fallback');
      expect(setTimeoutSpy.mock.calls.some(([, ms]) => Number(ms) === delayMs)).toBe(true);

      await session.close();
    } finally {
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('sendToolResult: triggers say fallback when no assistant activity observed', async () => {
    const server = await startWsServer();
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (Number(ms) === 5000) return (originalSetTimeout as any)(fn, 0, ...args);
      return (originalSetTimeout as any)(fn, ms, ...args);
    }) as any);

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendToolResult({ toolCallId: 'tc1', result: 'fallback' });
      await new Promise(res => setTimeout(res, 50));

      const says = fetchMock.controlBodies.filter(m => m?.type === 'say');
      expect(says.length).toBeGreaterThan(0);
      expect(says[says.length - 1]?.content).toBe('fallback');

      await session.close();
    } finally {
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('sendToolResult: say fallback swallows control failures', async () => {
    const server = await startWsServer();
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (Number(ms) === 5000) return (originalSetTimeout as any)(fn, 0, ...args);
      return (originalSetTimeout as any)(fn, ms, ...args);
    }) as any);

    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', monitor: { controlUrl: 'https://vapi.test/control' } })
          };
        }

        if (method === 'POST' && url === 'https://vapi.test/control') {
          const body = JSON.parse(init.body);
          if (body?.type === 'say') {
            return {
              ok: false,
              status: 500,
              statusText: 'Boom',
              text: async () => 'nope'
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ status: 'ok' })
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendToolResult({ toolCallId: 'tc1', result: 'fallback' });
      await new Promise(res => (originalSetTimeout as any)(res, 25));

      await session.close();
    } finally {
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('sendToolResult: callback noops once fallback is cleared, and does not require timer.unref', async () => {
    const server = await startWsServer();
    const originalSetTimeout = globalThis.setTimeout;
    const callbacks: Array<() => void> = [];

    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      const timer: any = (originalSetTimeout as any)(fn, ms, ...args);
      if (Number(ms) === 5000) {
        callbacks.push(fn);
        timer.unref = undefined;
      }
      return timer;
    }) as any);

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.sendToolResult({ toolCallId: 'tc1', result: 'x' });
      const ws = server.getConnected();
      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'ok' }));
      await waitForEvent(it, (e: any) => e?.type === 'assistant_transcript.final');

      // Invoke the captured timer callback manually after the fallback was cleared.
      callbacks[callbacks.length - 1]?.();
      await new Promise(res => setTimeout(res, 25));

      const says = fetchMock.controlBodies.filter(m => m?.type === 'say');
      expect(says.length).toBe(0);

      await session.close();
    } finally {
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('keepalive: streams silence and respects guard conditions', async () => {
    const server = await startWsServer();
    const originalWebSocket = wsLib.WebSocket;
    let clientWs: any | undefined;

    (wsLib as any).WebSocket = class CapturingWebSocket extends originalWebSocket {
      constructor(...args: any[]) {
        super(...args);
        clientWs = this;
      }
    };

    const intervalCallbacks: Array<() => void> = [];
    const originalSetInterval = globalThis.setInterval;
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (Number(ms) === 250) {
        intervalCallbacks.push(() => fn(...args));
        return { unref: () => {} } as any;
      }
      return (originalSetInterval as any)(fn, ms, ...args);
    }) as any);

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const keepaliveCb = intervalCallbacks[intervalCallbacks.length - 1];
      expect(typeof keepaliveCb).toBe('function');
      expect(clientWs).toBeTruthy();

      // Wait for initial burst to arrive before asserting incremental frames.
      await new Promise(res => setTimeout(res, 25));

      const baselineBinaryCount = server.receivedBinary.length;
      keepaliveCb?.();
      await new Promise(res => setTimeout(res, 25));
      expect(server.receivedBinary.length).toBeGreaterThan(baselineBinaryCount);

      // When real audio was sent recently, keepalive should no-op.
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      await session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 16000,
        channels: 1,
        dataBase64: Buffer.alloc(2, 0).toString('base64')
      } as any);
      await new Promise(res => setTimeout(res, 25));
      const afterAudioCount = server.receivedBinary.length;

      nowSpy.mockReturnValueOnce(1100);
      keepaliveCb?.();
      await new Promise(res => setTimeout(res, 25));
      expect(server.receivedBinary.length).toBe(afterAudioCount);

      // If ws isn't open, keepalive should no-op (covers ws.readyState guard).
      const priorReadyState = (clientWs as any).readyState;
      try {
        (clientWs as any).readyState = 0;
      } catch {
        try {
          Object.defineProperty(clientWs, 'readyState', { value: 0, writable: true });
        } catch {}
      }
      keepaliveCb?.();
      await new Promise(res => setTimeout(res, 25));
      expect(server.receivedBinary.length).toBe(afterAudioCount);
      try {
        (clientWs as any).readyState = priorReadyState;
      } catch {}

      // After close, keepalive should no-op (covers closed guard).
      await session.close();
      keepaliveCb?.();
    } finally {
      setIntervalSpy.mockRestore();
      (wsLib as any).WebSocket = originalWebSocket;
      await server.close();
    }
  });

  test('keepalive: can be disabled via spec.settings', async () => {
    const server = await startWsServer();
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ settings: { keepaliveEnabled: false } })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await new Promise(res => setTimeout(res, 25));
      expect(server.receivedBinary.length).toBe(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();

      await session.close();
    } finally {
      setIntervalSpy.mockRestore();
      await server.close();
    }
  });

  test('keepalive: can be disabled via provider metadata', async () => {
    const server = await startWsServer();
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({ metadata: { keepalive: { enabled: false, intervalMs: 250 } } }),
        spec: createSpec()
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await new Promise(res => setTimeout(res, 25));
      expect(server.receivedBinary.length).toBe(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();

      await session.close();
    } finally {
      setIntervalSpy.mockRestore();
      await server.close();
    }
  });

  test('keepalive: falls back to default interval when provider metadata is not numeric', async () => {
    const server = await startWsServer();
    const intervalCallbacks: Array<() => void> = [];
    const originalSetInterval = globalThis.setInterval;
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (Number(ms) === 250) {
        intervalCallbacks.push(() => fn(...args));
        return { unref: () => {} } as any;
      }
      return (originalSetInterval as any)(fn, ms, ...args);
    }) as any);

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({ metadata: { keepalive: { enabled: true, intervalMs: 'nope' } } }),
        spec: createSpec()
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const keepaliveCb = intervalCallbacks[intervalCallbacks.length - 1];
      expect(typeof keepaliveCb).toBe('function');

      await new Promise(res => setTimeout(res, 25));
      const baselineBinaryCount = server.receivedBinary.length;
      keepaliveCb?.();
      await new Promise(res => setTimeout(res, 25));
      expect(server.receivedBinary.length).toBeGreaterThan(baselineBinaryCount);

      await session.close();
    } finally {
      setIntervalSpy.mockRestore();
      await server.close();
    }
  });

  test('keepalive: supports interval override via spec.settings', async () => {
    const server = await startWsServer();
    const intervalCallbacks: Array<() => void> = [];
    const originalSetInterval = globalThis.setInterval;
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      if (Number(ms) === 500) {
        intervalCallbacks.push(() => fn(...args));
        return { unref: () => {} } as any;
      }
      return (originalSetInterval as any)(fn, ms, ...args);
    }) as any);

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ settings: { keepaliveIntervalMs: 500 } })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const keepaliveCb = intervalCallbacks[intervalCallbacks.length - 1];
      expect(typeof keepaliveCb).toBe('function');

      await new Promise(res => setTimeout(res, 25));
      const baselineBinaryCount = server.receivedBinary.length;
      keepaliveCb?.();
      await new Promise(res => setTimeout(res, 25));
      expect(server.receivedBinary.length).toBeGreaterThan(baselineBinaryCount);

      await session.close();
    } finally {
      setIntervalSpy.mockRestore();
      await server.close();
    }
  });

  test('handles invalid JSON, event mapping failures, ws errors, and provider close', async () => {
    const fetchMock = installVapiFetchMock({ websocketCallUrl: 'ws://127.0.0.1:1/unreachable' });
    restoreFetch = fetchMock.restore;

    const compat = new VapiRealtimeCompat() as any;
    const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

    const it = session.events()[Symbol.asyncIterator]();
    await waitForEvent(it, (e: any) => e?.type === 'ready');

    const wsErr = await waitForEvent(it, (e: any) => e?.type === 'error' && (e as any).code === 'ws_error', 5000);
    expect((wsErr as any).code).toBe('ws_error');

    const closed = await waitForEvent(it, (e: any) => e?.type === 'closed', 5000);
    expect((closed as any).reason).toBe('provider_close');

    await session.close();
  });

  test('surfaces invalid_json and event_mapping_failed from provider messages', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      ws.send('{');
      const invalidJson = await waitForEvent(it, (e: any) => e?.type === 'error' && (e as any).code === 'invalid_json');
      expect((invalidJson as any).code).toBe('invalid_json');

      ws.send(
        JSON.stringify({
          type: 'transcript',
          role: 'user',
          transcriptType: 'partial',
          transcript: { toString: 0, valueOf: 0 }
        })
      );

      const mappingErr = await waitForEvent(it, (e: any) => e?.type === 'error' && (e as any).code === 'event_mapping_failed');
      expect((mappingErr as any).code).toBe('event_mapping_failed');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('buffers pending sends before open and reports send_failed on flush errors', async () => {
    const server = await startWsServer();
    const originalSend = wsLib.WebSocket.prototype.send;
    const sendSpy = jest.spyOn(wsLib.WebSocket.prototype, 'send').mockImplementation(function (this: any, data: any) {
      throw new Error('boom');
    });

    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      await session.sendAudio({
        format: 'pcm16',
        sampleRateHz: 16000,
        channels: 1,
        dataBase64: Buffer.from([0, 0, 1, 0]).toString('base64')
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');
      const errEvt = await waitForEvent(it, (e: any) => e?.type === 'error' && (e as any).code === 'send_failed');
      expect((errEvt as any).code).toBe('send_failed');

      await session.close();
    } finally {
      sendSpy.mockRestore();
      // Ensure we didn't permanently modify the prototype in case jest falls back to direct assignment.
      wsLib.WebSocket.prototype.send = originalSend;
      await server.close();
    }
  });

  test('createSession: validates provider endpoint + model + audio options', async () => {
    const compat = new VapiRealtimeCompat() as any;

    await expect(compat.createSession({ provider: createProvider({ endpoint: undefined }), spec: createSpec() } as any)).rejects.toThrow(
      "missing realtime endpoint configuration"
    );

    await expect(
      compat.createSession({ provider: createProvider({ metadata: { defaultModel: '' } }), spec: createSpec({ model: '' }) } as any)
    ).rejects.toThrow("requires 'model'");

    await expect(
      compat.createSession({
        provider: createProvider({ metadata: { defaultModel: undefined } }),
        spec: createSpec({ model: undefined })
      } as any)
    ).rejects.toThrow("requires 'model'");

    await expect(
      compat.createSession({ provider: createProvider(), spec: createSpec({ audio: { input: { format: 'mp3', sampleRateHz: 24000, channels: 1 } } }) } as any)
    ).rejects.toThrow('input audio requires format=pcm16');

    await expect(
      compat.createSession({ provider: createProvider(), spec: createSpec({ audio: { input: {} } }) } as any)
    ).rejects.toThrow('input audio requires format=pcm16');

    await expect(
      compat.createSession({ provider: createProvider(), spec: createSpec({ audio: { input: { format: 'pcm16', sampleRateHz: 24000, channels: 2 } } }) } as any)
    ).rejects.toThrow('input audio requires channels=1');

    await expect(
      compat.createSession({ provider: createProvider(), spec: createSpec({ audio: { input: { format: 'pcm16', sampleRateHz: 0, channels: 1 } } }) } as any)
    ).rejects.toThrow('input audio requires a positive sampleRateHz');

    await expect(
      compat.createSession({ provider: createProvider(), spec: createSpec({ audio: { input: { format: 'pcm16', channels: 1 } } }) } as any)
    ).rejects.toThrow('input audio requires a positive sampleRateHz');
  });

  test('createSession: surfaces create-call errors and missing websocket URL', async () => {
    const compat = new VapiRealtimeCompat() as any;

    restoreFetch = installFetch(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'nope'
    }));
    await expect(compat.createSession({ provider: createProvider(), spec: createSpec() } as any)).rejects.toThrow('nope');

    restoreFetch();
    restoreFetch = installFetch(async () => ({
      ok: false,
      status: 500,
      statusText: 'Boom',
      text: async () => {
        throw new Error('no body');
      }
    }));
    await expect(compat.createSession({ provider: createProvider(), spec: createSpec() } as any)).rejects.toThrow('Boom');

    restoreFetch();
    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'call_1', transport: {} })
    }));
    await expect(compat.createSession({ provider: createProvider(), spec: createSpec() } as any)).rejects.toThrow(
      'missing transport.websocketCallUrl'
    );
  });

  test('createSession: surfaces missing call id in create-call response', async () => {
    const compat = new VapiRealtimeCompat() as any;
    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ transport: { websocketCallUrl: 'ws://127.0.0.1:1/unreachable' } })
    }));

    await expect(compat.createSession({ provider: createProvider(), spec: createSpec() } as any)).rejects.toThrow(
      'missing id'
    );
  });

  test('waitFor controlUrl: uses controlUrlPollMs from spec.settings', async () => {
    const server = await startWsServer();
    const originalSetTimeout = globalThis.setTimeout;
    const pollMs = 1234;
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: any, ...args: any[]) => {
      // Avoid slowing the test down; only short-circuit the polling delay (and the default).
      if (Number(ms) === pollMs || Number(ms) === 500) {
        return (originalSetTimeout as any)(fn, 0, ...args);
      }
      return (originalSetTimeout as any)(fn, ms, ...args);
    }) as any);
    let getCount = 0;

    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          getCount += 1;
          if (getCount < 2) {
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              json: async () => ({ id: 'call_1', monitor: {} })
            };
          }
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', monitor: { controlUrl: 'https://vapi.test/control' } })
          };
        }

        if (method === 'POST' && url === 'https://vapi.test/control') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ status: 'ok' })
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider(),
        spec: createSpec({ settings: { controlUrlPollMs: pollMs } })
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.interrupt();
      expect(setTimeoutSpy.mock.calls.some(([, ms]) => Number(ms) === pollMs)).toBe(true);
      await session.close();
    } finally {
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('waitFor controlUrl: times out when call get fails and includes last error', async () => {
    const server = await startWsServer();
    const nowSpy = jest.spyOn(Date, 'now');
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as any);

    // First Date.now() computes deadline, second enters loop, third exits loop.
    const times = [0, 0, 20001];
    nowSpy.mockImplementation(() => times.shift() ?? 20001);

    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          return {
            ok: false,
            status: 500,
            statusText: 'Boom',
            text: async () => 'nope'
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });

      await expect(session.interrupt()).rejects.toThrow('Timed out waiting for Vapi controlUrl');
      await expect(session.interrupt()).rejects.toThrow('Vapi call get failed (500)');
      await expect(session.interrupt()).rejects.toThrow('nope');
      await session.close();
    } finally {
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('waitFor controlUrl: times out when call details omit controlUrl (no lastErr)', async () => {
    const server = await startWsServer();
    const nowSpy = jest.spyOn(Date, 'now');
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as any);

    // First Date.now() computes deadline, second enters loop, third exits loop.
    const times = [0, 0, 20001];
    nowSpy.mockImplementation(() => times.shift() ?? 20001);

    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', monitor: {} })
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      let err: any;
      try {
        await session.interrupt();
      } catch (e: any) {
        err = e;
      }
      expect(String(err?.message ?? err)).toBe('Timed out waiting for Vapi controlUrl');
      await session.close();
    } finally {
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('fetch call details: surfaces statusText when call get text fails', async () => {
    const server = await startWsServer();
    const nowSpy = jest.spyOn(Date, 'now');
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as any);

    const times = [0, 0, 20001];
    nowSpy.mockImplementation(() => times.shift() ?? 20001);

    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          return {
            ok: false,
            status: 500,
            statusText: 'Boom',
            text: async () => {
              throw new Error('no body');
            }
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      await expect(session.interrupt()).rejects.toThrow('Vapi call get failed (500): Boom');
      await session.close();
    } finally {
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('waitFor controlUrl: includes non-Error lastErr values in timeout message', async () => {
    const server = await startWsServer();
    const nowSpy = jest.spyOn(Date, 'now');
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as any);

    const times = [0, 0, 20001];
    nowSpy.mockImplementation(() => times.shift() ?? 20001);

    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          throw 'non_error_failure';
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      await expect(session.interrupt()).rejects.toThrow('Timed out waiting for Vapi controlUrl: non_error_failure');
      await session.close();
    } finally {
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      await server.close();
    }
  });

  test('maps status-update ended to error + closed', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      ws.send(JSON.stringify({ type: 'status-update', status: 'ended', endedReason: 'some-reason' }));

      const endedErr = await waitForEvent(it, (e: any) => e?.type === 'error' && (e as any).code === 'call_ended');
      expect((endedErr as any).message).toBe('some-reason');

      const closed = await waitForEvent(it, (e: any) => e?.type === 'closed');
      expect((closed as any).reason).toBe('provider_close');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('status-update ignores non-string and non-ended statuses', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      ws.send(JSON.stringify({ type: 'status-update', status: 123 }));
      ws.send(JSON.stringify({ type: 'status-update', status: 'in-progress' }));
      ws.send(JSON.stringify({ type: 'hangup' }));

      const events: any[] = [];
      while (true) {
        const next = await it.next();
        if ((next as any).done) break;
        events.push((next as any).value);
        if ((next as any).value?.type === 'closed') break;
      }
      expect(events.some(e => e?.type === 'error' && e?.code === 'call_ended')).toBe(false);

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('status-update ended uses endedReason fallback', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      ws.send(JSON.stringify({ type: 'status-update', status: 'ended' }));

      const endedErr = await waitForEvent(it, (e: any) => e?.type === 'error' && (e as any).code === 'call_ended');
      expect((endedErr as any).message).toBe('call_ended');
      await waitForEvent(it, (e: any) => e?.type === 'closed');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('maps hangup to closed', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({ websocketCallUrl: server.url });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      const ws = server.getConnected();
      ws.send(JSON.stringify({ type: 'hangup' }));
      const closed = await waitForEvent(it, (e: any) => e?.type === 'closed');
      expect((closed as any).reason).toBe('provider_close');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('postControl: surfaces non-2xx control responses', async () => {
    const server = await startWsServer();
    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', monitor: { controlUrl: 'https://vapi.test/control' } })
          };
        }

        if (method === 'POST' && url === 'https://vapi.test/control') {
          return {
            ok: false,
            status: 500,
            statusText: 'Boom',
            text: async () => 'nope'
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      await expect(session.interrupt()).rejects.toThrow('Vapi control failed (500): nope');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('postControl: falls back to statusText when control response text fails', async () => {
    const server = await startWsServer();
    try {
      restoreFetch = installFetch(async (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url === 'https://vapi.test/call') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', transport: { websocketCallUrl: server.url } })
          };
        }

        if (method === 'GET' && url === 'https://vapi.test/call/call_1') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ id: 'call_1', monitor: { controlUrl: 'https://vapi.test/control' } })
          };
        }

        if (method === 'POST' && url === 'https://vapi.test/control') {
          return {
            ok: false,
            status: 500,
            statusText: 'Boom',
            text: async () => {
              throw new Error('no body');
            }
          };
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
      await expect(session.interrupt()).rejects.toThrow('Vapi control failed (500): Boom');
      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: supports endpoint headers omissions and preserves Content-Type when provided', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ init, body }) => {
          expect(init.headers['Content-Type']).toBe('application/json; charset=utf-8');
          expect(body.assistant.model.messages).toBeUndefined();
          expect(body.assistant.model.temperature).toBe(2);
          expect(body.assistant.model.tools).toBeUndefined();
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({ endpoint: { urlTemplate: 'https://vapi.test/call', headers: { 'Content-Type': 'application/json; charset=utf-8' } } }),
        spec: createSpec({ systemPrompt: '   ', toolChoice: 'none', settings: { temperature: 999 } }),
        tools: [{ name: 'x', description: 'x', parametersJsonSchema: { type: 'object' } }]
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.interrupt();
      const controls = fetchMock.controlBodies.filter(m => m?.type === 'control');
      expect(controls.length).toBe(1);
      expect(controls[0]?.control).toBe('mute-assistant');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('createSession: toolChoice selection and provider tool-name collisions', async () => {
    const server = await startWsServer();
    try {
      const fetchMock = installVapiFetchMock({
        websocketCallUrl: server.url,
        onCreateCall: ({ body }) => {
          const tools = body.assistant.model.tools;
          expect(Array.isArray(tools)).toBe(true);
          const names = tools.map((t: any) => t?.function?.name);
          expect(names).toEqual(['a_b', 'a_b_2']);

          // Ensure bad schemas get coerced to {}.
          expect(tools[0]?.function?.parameters).toEqual({});
        }
      });
      restoreFetch = fetchMock.restore;

      const compat = new VapiRealtimeCompat() as any;
      const session = await compat.createSession({
        provider: createProvider({ endpoint: { urlTemplate: 'https://vapi.test/call', headers: undefined } }),
        spec: createSpec({ toolChoice: { type: 'required', allowed: [] } }),
        tools: [
          { name: 'a.b', description: 'A', parametersJsonSchema: [] },
          { name: 'a_b', description: 'B', parametersJsonSchema: { type: 'object' } }
        ]
      });

      const it = session.events()[Symbol.asyncIterator]();
      await waitForEvent(it, (e: any) => e?.type === 'ready');

      await session.close();
    } finally {
      await server.close();
    }
  });

  test('close() is idempotent and supports terminating when websocket is not open', async () => {
    const fetchMock = installVapiFetchMock({ websocketCallUrl: 'ws://127.0.0.1:1/unreachable' });
    restoreFetch = fetchMock.restore;

    const compat = new VapiRealtimeCompat() as any;
    const session = await compat.createSession({ provider: createProvider(), spec: createSpec() });
    await session.close();
    await session.close();
  });
});
