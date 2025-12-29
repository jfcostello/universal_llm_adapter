import { jest } from '@jest/globals';
import http from 'http';
import * as path from 'path';

import voiceExtension from '../../index.ts';
import { createInMemoryVoiceCallConfigStore } from '../../internal/call-config-store/index.js';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';

async function startHarness(options: { store: any; providerPlugins: any; httpConfig: any }) {
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
    providerPlugins: options.providerPlugins,
    httpConfig: options.httpConfig
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

describe('extensions/voice: recording webhook + retrieval', () => {
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

  test('POST /voice/webhook/recording stores provider recording metadata', async () => {
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
        recording: { enabled: true, mode: 'provider', format: 'mp3', channels: 'mono' }
      } as any,
      { ttlSeconds: 60 }
    );

    const validateWebhookRequest = jest.fn(async () => {});
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: { ok: true } })),
        getCompat: jest.fn(async () => ({ validateWebhookRequest }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/webhook/recording?callConfigId=cfg_1', harness.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          CallSid: 'p1',
          RecordingSid: 'rec_1',
          RecordingUrl: 'https://recording.example/rec_1',
          RecordingStatus: 'completed'
        }).toString()
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });

      const stored = await store.getConfig('cfg_1');
      expect((stored as any)?.recording?.providerRecording).toEqual({
        id: 'rec_1',
        url: 'https://recording.example/rec_1',
        status: 'completed'
      });

      expect(validateWebhookRequest).toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('GET /voice/calls/:callConfigId/recording streams the recording media', async () => {
    const mediaServer = http.createServer((req, res) => {
      if ((req.url ?? '') !== '/file.mp3') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end('abc');
    });
    await new Promise<void>((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    const address = mediaServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const mediaUrl = `http://127.0.0.1:${address.port}/file.mp3`;

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
        recording: {
          enabled: true,
          mode: 'provider',
          format: 'mp3',
          channels: 'mono',
          providerRecording: { id: 'rec_1', url: 'https://recording.example/rec_1', status: 'completed' }
        }
      } as any,
      { ttlSeconds: 60 }
    );

    const getRecordingDownloadRequest = jest.fn(async () => ({ url: mediaUrl, headers: {} }));
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: { ok: true } })),
        getCompat: jest.fn(async () => ({ getRecordingDownloadRequest }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/calls/cfg_1/recording', harness.baseUrl), {
        method: 'GET',
        headers: { Authorization: 'Bearer k1' }
      });
      expect(res.status).toBe(200);
      expect(String(res.headers.get('content-type'))).toContain('audio/mpeg');
      expect(await res.text()).toBe('abc');

      expect(getRecordingDownloadRequest).toHaveBeenCalledWith(
        expect.objectContaining({ callConfigId: 'cfg_1', voiceProvider: 'test' })
      );
    } finally {
      await harness.close();
      await new Promise<void>((resolve, reject) => mediaServer.close(err => (err ? reject(err) : resolve())));
    }
  });
});

