import { jest } from '@jest/globals';
import http from 'http';
import * as path from 'path';

import voiceExtension from '../../index.ts';
import { createInMemoryVoiceCallConfigStore } from '../../internal/call-config-store/index.js';
import { attachUpgradeRouter } from '@/modules/server/internal/transport/upgrade-router.ts';
import { closeServerAndSockets, trackServerSockets, unrefServer } from '../helpers/http-server.ts';

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

  const sockets = trackServerSockets(server);

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

describe('extensions/voice: recording webhook + retrieval', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
  const prevProxyTimeoutMs = process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;

  beforeEach(() => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
  });

  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    } else {
      process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;
    }
    if (prevProxyTimeoutMs === undefined) {
      delete process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS;
    } else {
      process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = prevProxyTimeoutMs;
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
    const parseRecordingWebhook = jest.fn(async (options: any) => {
      const params = options?.params ?? {};
      return {
        recordingId: String(params.recordingId ?? ''),
        recordingUrl: String(params.recordingUrl ?? ''),
        recordingStatus: String(params.recordingStatus ?? ''),
        providerCallId: String(params.providerCallId ?? '')
      };
    });
    const harness = await startHarness({
      store,
      providerPlugins: {
        getManifest: jest.fn(async () => ({ id: 'test', kind: 'test', defaults: { ok: true } })),
        getCompat: jest.fn(async () => ({ validateWebhookRequest, parseRecordingWebhook }))
      },
      httpConfig: { auth: { enabled: true, apiKeys: ['k1'] } }
    });

    try {
      const res = await fetch(new URL('/voice/webhook/recording?callConfigId=cfg_1', harness.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          providerCallId: 'p1',
          recordingId: 'rec_1',
          recordingUrl: 'https://recording.example/rec_1',
          recordingStatus: 'completed'
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
      expect(parseRecordingWebhook).toHaveBeenCalled();
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
    const mediaSockets = trackServerSockets(mediaServer);
    await new Promise<void>((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    unrefServer(mediaServer);
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
      await closeServerAndSockets(mediaServer, mediaSockets);
    }
  });

  test('GET /voice/calls/:callConfigId/recording aborts upstream fetch when client disconnects', async () => {
    let sawRequest = false;
    let sawAbort = false;
    let resolveRequest: (() => void) | undefined;
    let resolveAbort: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => { resolveRequest = resolve; });
    const abortSeen = new Promise<void>((resolve) => { resolveAbort = resolve; });

    const mediaServer = http.createServer((req, res) => {
      if ((req.url ?? '') !== '/file.mp3') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      sawRequest = true;
      resolveRequest?.();

      const markAbort = () => {
        if (sawAbort) return;
        sawAbort = true;
        resolveAbort?.();
      };
      req.on('aborted', markAbort);
      req.on('close', markAbort);

      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      // Keep the connection open until the proxy aborts.
    });
    const mediaSockets = trackServerSockets(mediaServer);
    await new Promise<void>((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    unrefServer(mediaServer);
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

    const controller = new AbortController();
    try {
      const fetchPromise = fetch(new URL('/voice/calls/cfg_1/recording', harness.baseUrl), {
        method: 'GET',
        headers: { Authorization: 'Bearer k1' },
        signal: controller.signal
      });

      let requestTimer: any | undefined;
      try {
        await Promise.race([
          requestSeen,
          new Promise((_, reject) => {
            requestTimer = setTimeout(() => reject(new Error('Expected upstream request')), 1000);
            if (typeof requestTimer?.unref === 'function') requestTimer.unref();
          })
        ]);
      } finally {
        if (requestTimer) clearTimeout(requestTimer);
      }
      expect(sawRequest).toBe(true);

      controller.abort();
      await expect(fetchPromise).rejects.toBeDefined();

      let abortTimer: any | undefined;
      try {
        await Promise.race([
          abortSeen,
          new Promise((_, reject) => {
            abortTimer = setTimeout(() => reject(new Error('Expected upstream abort')), 1000);
            if (typeof abortTimer?.unref === 'function') abortTimer.unref();
          })
        ]);
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }

      expect(sawAbort).toBe(true);
      expect(getRecordingDownloadRequest).toHaveBeenCalled();
    } finally {
      controller.abort();
      await harness.close();
      await closeServerAndSockets(mediaServer, mediaSockets);
    }
  });

  test('GET /voice/calls/:callConfigId/recording enforces proxy timeout', async () => {
    process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS = '250';

    let resolveRequest: (() => void) | undefined;
    let resolveAbort: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => { resolveRequest = resolve; });
    const abortSeen = new Promise<void>((resolve) => { resolveAbort = resolve; });

    const mediaServer = http.createServer((req, res) => {
      if ((req.url ?? '') !== '/file.mp3') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      resolveRequest?.();

      const markAbort = () => resolveAbort?.();
      req.on('aborted', markAbort);
      req.on('close', markAbort);

      // Delay longer than the proxy timeout.
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end('abc');
      }, 1000);
      if (typeof (timer as any)?.unref === 'function') {
        (timer as any).unref();
      }
      const clear = () => {
        try { clearTimeout(timer); } catch {}
      };
      req.on('aborted', clear);
      req.on('close', clear);
    });
    const mediaSockets = trackServerSockets(mediaServer);
    await new Promise<void>((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
    unrefServer(mediaServer);
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
      const fetchPromise = fetch(new URL('/voice/calls/cfg_1/recording', harness.baseUrl), {
        method: 'GET',
        headers: { Authorization: 'Bearer k1' }
      });

      let requestTimer: any | undefined;
      try {
        await Promise.race([
          requestSeen,
          new Promise((_, reject) => {
            requestTimer = setTimeout(() => reject(new Error('Expected upstream request')), 1000);
            if (typeof requestTimer?.unref === 'function') requestTimer.unref();
          })
        ]);
      } finally {
        if (requestTimer) clearTimeout(requestTimer);
      }

      const res = await fetchPromise;
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body?.error?.code ?? body?.type).toBeDefined();
      expect(getRecordingDownloadRequest).toHaveBeenCalled();

      let abortTimer: any | undefined;
      try {
        await Promise.race([
          abortSeen,
          new Promise((_, reject) => {
            abortTimer = setTimeout(() => reject(new Error('Expected upstream abort')), 1000);
            if (typeof abortTimer?.unref === 'function') abortTimer.unref();
          })
        ]);
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }
    } finally {
      await harness.close();
      await closeServerAndSockets(mediaServer, mediaSockets);
    }
  });
});
