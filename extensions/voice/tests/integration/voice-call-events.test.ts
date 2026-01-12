import { jest } from '@jest/globals';
import http from 'http';
import * as path from 'path';

import voiceExtension from '../../index.ts';
import { createInMemoryVoiceCallConfigStore } from '../../modules/call-config-store/index.js';
import { createVoiceCallEventHub } from '../../modules/call-events/index.js';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';
import { closeServerAndSockets, trackServerSockets, unrefServer } from '../helpers/http-server.ts';

async function startHarness(options: { store: any; providerPlugins: any; httpConfig: any; eventsHub?: any }) {
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
    httpConfig: options.httpConfig,
    ...(options.eventsHub ? { eventsHub: options.eventsHub } : {})
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

async function* iterateSse(res: Response, options: { timeoutMs: number }): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';

  const reader = res.body?.getReader();
  if (!reader) throw new Error('Expected response body');

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf('\n\n');
      if (idx < 0) break;
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));
      let eventName: string | undefined;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim());
        }
      }

      if (!eventName && dataLines.length === 0) continue;
      const dataText = dataLines.join('\n');
      yield { event: eventName, data: dataText ? JSON.parse(dataText) : null };
    }
  }
}

describe('extensions/voice: call events + control endpoints', () => {
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

  test('GET /voice/calls/:callConfigId/events replays buffered events and streams deltas when enabled', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });
    hub.emit('cfg_1', { type: 'user_transcript.final', text: 'hello' });

    const harness = await startHarness({
      store,
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: hub
    });

    const controller = new AbortController();
    let res: Response | undefined;
    try {
      res = await fetch(new URL('/voice/calls/cfg_1/events?includeDeltas=1', harness.baseUrl), {
        method: 'GET',
        headers: { Authorization: 'Bearer k1' },
        signal: controller.signal
      });

      expect(res.status).toBe(200);
      expect(String(res.headers.get('content-type'))).toContain('text/event-stream');

      const iterator = iterateSse(res, { timeoutMs: 1000 });
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value?.data?.event?.type ?? first.value?.event).toBe('user_transcript.final');

      hub.emit('cfg_1', { type: 'user_transcript.delta', textDelta: 'he' });
      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value?.data?.event?.type ?? second.value?.event).toBe('user_transcript.delta');

      controller.abort();

    } finally {
      controller.abort();
      try { await res?.body?.cancel(); } catch {}
      hub.close();
      await harness.close();
    }
  });

  test('GET /voice/calls/:callConfigId/events supports eventTypes allowlist filtering', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 10, callTtlMs: 0 });
    hub.emit('cfg_1', { type: 'user_transcript.final', text: 'hello' });
    hub.emit('cfg_1', { type: 'assistant_transcript.final', text: 'skip' });

    const harness = await startHarness({
      store,
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: hub
    });

    const controller = new AbortController();
    let res: Response | undefined;
    try {
      res = await fetch(new URL('/voice/calls/cfg_1/events?eventTypes=user_transcript.final&includeDeltas=1', harness.baseUrl), {
        method: 'GET',
        headers: { Authorization: 'Bearer k1' },
        signal: controller.signal
      });

      expect(res.status).toBe(200);

      const iterator = iterateSse(res, { timeoutMs: 1000 });
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value?.data?.event?.type ?? first.value?.event).toBe('user_transcript.final');

      hub.emit('cfg_1', { type: 'assistant_transcript.final', text: 'nope' });
      hub.emit('cfg_1', { type: 'user_transcript.delta', textDelta: 'he' });
      hub.emit('cfg_1', { type: 'user_transcript.final', text: 'ok' });

      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value?.data?.event?.type ?? second.value?.event).toBe('user_transcript.final');

      controller.abort();
    } finally {
      controller.abort();
      try { await res?.body?.cancel(); } catch {}
      hub.close();
      await harness.close();
    }
  });

  test('GET /voice/calls/:callConfigId/events returns 503 when the events hub is saturated', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test'
      },
      { ttlSeconds: 60 }
    );

    const hub = createVoiceCallEventHub({ maxBufferedEventsPerCall: 10, maxActiveCalls: 1, callTtlMs: 0 });
    const busy = hub.subscribe('busy', { includeDeltas: false }, () => {});
    expect(busy.accepted).toBe(true);

    const harness = await startHarness({
      store,
      providerPlugins: { getCompat: jest.fn(), getManifest: jest.fn() },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } },
      eventsHub: hub
    });

    try {
      const res = await fetch(new URL('/voice/calls/cfg_1/events', harness.baseUrl), {
        method: 'GET',
        headers: { Authorization: 'Bearer k1' }
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({
        type: 'error',
        error: { message: 'Voice call events hub is saturated', code: 'call_events_saturated' }
      });
    } finally {
      busy.unsubscribe();
      hub.close();
      await harness.close();
    }
  });

  test('POST /voice/calls/:callConfigId/end calls provider compat', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'test',
        providerCallId: 'p1'
      } as any,
      { ttlSeconds: 60 }
    );

    const endCall = jest.fn(async () => ({ ok: true }));
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: { ok: true } })),
        getCompat: jest.fn(async () => ({ endCall }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls/cfg_1/end', harness.baseUrl), {
        method: 'POST',
        headers: { Authorization: 'Bearer k1' }
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({ ok: true }));

      expect(endCall).toHaveBeenCalledWith(
        expect.objectContaining({
          callConfigId: 'cfg_1',
          voiceProvider: 'test',
          providerCallId: 'p1'
        })
      );
    } finally {
      await harness.close();
    }
  });
});
