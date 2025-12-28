import { jest } from '@jest/globals';

describe('extensions/voice: call-config store (from-env)', () => {
  const prevStore = process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE;
  const prevRedisUrl = process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL;
  const prevRedisPrefix = process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

  afterEach(() => {
    if (prevStore === undefined) delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE;
    else process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = prevStore;

    if (prevRedisUrl === undefined) delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL;
    else process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL = prevRedisUrl;

    if (prevRedisPrefix === undefined) delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;
    else process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX = prevRedisPrefix;

    jest.resetModules();
  });

  test('defaults to in-memory when store env var is unset', async () => {
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE;
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL;
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    const res = await createVoiceCallConfigStoreFromEnv();

    expect(res.kind).toBe('memory');
    expect(res.close).toBeUndefined();

    await res.store.putConfig(
      {
        version: 1,
        callConfigId: 'cfg_1',
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

    expect(await res.store.getConfig('cfg_1')).toEqual(expect.objectContaining({ callConfigId: 'cfg_1' }));
  });

  test('accepts in-memory aliases for store kind', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'in-memory';
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL;
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    const res = await createVoiceCallConfigStoreFromEnv();

    expect(res.kind).toBe('memory');
  });

  test('throws when store kind is invalid', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'nope';
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL;
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    await expect(createVoiceCallConfigStoreFromEnv()).rejects.toThrow('Invalid LLM_ADAPTER_VOICE_CALL_CONFIG_STORE');
  });

  test('redis store requires redis URL env var', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'redis';
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL;
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    await expect(createVoiceCallConfigStoreFromEnv()).rejects.toThrow('Missing LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL');
  });

  test('creates redis store via redis.createClient() and closes with quit()', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'redis';
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL = 'redis://example.test:6379';
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX = 't:';

    const connect = jest.fn(async () => {});
    const quit = jest.fn(async () => {});
    const on = jest.fn();
    const fakeClient: any = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => 'OK'),
      del: jest.fn(async () => 0),
      on,
      connect,
      quit
    };

    const createClient = jest.fn(() => fakeClient);
    (jest as any).unstable_mockModule('redis', () => ({ createClient }));

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    const res = await createVoiceCallConfigStoreFromEnv();

    expect(res.kind).toBe('redis');
    expect(createClient).toHaveBeenCalledWith({ url: 'redis://example.test:6379' });
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(connect).toHaveBeenCalled();
    const onErrorHandler = on.mock.calls[0]?.[1];
    expect(typeof onErrorHandler).toBe('function');
    onErrorHandler(new Error('boom'));

    await res.store.putIdempotency('k1', { ok: true }, { ttlSeconds: 60 });
    expect(fakeClient.set).toHaveBeenCalled();
    expect(String(fakeClient.set.mock.calls[0][0])).toContain('t:idem:');

    await expect(res.close?.()).resolves.toBeUndefined();
    expect(quit).toHaveBeenCalled();
  });

  test('uses default export createClient and closes with disconnect() when quit is unavailable', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'redis';
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL = 'redis://example.test:6379';
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    const disconnect = jest.fn();
    const fakeClient: any = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => 'OK'),
      del: jest.fn(async () => 0),
      connect: jest.fn(async () => {}),
      disconnect
    };

    const createClient = jest.fn(() => fakeClient);
    (jest as any).unstable_mockModule('redis', () => ({ default: { createClient } }));

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    const res = await createVoiceCallConfigStoreFromEnv();

    expect(res.kind).toBe('redis');

    await res.store.putConfig(
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
    expect(fakeClient.set).toHaveBeenCalled();
    expect(String(fakeClient.set.mock.calls[0][0])).toContain('llm_adapter:voice:v1:cfg:');

    await res.close?.();
    expect(disconnect).toHaveBeenCalled();
  });

  test('close is a no-op when disconnect is unavailable', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'redis';
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL = 'redis://example.test:6379';
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    const fakeClient: any = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => 'OK'),
      del: jest.fn(async () => 0),
      connect: jest.fn(async () => {})
    };

    const createClient = jest.fn(() => fakeClient);
    (jest as any).unstable_mockModule('redis', () => ({ createClient }));

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    const res = await createVoiceCallConfigStoreFromEnv();

    await expect(res.close?.()).resolves.toBeUndefined();
  });

  test('throws when redis module does not export createClient', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'redis';
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL = 'redis://example.test:6379';
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    (jest as any).unstable_mockModule('redis', () => ({}));

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    await expect(createVoiceCallConfigStoreFromEnv()).rejects.toThrow('Redis client library does not export createClient()');
  });

  test('throws when redis client is missing connect()', async () => {
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_STORE = 'redis';
    process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_URL = 'redis://example.test:6379';
    delete process.env.LLM_ADAPTER_VOICE_CALL_CONFIG_REDIS_PREFIX;

    const createClient = jest.fn(() => ({ on: jest.fn() }));
    (jest as any).unstable_mockModule('redis', () => ({ createClient }));

    const { createVoiceCallConfigStoreFromEnv } = await import('../../internal/call-config-store/index.js');
    await expect(createVoiceCallConfigStoreFromEnv()).rejects.toThrow('Redis client missing connect()');
  });
});
