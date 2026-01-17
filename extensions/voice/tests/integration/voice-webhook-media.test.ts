import { jest } from '@jest/globals';
import crypto from 'crypto';
import http from 'http';
import * as path from 'path';

import voiceExtension from '../../index.ts';
import { createInMemoryVoiceCallConfigStore } from '../../modules/call-config-store/index.js';
import { createSignedWsToken } from '@/modules/security/index.ts';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';
import { closeServerAndSockets, trackServerSockets, unrefServer } from '../helpers/http-server.ts';

function extractStreamUrl(xml: string): string {
  const match = xml.match(/url=\"([^\"]+)\"/);
  if (!match?.[1]) {
    throw new Error('Missing stream url');
  }
  return match[1];
}

function toWsUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(pathname, httpBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function mintVoiceMediaToken(payload: { callConfigId: string; voiceProvider: string }): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return createSignedWsToken({
    secret: 'secret',
    payload: {
      iat: nowSeconds,
      exp: nowSeconds + 60,
      nonce: crypto.randomBytes(18).toString('base64url'),
      purpose: 'voice_media',
      callConfigId: payload.callConfigId,
      voiceProvider: payload.voiceProvider
    } as any
  });
}

function openWs(url: string): Promise<{ ws: WebSocket; messages: any[]; closePromise: Promise<{ code: number; reason: string }> }> {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (evt: any) => resolve({ code: Number(evt?.code ?? 0), reason: String(evt?.reason ?? '') });
  });

  ws.onmessage = (evt: any) => {
    try {
      const text = typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf-8');
      messages.push(JSON.parse(text));
    } catch {}
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    ws.onerror = err => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      const timer: any = setTimeout(() => reject(err), 250);
      if (typeof timer?.unref === 'function') timer.unref();
      closePromise.then(() => {
        try { clearTimeout(timer); } catch {}
        reject(err);
      });
    };
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      resolve({ ws, messages, closePromise });
    };
  });
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

async function waitForMessage(messages: any[], predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(res => setTimeout(res, 10));
  }
  throw new Error('Timed out waiting for WS message');
}

async function readNextSseEvent(res: Response, timeoutMs = 1000): Promise<any> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Expected SSE body');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const idx = buffer.indexOf('\n\n');
    if (idx < 0) continue;

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
    const dataText = dataLines.join('\n');
    return { event: eventName, data: dataText ? JSON.parse(dataText) : null };
  }

  throw new Error('Timed out waiting for SSE event');
}

async function startHarness(options: { store: any; providerPlugins?: any; logging?: any; httpConfig?: any; preUpgradeHandlers?: any[] }) {
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
  const preUnregister: Array<() => void> = [];

  const reg = await (voiceExtension as any).registerServer({
    server,
    registry: {},
    pluginsPath: path.resolve(process.cwd(), 'plugins'),
    upgradeRouter,
    store: options.store,
    ...(options.providerPlugins ? { providerPlugins: options.providerPlugins } : {}),
    ...(options.logging ? { logging: options.logging } : {}),
    ...(options.httpConfig ? { httpConfig: options.httpConfig } : {})
  });

  handleHttp = reg.handleHttp;
  for (const handler of options.preUpgradeHandlers ?? []) {
    if (typeof handler === 'function') {
      preUnregister.push(upgradeRouter.register(handler));
    }
  }
  const unregister = upgradeRouter.register(reg.handleUpgrade);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  unrefServer(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    unregister();
    for (const fn of preUnregister) {
      try { fn(); } catch {}
    }
    upgradeRouter.close();
    await reg.close?.();
    await closeServerAndSockets(server, sockets);
  };

  return { baseUrl, close };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const durationMs = Math.max(1, Math.floor(timeoutMs));
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer: any = setTimeout(() => reject(new Error(`Timed out: ${label}`)), durationMs);
      if (typeof timer?.unref === 'function') timer.unref();
    })
  ]);
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      results[index] = await fn(items[index]!, index);
    }
  };

  const n = Math.min(Math.max(1, Math.floor(concurrency)), items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

describe('extensions/voice: webhook + media wiring', () => {
  const apiKeyAuth = { mode: 'apiKey', keys: [{ id: 'k1', token: 'k1' }] };
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
  const prevTtl = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS;
  const prevMetricsEnabled = process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;
  const prevMaxConcurrent = process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS;
  const prevMaxMessageBytes = process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES;

  beforeEach(() => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS;
  });

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
    if (prevMaxConcurrent === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS;
    } else {
      process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS = prevMaxConcurrent;
    }
    if (prevMaxMessageBytes === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES;
    } else {
      process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES = prevMaxMessageBytes;
    }
  });

  test('end-to-end: /voice/webhook returns XML and /voice/media delegates via token (replay rejected)', async () => {
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

    const harness = await startHarness({ store });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl), {
        headers: { 'x-test-signature': 'ok' }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/xml');
      const xml = await res.text();
      const wsUrl = extractStreamUrl(xml);
      expect(wsUrl).toContain('/voice/media?token=');

      const { closePromise, messages } = await openWs(wsUrl);
      const ready = await waitForMessage(messages, m => m?.type === 'ready');
      expect(ready.callConfigId).toBe('cfg_1');
      await closePromise;

      // Token replay should fail (nonce is consume-once).
      await expect(openWs(wsUrl)).rejects.toBeDefined();
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: /voice/media accepts token via first WS message when URL query is missing (replay rejected)', async () => {
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

    const harness = await startHarness({
      store,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 250 } } } }
    });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl), {
        headers: { 'x-test-signature': 'ok' }
      });
      expect(res.status).toBe(200);
      const xml = await res.text();

      const wsUrlWithToken = new URL(extractStreamUrl(xml));
      const token = String(wsUrlWithToken.searchParams.get('token') ?? '').trim();
      expect(token).toBeTruthy();
      wsUrlWithToken.searchParams.delete('token');
      const wsUrlWithoutToken = wsUrlWithToken.toString();
      expect(wsUrlWithoutToken).toContain('/voice/media');
      expect(wsUrlWithoutToken).not.toContain('token=');

      const first = await openWs(wsUrlWithoutToken);
      first.ws.send(JSON.stringify({ voiceMediaToken: token }));
      const ready = await waitForMessage(first.messages, m => m?.type === 'ready');
      expect(ready.callConfigId).toBe('cfg_1');
      await first.closePromise;

      const second = await openWs(wsUrlWithoutToken);
      second.ws.send(JSON.stringify({ voiceMediaToken: token }));
      const closeInfo = await second.closePromise;
      expect(closeInfo.code).toBe(1008);
      expect(second.messages.some(m => m?.type === 'ready')).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: token can be found deep in JSON and buffered messages are replayed to the compat', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_proxy_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_proxy'
      },
      { ttlSeconds: 60 }
    );

    let resolvePing: (() => void) | undefined;
    const pingSeen = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });

    const providerPlugins = {
      getManifest: async () => ({ defaults: {} }),
      getCompat: async () => ({
        handleMediaConnection: async ({ ws, callConfigId }: any) => {
          const messagesSeen: string[] = [];
          const handler1 = (data: any) => {
            const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
            messagesSeen.push(text);
            if (text.includes('clientPing')) {
              resolvePing?.();
            }
          };

          const handler2 = jest.fn();
          const handlerThrow = () => {
            throw new Error('boom');
          };

          // Exercise the buffered WS proxy behavior.
          ws.on('message', handler1);
          ws.on('message', handler2);
          ws.off('message', handler2);
          ws.on('message', handlerThrow);
          ws.once('message', jest.fn());

          const onClose = jest.fn();
          ws.on('close', onClose);
          ws.off('close', onClose);
          ws.once('close', jest.fn());

          const state = Number(ws.readyState);
          ws.send(JSON.stringify({ type: 'ready', callConfigId, readyState: state, bufferedCount: messagesSeen.length }));

          const timeout = setTimeout(() => resolvePing?.(), 2000);
          if (typeof (timeout as any)?.unref === 'function') {
            (timeout as any).unref();
          }
          await pingSeen;
          clearTimeout(timeout);

          ws.emit('message', Buffer.from(JSON.stringify({ serverEmitted: true })));
          ws.emit('error', new Error('boom'));
          ws.emit('error');
          ws.close();
          ws.terminate?.();
        }
      })
    };

    const harness = await startHarness({
      store,
      providerPlugins,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const token = mintVoiceMediaToken({ callConfigId: 'cfg_proxy_1', voiceProvider: 'p_proxy' });

      const client = await openWs(wsUrl);
      client.ws.send('not-json');
      client.ws.send(JSON.stringify({ foo: [1, 2, 3], bar: { baz: true } }));
      const deep: any = {};
      let cursor = deep;
      for (let i = 0; i < 12; i++) {
        cursor.n = {};
        cursor = cursor.n;
      }
      client.ws.send(JSON.stringify(deep));
      client.ws.send(JSON.stringify({ start: { customParameters: [{ voiceMediaToken: token }] } }));

      const ready = await waitForMessage(client.messages, m => m?.type === 'ready');
      expect(ready.callConfigId).toBe('cfg_proxy_1');

      client.ws.send(JSON.stringify({ clientPing: true }));
      await client.closePromise;
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: closes when token is not provided within the configured timeout', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_timeout_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_timeout'
      },
      { ttlSeconds: 60 }
    );

    const harness = await startHarness({
      store,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 25 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const client = await openWs(wsUrl);
      const closeInfo = await client.closePromise;
      expect(closeInfo.code).toBe(1008);
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: closes with 1009 when pre-auth buffered messages exceed limit', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_big_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_big'
      },
      { ttlSeconds: 60 }
    );

    const harness = await startHarness({
      store,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const client = await openWs(wsUrl);
      client.ws.send('x'.repeat(300000));
      const closeInfo = await client.closePromise;
      expect(closeInfo.code).toBe(1009);
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: rejects upgrade with 503 when media WS capacity is reached (token-in-message path)', async () => {
    process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS = '1';

    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_busy_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_busy'
      },
      { ttlSeconds: 60 }
    );

    const providerPlugins = {
      getManifest: async () => ({ defaults: {} }),
      getCompat: async () => ({
        handleMediaConnection: async ({ ws, callConfigId }: any) => {
          try {
            ws.send(JSON.stringify({ type: 'ready', callConfigId }));
          } catch {}
          // keep open until the client closes
        }
      })
    };

    const harness = await startHarness({
      store,
      providerPlugins,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const token = mintVoiceMediaToken({ callConfigId: 'cfg_busy_1', voiceProvider: 'p_busy' });

      const first = await openWs(wsUrl);
      first.ws.send(JSON.stringify({ voiceMediaToken: token }));
      await waitForMessage(first.messages, m => m?.type === 'ready');

      await expect(openWs(wsUrl)).rejects.toBeDefined();

      first.ws.close();
      await first.closePromise;
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: closes when token payload refers to unknown callConfigId or mismatched voiceProvider', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_known_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_known'
      },
      { ttlSeconds: 60 }
    );
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_missing_provider_1',
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

    const providerPlugins = {
      getManifest: async () => ({ defaults: {} }),
      getCompat: async () => ({
        handleMediaConnection: async () => {
          // should not be reached
        }
      })
    };

    const harness = await startHarness({
      store,
      providerPlugins,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');

      // Unknown call config
      const unknownToken = mintVoiceMediaToken({ callConfigId: 'missing_cfg', voiceProvider: 'p_known' });
      const a = await openWs(wsUrl);
      a.ws.send(JSON.stringify({ voiceMediaToken: unknownToken }));
      const closedA = await a.closePromise;
      expect(closedA.code).toBe(1008);

      // Voice provider mismatch
      const mismatchToken = mintVoiceMediaToken({ callConfigId: 'cfg_known_1', voiceProvider: 'other' });
      const b = await openWs(wsUrl);
      b.ws.send(JSON.stringify({ voiceMediaToken: mismatchToken }));
      const closedB = await b.closePromise;
      expect(closedB.code).toBe(1008);

      // Missing voiceProvider in call config (nullish coalescing branch)
      const missingProviderToken = mintVoiceMediaToken({ callConfigId: 'cfg_missing_provider_1', voiceProvider: 'p_known' });
      const c = await openWs(wsUrl);
      c.ws.send(JSON.stringify({ voiceMediaToken: missingProviderToken }));
      const closedC = await c.closePromise;
      expect(closedC.code).toBe(1008);
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: token-in-message recovers when req.url becomes invalid before token injection', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_req_mutate_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_req_mutate'
      },
      { ttlSeconds: 60 }
    );

    let seenReqUrl: string | undefined;
    let upgradeReq: any;

    const providerPlugins = {
      getCompat: async () => ({
        handleMediaConnection: async ({ ws, req }: any) => {
          seenReqUrl = String(req?.url ?? '');
          try {
            ws.send(JSON.stringify({ type: 'ready' }));
          } catch {}
          try { ws.close(); } catch {}
        }
      })
    };

    const harness = await startHarness({
      store,
      providerPlugins,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } },
      preUpgradeHandlers: [
        ({ req, pathname }: any) => {
          if (pathname === '/voice/media') upgradeReq = req;
          return false;
        }
      ]
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const token = mintVoiceMediaToken({ callConfigId: 'cfg_req_mutate_1', voiceProvider: 'p_req_mutate' });

      const client = await openWs(wsUrl);
      upgradeReq.url = 'http://%';
      client.ws.send(JSON.stringify({ voiceMediaToken: token }));

      await waitForMessage(client.messages, m => m?.type === 'ready');
      await client.closePromise;

      expect(seenReqUrl).toContain('/voice/media?token=');
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: closes when token in first message is invalid', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_bad_token_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_bad_token'
      },
      { ttlSeconds: 60 }
    );

    const providerPlugins = {
      getCompat: async () => ({
        handleMediaConnection: async () => {
          // should not be reached
        }
      })
    };

    const harness = await startHarness({
      store,
      providerPlugins,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const client = await openWs(wsUrl);
      client.ws.send(JSON.stringify({ voiceMediaToken: 'bad' }));
      const closeInfo = await client.closePromise;
      expect(closeInfo.code).toBe(1008);
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: token-in-message works without provider manifest defaults and preserves requestId', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_reqid_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_reqid',
        metadata: { requestId: 'req_1' }
      } as any,
      { ttlSeconds: 60 }
    );

    const providerPlugins = {
      getCompat: async () => ({
        handleMediaConnection: async ({ ws, callConfigId }: any) => {
          try {
            ws.send(JSON.stringify({ type: 'ready', callConfigId }));
          } catch {}
          try { ws.close(); } catch {}
        }
      })
    };

    const harness = await startHarness({
      store,
      providerPlugins,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const token = mintVoiceMediaToken({ callConfigId: 'cfg_reqid_1', voiceProvider: 'p_reqid' });
      const client = await openWs(wsUrl);
      client.ws.send(JSON.stringify({ voiceMediaToken: token }));
      const ready = await waitForMessage(client.messages, m => m?.type === 'ready');
      expect(ready.callConfigId).toBe('cfg_reqid_1');
      await client.closePromise;
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: closes with 1011 when the compat lookup fails in token-in-message flow', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_err_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'inbound',
        realtimeSpec: {},
        voiceProvider: 'p_err'
      },
      { ttlSeconds: 60 }
    );

    const providerPlugins = {
      getCompat: async () => {
        throw new Error('boom');
      }
    };

    const harness = await startHarness({
      store,
      providerPlugins,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 500 } } } }
    });

    try {
      const wsUrl = toWsUrl(harness.baseUrl, '/voice/media');
      const token = mintVoiceMediaToken({ callConfigId: 'cfg_err_1', voiceProvider: 'p_err' });

      const client = await openWs(wsUrl);
      client.ws.send(JSON.stringify({ voiceMediaToken: token }));
      const closeInfo = await client.closePromise;
      expect(closeInfo.code).toBe(1011);
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: media compat can emit normalized events via adapter event hub', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_emit_1',
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

    let resolveEmitted: (() => void) | undefined;
    const emitted = new Promise<void>((resolve) => {
      resolveEmitted = resolve;
    });

    const providerPlugins = {
      getCompat: jest.fn(async () => ({
        validateWebhookRequest: jest.fn(async () => {}),
        createWebhookResponse: jest.fn(async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml' },
          body: `<Response><Start><Stream url=\"${options.mediaWsUrl}\" /></Start></Response>`
        })),
        handleMediaConnection: jest.fn(async (options: any) => {
          options.events?.emit?.({ type: 'voice.test_event' });
          resolveEmitted?.();
          try {
            options.ws?.send?.(JSON.stringify({ type: 'ready', callConfigId: options.callConfigId }));
          } catch {}
        })
      }))
    };

    const harness = await startHarness({ store, providerPlugins });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_emit_1', harness.baseUrl), {
        headers: { 'x-test-signature': 'ok' }
      });
      expect(res.status).toBe(200);
      const xml = await res.text();
      const wsUrl = extractStreamUrl(xml);

      const { ws, closePromise } = await openWs(wsUrl);
      await emitted;
      ws.close();
      await closePromise;
    } finally {
      await harness.close();
    }
  });

  test('end-to-end: /voice/webhook accepts application/json and can emit SSE events', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_webhook_json_1',
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
        createWebhookResponse: jest.fn(async (options: any) => {
          expect(options.params).toEqual({});
          expect(options.body).toEqual({ message: { type: 'status-update', status: 'queued' } });
          expect(typeof options.bodyText).toBe('string');
          expect(options.bodyText).toContain('status-update');
          options.events?.emit?.({ type: 'user_transcript.final', text: 'hello from webhook' });
          return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
        })
      }))
    };

	    const harness = await startHarness({
	      store,
	      providerPlugins,
	      httpConfig: { auth: apiKeyAuth }
	    });

    let eventsRes: Response | undefined;
    try {
      const webhookRes = await fetch(new URL('/voice/webhook?callConfigId=cfg_webhook_json_1', harness.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-signature': 'ok' },
        body: JSON.stringify({ message: { type: 'status-update', status: 'queued' } })
      });
      expect(webhookRes.status).toBe(200);

      eventsRes = await fetch(new URL('/voice/calls/cfg_webhook_json_1/events', harness.baseUrl), {
        method: 'GET',
        headers: { Authorization: 'Bearer k1' }
      });
      expect(eventsRes.status).toBe(200);

      const first = await readNextSseEvent(eventsRes, 1000);
      expect(first.data?.event?.type ?? first.event).toBe('user_transcript.final');
      expect(first.data?.event?.text ?? first.data?.event?.textDelta ?? '').toContain('hello from webhook');
    } finally {
      try { await eventsRes?.body?.cancel(); } catch {}
      await harness.close();
    }
  });

  test('end-to-end: supports WS token TTL > 300s when configured', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS = '600';

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

    const harness = await startHarness({ store });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl), {
        headers: { 'x-test-signature': 'ok' }
      });
      expect(res.status).toBe(200);
      const xml = await res.text();
      const wsUrl = extractStreamUrl(xml);

      const { closePromise, messages } = await openWs(wsUrl);
      const ready = await waitForMessage(messages, m => m?.type === 'ready');
      expect(ready.callConfigId).toBe('cfg_1');
      await closePromise;
    } finally {
      await harness.close();
    }
  });

  test('metrics: media WS open/close updates gauges/counters when enabled', async () => {
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';

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
      getCompat: async () => ({
        validateWebhookRequest: async () => {},
        createWebhookResponse: async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: `<?xml version=\"1.0\"?><Response><Connect><Stream url=\"${options.mediaWsUrl}\" /></Connect></Response>`
        }),
        handleMediaConnection: async () => {
          // keep connection open until the client closes
        }
      })
    };

	    const harness = await startHarness({ store, providerPlugins, httpConfig: { auth: apiKeyAuth } });
	    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const { ws, closePromise } = await openWs(wsUrl);

      const metrics1 = await (await fetch(new URL('/voice/metrics', harness.baseUrl), { headers: { Authorization: 'Bearer k1' } })).json();
      const samples1: any[] = Array.isArray(metrics1.metrics) ? metrics1.metrics : [];
      const active1 = samples1.find(m => m?.name === 'voice.media.ws_active' && m?.labels?.voiceProvider === 'test');
      const opened1 = samples1.find(m => m?.name === 'voice.media.ws_open_total' && m?.labels?.voiceProvider === 'test');
      expect(active1?.value).toBe(1);
      expect(opened1?.value).toBe(1);

      ws.close();
      await closePromise;
      await new Promise(res => setTimeout(res, 10));

      const metrics2 = await (await fetch(new URL('/voice/metrics', harness.baseUrl), { headers: { Authorization: 'Bearer k1' } })).json();
      const samples2: any[] = Array.isArray(metrics2.metrics) ? metrics2.metrics : [];
      const active2 = samples2.find(m => m?.name === 'voice.media.ws_active' && m?.labels?.voiceProvider === 'test');
      const closed2 = samples2.find(m => m?.name === 'voice.media.ws_close_total' && m?.labels?.voiceProvider === 'test');
      expect(active2?.value).toBe(0);
      expect(closed2?.value).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test('logs ws error events without leaking ws token', async () => {
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';

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
        voiceProvider: 'p1',
        metadata: { requestId: 'req_ws_1' }
      },
      { ttlSeconds: 60 }
    );

    const logger = createCapturingLogger();

    const providerPlugins = {
      getCompat: async () => ({
        validateWebhookRequest: async () => {},
        createWebhookResponse: async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: `<?xml version=\"1.0\"?><Response><Connect><Stream url=\"${options.mediaWsUrl}\" /></Connect></Response>`
        }),
        handleMediaConnection: async ({ ws }: any) => {
          try {
            ws.emit?.('error', new Error('boom'));
            ws.emit?.('error', 'boom2');
          } catch {}
          try { ws.close(); } catch {}
        }
      })
    };

	    const harness = await startHarness({ store, providerPlugins, logging: { getLogger: () => logger }, httpConfig: { auth: apiKeyAuth } });
	    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const { closePromise } = await openWs(wsUrl);
      await closePromise;

      const logged = JSON.stringify({ info: logger.info.mock.calls, err: logger.error.mock.calls });
      expect(logged).toContain('voice.media.ws_error');
      expect(logged).not.toContain('token=');

      const metrics = await (await fetch(new URL('/voice/metrics', harness.baseUrl), { headers: { Authorization: 'Bearer k1' } })).json();
      const samples: any[] = Array.isArray(metrics.metrics) ? metrics.metrics : [];
      const wsErr = samples.find(m => m?.name === 'voice.media.ws_error_total' && m?.labels?.voiceProvider === 'p1');
      expect(wsErr?.value).toBeGreaterThanOrEqual(1);
    } finally {
      await harness.close();
    }
  });

  test('close terminates active WS clients', async () => {
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
        voiceProvider: 'p1'
      },
      { ttlSeconds: 60 }
    );

    const providerPlugins = {
      getCompat: async () => ({
        validateWebhookRequest: async () => {},
        createWebhookResponse: async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: `<?xml version=\"1.0\"?><Response><Connect><Stream url=\"${options.mediaWsUrl}\" /></Connect></Response>`
        }),
        handleMediaConnection: async () => {
          // keep connection open
        }
      })
    };

    const harness = await startHarness({ store, providerPlugins });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const { ws, closePromise } = await openWs(wsUrl);
      expect(ws.readyState).toBe(ws.OPEN);

      await harness.close();
      await closePromise;
    } finally {
      // already closed
    }
  });

  test('media handler closes ws when compat handler throws', async () => {
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
        voiceProvider: 'p1'
      },
      { ttlSeconds: 60 }
    );

    const providerPlugins = {
      getCompat: async () => ({
        validateWebhookRequest: async () => {},
        createWebhookResponse: async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: `<?xml version=\"1.0\"?><Response><Connect><Stream url=\"${options.mediaWsUrl}\" /></Connect></Response>`
        }),
        handleMediaConnection: async () => {
          throw new Error('boom');
        }
      })
    };

    const harness = await startHarness({ store, providerPlugins });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const { closePromise } = await openWs(wsUrl);
      await closePromise;
    } finally {
      await harness.close();
    }
  });

  test('media handler logs error code when compat throws a coded non-Error', async () => {
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
        voiceProvider: 'p1',
        metadata: { requestId: 'req_ws_2' }
      },
      { ttlSeconds: 60 }
    );

    const logger = createCapturingLogger();

    const providerPlugins = {
      getCompat: async () => ({
        validateWebhookRequest: async () => {},
        createWebhookResponse: async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: `<?xml version=\"1.0\"?><Response><Connect><Stream url=\"${options.mediaWsUrl}\" /></Connect></Response>`
        }),
        handleMediaConnection: async () => {
          throw { code: 'coded_error' };
        }
      })
    };

    const harness = await startHarness({ store, providerPlugins, logging: { getLogger: () => logger } });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const { closePromise } = await openWs(wsUrl);
      await closePromise;

      const logged = JSON.stringify({ err: logger.error.mock.calls });
      expect(logged).toContain('voice.media.error');
      expect(logged).toContain('coded_error');
    } finally {
      await harness.close();
    }
  });

  test('reliability: limits concurrent media WS sessions when configured', async () => {
    process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS = '1';

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
      getCompat: async () => ({
        validateWebhookRequest: async () => {},
        createWebhookResponse: async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: `<?xml version=\"1.0\"?><Response><Connect><Stream url=\"${options.mediaWsUrl}\" /></Connect></Response>`
        }),
        handleMediaConnection: async () => {
          // keep connection open
        }
      })
    };

    const harness = await startHarness({ store, providerPlugins });
    try {
      const res1 = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl1 = extractStreamUrl(await res1.text());

      const res2 = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl2 = extractStreamUrl(await res2.text());

      const { ws: ws1, closePromise: close1 } = await openWs(wsUrl1);
      await expect(openWs(wsUrl2)).rejects.toBeDefined();

      ws1.close();
      await close1;
      await new Promise(res => setTimeout(res, 10));

      const res3 = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl3 = extractStreamUrl(await res3.text());
      const { ws: ws3, closePromise: close3 } = await openWs(wsUrl3);
      ws3.close();
      await close3;
    } finally {
      await harness.close();
    }
  });

  test('reliability: supports concurrent /voice/calls → /voice/webhook → /voice/media (test compat)', async () => {
    const store = createInMemoryVoiceCallConfigStore();
	    const harness = await startHarness({
	      store,
	      httpConfig: { auth: apiKeyAuth }
	    });

    try {
      const callCount = 10;
      const concurrency = 5;

      const callConfigIds = await pool(
        Array.from({ length: callCount }, (_, i) => i),
        concurrency,
        async () => {
          const res = await fetch(new URL('/voice/calls', harness.baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k1' },
            body: JSON.stringify({ to: 'to', from: 'from', voiceProvider: 'test', realtimeSpec: {} })
          });
          expect(res.status).toBe(200);
          const json = await res.json();
          const callConfigId = String(json?.callConfigId ?? '');
          if (!callConfigId) {
            throw new Error('Missing callConfigId');
          }
          return callConfigId;
        }
      );

      const wsUrls = await pool(callConfigIds, concurrency, async (callConfigId) => {
        const res = await fetch(new URL(`/voice/webhook?callConfigId=${encodeURIComponent(callConfigId)}`, harness.baseUrl), {
          headers: { 'x-test-signature': 'ok' }
        });
        expect(res.status).toBe(200);
        const xml = await res.text();
        return extractStreamUrl(xml);
      });

      const clients = await pool(wsUrls, concurrency, async (wsUrl) => {
        const client = await openWs(wsUrl);
        const ready = await waitForMessage(client.messages, m => m?.type === 'ready', 2000);
        expect(callConfigIds).toContain(String(ready?.callConfigId ?? ''));
        // Test compat closes immediately; ensure close is observed so we don't leak handles.
        await withTimeout(client.closePromise, 2000, 'ws close');
        return client;
      });

      expect(clients).toHaveLength(callCount);
    } finally {
      await harness.close();
    }
  });

  test('reliability: closes connection when max message bytes exceeded', async () => {
    process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES = '32';

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
      getCompat: async () => ({
        validateWebhookRequest: async () => {},
        createWebhookResponse: async (options: any) => ({
          status: 200,
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: `<?xml version=\"1.0\"?><Response><Connect><Stream url=\"${options.mediaWsUrl}\" /></Connect></Response>`
        }),
        handleMediaConnection: async () => {
          // keep connection open
        }
      })
    };

    const harness = await startHarness({ store, providerPlugins });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const ws = new WebSocket(wsUrl);
      const close = new Promise<any>((resolve) => {
        ws.onclose = (evt: any) => resolve(evt);
      });
      await new Promise<void>((resolve, reject) => {
        ws.onerror = err => reject(err);
        ws.onopen = () => resolve();
      });

      ws.send('x'.repeat(200));
      const evt = await close;
      expect(Number(evt?.code)).toBe(1009);
    } finally {
      await harness.close();
    }
  });
});
