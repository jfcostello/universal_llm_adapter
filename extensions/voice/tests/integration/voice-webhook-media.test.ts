import { jest } from '@jest/globals';
import http from 'http';
import * as path from 'path';

import voiceExtension from '../../index.ts';
import { createInMemoryVoiceCallConfigStore } from '../../internal/call-config-store/index.js';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';

function extractStreamUrl(xml: string): string {
  const match = xml.match(/url=\"([^\"]+)\"/);
  if (!match?.[1]) {
    throw new Error('Missing stream url');
  }
  return match[1];
}

function openWs(url: string): Promise<{ ws: WebSocket; messages: any[]; closePromise: Promise<void> }> {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  const closePromise = new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
  });

  ws.onmessage = (evt: any) => {
    try {
      const text = typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf-8');
      messages.push(JSON.parse(text));
    } catch {}
  };

  return new Promise((resolve, reject) => {
    ws.onerror = err => reject(err);
    ws.onopen = () => resolve({ ws, messages, closePromise });
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

async function startHarness(options: { store: any; providerPlugins?: any; logging?: any }) {
  let handleHttp: any = async () => false;
  const server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleHttp(req, res);
      if (handled) return;
      res.statusCode = 404;
      res.end('not found');
    })();
  });

  const upgradeRouter = attachUpgradeRouter(server);

  const reg = await (voiceExtension as any).registerServer({
    server,
    registry: {},
    pluginsPath: path.resolve(process.cwd(), 'plugins'),
    upgradeRouter,
    store: options.store,
    ...(options.providerPlugins ? { providerPlugins: options.providerPlugins } : {}),
    ...(options.logging ? { logging: options.logging } : {})
  });

  handleHttp = reg.handleHttp;
  const unregister = upgradeRouter.register(reg.handleUpgrade);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    unregister();
    upgradeRouter.close();
    await reg.close?.();
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  };

  return { baseUrl, close };
}

describe('extensions/voice: webhook + media wiring', () => {
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

    const harness = await startHarness({ store, providerPlugins });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const { ws, closePromise } = await openWs(wsUrl);

      const metrics1 = await (await fetch(new URL('/voice/metrics', harness.baseUrl))).json();
      const samples1: any[] = Array.isArray(metrics1.metrics) ? metrics1.metrics : [];
      const active1 = samples1.find(m => m?.name === 'voice.media.ws_active' && m?.labels?.voiceProvider === 'test');
      const opened1 = samples1.find(m => m?.name === 'voice.media.ws_open_total' && m?.labels?.voiceProvider === 'test');
      expect(active1?.value).toBe(1);
      expect(opened1?.value).toBe(1);

      ws.close();
      await closePromise;
      await new Promise(res => setTimeout(res, 10));

      const metrics2 = await (await fetch(new URL('/voice/metrics', harness.baseUrl))).json();
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
        voiceProvider: 'p1'
      },
      { ttlSeconds: 60 }
    );

    const logger = createCapturingLogger();

    const providerPlugins = {
      getCompat: async () => ({
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

    const harness = await startHarness({ store, providerPlugins, logging: { getLogger: () => logger } });
    try {
      const res = await fetch(new URL('/voice/webhook?callConfigId=cfg_1', harness.baseUrl));
      const wsUrl = extractStreamUrl(await res.text());

      const { closePromise } = await openWs(wsUrl);
      await closePromise;

      const logged = JSON.stringify({ info: logger.info.mock.calls, err: logger.error.mock.calls });
      expect(logged).toContain('voice.media.ws_error');
      expect(logged).not.toContain('token=');

      const metrics = await (await fetch(new URL('/voice/metrics', harness.baseUrl))).json();
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
        voiceProvider: 'p1'
      },
      { ttlSeconds: 60 }
    );

    const logger = createCapturingLogger();

    const providerPlugins = {
      getCompat: async () => ({
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
