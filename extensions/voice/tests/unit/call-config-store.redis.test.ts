import { jest } from '@jest/globals';

import { createRedisVoiceCallConfigStore } from '../../internal/call-config-store/index.js';

type FakeRedisEntry = { value: string; expiresAtMs?: number };

function createFakeRedisClient() {
  const data = new Map<string, FakeRedisEntry>();

  const getEntry = (key: string): FakeRedisEntry | undefined => {
    const entry = data.get(key);
    if (!entry) return undefined;
    if (typeof entry.expiresAtMs === 'number' && Date.now() > entry.expiresAtMs) {
      data.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    get: async (key: string) => getEntry(key)?.value ?? null,
    set: async (key: string, value: string, options?: { EX?: number; NX?: boolean }) => {
      const existing = getEntry(key);
      if (options?.NX && existing) return null;
      const ttlSeconds = options?.EX;
      const expiresAtMs = typeof ttlSeconds === 'number' ? Date.now() + ttlSeconds * 1000 : undefined;
      data.set(key, { value, ...(expiresAtMs ? { expiresAtMs } : {}) });
      return 'OK';
    },
    del: async (key: string) => (data.delete(key) ? 1 : 0)
  };
}

describe('extensions/voice: call-config store (redis)', () => {
  test('uses default prefix when omitted', async () => {
    const client = createFakeRedisClient();
    const store = createRedisVoiceCallConfigStore({ client: client as any });

    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_default_prefix',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: { ok: true },
        voiceProvider: 'p1'
      },
      { ttlSeconds: 60 }
    );

    expect(await store.getConfig('cfg_default_prefix')).not.toBeNull();
  });

  test('put/get/delete round-trip', async () => {
    const client = createFakeRedisClient();
    const store = createRedisVoiceCallConfigStore({ client: client as any, prefix: 't:' });

    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        systemPrompt: 'hello',
        realtimeSpec: { a: 1 },
        voiceProvider: 'p1'
      },
      { ttlSeconds: 60 }
    );

    expect(await store.getConfig('cfg_1')).toEqual(expect.objectContaining({ callConfigId: 'cfg_1', systemPrompt: 'hello' }));

    await store.deleteConfig('cfg_1');
    expect(await store.getConfig('cfg_1')).toBeNull();
  });

  test('TTL expiry drops configs', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    try {
      const client = createFakeRedisClient();
      const store = createRedisVoiceCallConfigStore({ client: client as any, prefix: 't:' });

      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_ttl',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'inbound',
          realtimeSpec: { ok: true },
          voiceProvider: 'p1'
        },
        { ttlSeconds: 1 }
      );

      expect(await store.getConfig('cfg_ttl')).not.toBeNull();
      jest.advanceTimersByTime(1001);
      expect(await store.getConfig('cfg_ttl')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('idempotency mapping + TTL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    try {
      const client = createFakeRedisClient();
      const store = createRedisVoiceCallConfigStore({ client: client as any, prefix: 't:' });

      expect(await store.getIdempotency('k1')).toBeNull();
      await store.putIdempotency('k1', { ok: true }, { ttlSeconds: 1 });
      expect(await store.getIdempotency('k1')).toEqual({ ok: true });

      jest.advanceTimersByTime(1001);
      expect(await store.getIdempotency('k1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('consumeNonceOnce is atomic consume-once', async () => {
    const client = createFakeRedisClient();
    const store = createRedisVoiceCallConfigStore({ client: client as any, prefix: 't:' });

    expect(await store.consumeNonceOnce('n1', { ttlSeconds: 60 })).toBe(true);
    expect(await store.consumeNonceOnce('n1', { ttlSeconds: 60 })).toBe(false);
  });

  test('validates inputs', async () => {
    const client = createFakeRedisClient();
    const store = createRedisVoiceCallConfigStore({ client: client as any, prefix: 't:' });

    await expect((store as any).getConfig('')).rejects.toThrow('callConfigId');
    await expect((store as any).putIdempotency('', { ok: true }, { ttlSeconds: 1 })).rejects.toThrow('idempotency key');
    await expect((store as any).consumeNonceOnce('', { ttlSeconds: 1 })).rejects.toThrow('nonce');
    await expect((store as any).putConfig(
      {
        version: 1,
        callConfigId: 'cfg',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'p1'
      },
      { ttlSeconds: 0 }
    )).rejects.toThrow('ttlSeconds');
  });
});
