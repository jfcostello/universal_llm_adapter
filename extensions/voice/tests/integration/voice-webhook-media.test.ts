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

async function waitForMessage(messages: any[], predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(res => setTimeout(res, 10));
  }
  throw new Error('Timed out waiting for WS message');
}

async function startHarness(options: { store: any; providerPlugins?: any }) {
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
    ...(options.providerPlugins ? { providerPlugins: options.providerPlugins } : {})
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
});
