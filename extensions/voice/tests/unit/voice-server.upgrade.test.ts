import { jest } from '@jest/globals';
import crypto from 'crypto';

import { createSignedWsToken } from '@/modules/security/index.ts';
import { createVoiceServerRegistration } from '../../modules/server/index.js';
import { createInMemoryVoiceCallConfigStore } from '../../modules/call-config-store/index.js';

function makeSocket() {
  return { write: jest.fn(), destroy: jest.fn() } as any;
}

function extractStatusLine(payload: any): string {
  const raw = payload?.write?.mock?.calls?.[0]?.[0];
  return typeof raw === 'string' ? raw : String(raw ?? '');
}

describe('extensions/voice: server upgrade handler', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
  const prevTtl = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS;
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

  test('ignores non-matching paths', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const socket = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: '/voice/media' } as any, socket, head: Buffer.alloc(0), pathname: '/wrong' })).resolves.toBe(false);
    expect(socket.write).not.toHaveBeenCalled();
  });

  test('rejects invalid URL before token verification', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const socket = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: 'http://%' } as any, socket, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socket)).toContain('400 Bad Request');
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('rejects when token is missing/invalid or missing required fields', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 0 } } } }
    });

    const socketA = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: '/voice/media' } as any, socket: socketA, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socketA)).toContain('401 Unauthorized');

    const socketB = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: '/voice/media?token=bad' } as any, socket: socketB, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socketB)).toContain('401 Unauthorized');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokenMissingFields = createSignedWsToken({
      secret: 'secret',
      payload: { iat: nowSeconds, exp: nowSeconds + 30, nonce: 'abc', purpose: 'voice_media' } as any
    });

    const socketC = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: `/voice/media?token=${encodeURIComponent(tokenMissingFields)}` } as any, socket: socketC, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socketC)).toContain('401 Unauthorized');
  });

  test('rejects replayed nonces, unknown callConfigId, and voiceProvider mismatch', async () => {
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
    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_undef',
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

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const basePayload = () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      return { iat: nowSeconds, exp: nowSeconds + 60, nonce: crypto.randomBytes(9).toString('base64url'), purpose: 'voice_media', callConfigId: 'cfg_1', voiceProvider: 'p1' };
    };

    // Replay
    const pReplay = basePayload();
    const replayToken = createSignedWsToken({ secret: 'secret', payload: pReplay as any });
    await store.consumeNonceOnce(pReplay.nonce, { ttlSeconds: 60 });
    const socketReplay = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: `/voice/media?token=${encodeURIComponent(replayToken)}` } as any, socket: socketReplay, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socketReplay)).toContain('401 Unauthorized');

    // Unknown call config
    const pMissingCfg = { ...basePayload(), callConfigId: 'missing' };
    const missingCfgToken = createSignedWsToken({ secret: 'secret', payload: pMissingCfg as any });
    const socketMissingCfg = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: `/voice/media?token=${encodeURIComponent(missingCfgToken)}` } as any, socket: socketMissingCfg, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socketMissingCfg)).toContain('404 Not Found');

    // Voice provider mismatch
    const pMismatch = { ...basePayload(), voiceProvider: 'other' };
    const mismatchToken = createSignedWsToken({ secret: 'secret', payload: pMismatch as any });
    const socketMismatch = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: `/voice/media?token=${encodeURIComponent(mismatchToken)}` } as any, socket: socketMismatch, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socketMismatch)).toContain('401 Unauthorized');

    // Missing voiceProvider (nullish coalescing branch)
    const pMissingProvider = { ...basePayload(), callConfigId: 'cfg_undef', voiceProvider: 'p1' };
    const missingProviderToken = createSignedWsToken({ secret: 'secret', payload: pMissingProvider as any });
    const socketMissingProvider = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: `/voice/media?token=${encodeURIComponent(missingProviderToken)}` } as any, socket: socketMissingProvider, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socketMissingProvider)).toContain('401 Unauthorized');
  });

  test('rejects new upgrades while draining', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    await reg.close();

    const socket = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: '/voice/media?token=bad' } as any, socket, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socket)).toContain('503 Service Unavailable');
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('tokenFromMessageTimeoutMs falls back for invalid config values', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const common = {
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    };

    const regA = await createVoiceServerRegistration({
      ...common,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: 'nope' } } } }
    });
    await regA.close();

    const regB = await createVoiceServerRegistration({
      ...common,
      httpConfig: { extensions: { voice: { mediaWs: { tokenFromMessageTimeoutMs: -1 } } } }
    });
    await regB.close();
  });

  test('gracefully handles early errors before reserving pending capacity', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const socket = makeSocket();
    const req = {
      get url() {
        throw new Error('boom');
      }
    } as any;

    await expect(reg.handleUpgrade({ req, socket, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socket)).toContain('500 Internal Server Error');
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('throws on invalid media WS env var config', async () => {
    process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES = '0';
    await expect(
      createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store: createInMemoryVoiceCallConfigStore(),
        providerPlugins: { getCompat: jest.fn() } as any
      })
    ).rejects.toThrow('Invalid LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES');

    process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES = '1';
    process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS = 'nope';
    await expect(
      createVoiceServerRegistration({
        server: {} as any,
        registry: {},
        pluginsPath: './plugins',
        upgradeRouter: {} as any,
        store: createInMemoryVoiceCallConfigStore(),
        providerPlugins: { getCompat: jest.fn() } as any
      })
    ).rejects.toThrow('Invalid LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS');
  });

  test('unexpected upgrade errors return 500 and do not hang', async () => {
    const store: any = {
      putConfig: jest.fn(async () => {}),
      getConfig: jest.fn(async () => null),
      deleteConfig: jest.fn(async () => {}),
      putIdempotency: jest.fn(async () => {}),
      getIdempotency: jest.fn(async () => null),
      consumeNonceOnce: jest.fn(async () => {
        throw new Error('boom');
      })
    };

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createSignedWsToken({
      secret: 'secret',
      payload: {
        iat: nowSeconds,
        exp: nowSeconds + 60,
        nonce: 'n1',
        purpose: 'voice_media',
        callConfigId: 'cfg_1',
        voiceProvider: 'p1'
      } as any
    });

    const socket = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: `/voice/media?token=${encodeURIComponent(token)}` } as any, socket, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socket)).toContain('500 Internal Server Error');
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('unexpected upgrade errors before pending reservation return 500', async () => {
    delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;

    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store: createInMemoryVoiceCallConfigStore(),
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const socket = makeSocket();
    await expect(reg.handleUpgrade({ req: { url: '/voice/media' } as any, socket, head: Buffer.alloc(0), pathname: '/voice/media' })).resolves.toBe(true);
    expect(extractStatusLine(socket)).toContain('500 Internal Server Error');
    expect(socket.destroy).toHaveBeenCalled();
  });
});
