import { jest } from '@jest/globals';

import { createInMemoryVoiceCallConfigStore } from '../../modules/call-config-store/index.js';

describe('extensions/voice: call-config store (in-memory)', () => {
  test('validates inputs', async () => {
    const store = createInMemoryVoiceCallConfigStore();

    await expect(
      store.putConfig(
        {
          version: 1,
          callConfigId: '',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'outbound',
          realtimeSpec: {},
          voiceProvider: 'p1'
        },
        { ttlSeconds: 60 }
      )
    ).rejects.toThrow('callConfigId');

    await expect(
      store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_bad_ttl',
          createdAtMs: 0,
          expiresAtMs: 0,
          to: 'to',
          from: 'from',
          direction: 'outbound',
          realtimeSpec: {},
          voiceProvider: 'p1'
        },
        { ttlSeconds: 0 }
      )
    ).rejects.toThrow('ttlSeconds');

    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_string_ttl',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        realtimeSpec: {},
        voiceProvider: 'p1'
      },
      { ttlSeconds: '1' as any }
    );

    await expect((store as any).getConfig(123)).rejects.toThrow('callConfigId');

    await store.putIdempotency('k_string_ttl', { ok: true }, { ttlSeconds: '1' as any });
    await expect((store as any).putIdempotency('', { ok: true }, { ttlSeconds: 1 })).rejects.toThrow('idempotency key');
    await expect((store as any).consumeNonceOnce('', { ttlSeconds: 1 })).rejects.toThrow('nonce');
  });

  test('put/get/delete round-trip', async () => {
    const store = createInMemoryVoiceCallConfigStore();

    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
        createdAtMs: 1,
        expiresAtMs: 2,
        to: '+15551234567',
        from: '+15557654321',
        direction: 'outbound',
        systemPrompt: 'hello',
        realtimeSpec: { a: 1 },
        voiceProvider: 'p1',
        metadata: { m: 'x' }
      },
      { ttlSeconds: 60 }
    );

    expect(await store.getConfig('cfg_1')).toEqual(
      expect.objectContaining({
        version: 1,
        callConfigId: 'cfg_1',
        to: '+15551234567',
        from: '+15557654321',
        direction: 'outbound',
        systemPrompt: 'hello',
        realtimeSpec: { a: 1 },
        voiceProvider: 'p1',
        metadata: { m: 'x' }
      })
    );

    await store.deleteConfig('cfg_1');
    expect(await store.getConfig('cfg_1')).toBeNull();
  });

  test('TTL expiry drops configs', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    try {
      const store = createInMemoryVoiceCallConfigStore();
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

  test('prunes expired entries without requiring direct reads', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const deleteSpy = jest.spyOn(Map.prototype, 'delete');
    try {
      const store = createInMemoryVoiceCallConfigStore({ sweepEveryOps: 1 });

      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_expired',
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
      await store.consumeNonceOnce('nonce_expired', { ttlSeconds: 1 });
      await store.putIdempotency('k_expired', { ok: true }, { ttlSeconds: 1 });

      jest.advanceTimersByTime(1001);

      // Trigger a sweep without reading the expired keys directly.
      await store.putIdempotency('k_trigger', { ok: true }, { ttlSeconds: 60 });

      const deletedKeys = deleteSpy.mock.calls.map(c => c[0]);
      expect(deletedKeys).toContain('cfg_expired');
      expect(deletedKeys).toContain('nonce_expired');
      expect(deletedKeys).toContain('k_expired');
    } finally {
      deleteSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('timer-based sweep prunes expired entries without ops', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const deleteSpy = jest.spyOn(Map.prototype, 'delete');
    try {
      const store = createInMemoryVoiceCallConfigStore({ sweepEveryOps: 1_000_000, sweepIntervalMs: 250 });

      await store.putConfig(
        {
          version: 1,
          callConfigId: 'cfg_expired',
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
      await store.consumeNonceOnce('nonce_expired', { ttlSeconds: 1 });
      await store.putIdempotency('k_expired', { ok: true }, { ttlSeconds: 1 });

      // Wait past TTL and allow the interval to run, without making further store calls.
      jest.advanceTimersByTime(1501);

      const deletedKeys = deleteSpy.mock.calls.map(c => c[0]);
      expect(deletedKeys).toContain('cfg_expired');
      expect(deletedKeys).toContain('nonce_expired');
      expect(deletedKeys).toContain('k_expired');

      expect(typeof (store as any).close).toBe('function');
      await (store as any).close();
    } finally {
      deleteSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('sweepIntervalMs <= 0 disables timer sweep', async () => {
    const store = createInMemoryVoiceCallConfigStore({ sweepEveryOps: 1, sweepIntervalMs: 0 });
    expect((store as any).close).toBeUndefined();
  });

  test('timer sweep uses unref when available and close clears interval', async () => {
    const unref = jest.fn();
    const timer = { unref } as any;

    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      const store = createInMemoryVoiceCallConfigStore({ sweepIntervalMs: 1 });
      expect(unref).toHaveBeenCalledTimes(1);

      expect(typeof (store as any).close).toBe('function');
      await (store as any).close();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  test('supports large payloads', async () => {
    const store = createInMemoryVoiceCallConfigStore();
    const big = 'x'.repeat(1024 * 1024);

    await store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_big',
        createdAtMs: 0,
        expiresAtMs: 0,
        to: 'to',
        from: 'from',
        direction: 'outbound',
        systemPrompt: big,
        realtimeSpec: { nested: { ok: true } },
        voiceProvider: 'p1'
      },
      { ttlSeconds: 60 }
    );

    const got = await store.getConfig('cfg_big');
    expect(got?.systemPrompt).toBe(big);
  });

  test('supports idempotency mapping + TTL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    try {
      const store = createInMemoryVoiceCallConfigStore();

      expect(await store.getIdempotency('k1')).toBeNull();
      await store.putIdempotency('k1', { callConfigId: 'cfg_1', providerCallId: 'pc_1' }, { ttlSeconds: 1 });

      expect(await store.getIdempotency('k1')).toEqual({ callConfigId: 'cfg_1', providerCallId: 'pc_1' });

      jest.advanceTimersByTime(1001);
      expect(await store.getIdempotency('k1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('consumeNonceOnce is consume-once with TTL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    try {
      const store = createInMemoryVoiceCallConfigStore();

      expect(await store.consumeNonceOnce('n1', { ttlSeconds: 1 })).toBe(true);
      expect(await store.consumeNonceOnce('n1', { ttlSeconds: 1 })).toBe(false);

      jest.advanceTimersByTime(1001);

      expect(await store.consumeNonceOnce('n1', { ttlSeconds: 1 })).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
