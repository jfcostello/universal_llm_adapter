import { jest } from '@jest/globals';

function createMockLogger() {
  const logger: any = {
    withCorrelation: () => logger,
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    logLLMRequest: jest.fn(),
    logLLMResponse: jest.fn(),
    close: jest.fn(async () => {})
  };
  return logger;
}

describe('modules/signals', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns noop deps when disabled by defaults', async () => {
    const { createSignalsDeps } = await import('@/modules/signals/index.ts');

    const registry = {
      getSignalsProvider: jest.fn(),
      getSignalsCompat: jest.fn()
    };

    const deps = await createSignalsDeps(registry as any);
    expect(deps.isEnabled()).toBe(false);
    expect(registry.getSignalsProvider).not.toHaveBeenCalled();
    expect(registry.getSignalsCompat).not.toHaveBeenCalled();
  });

  test('disables with a warning when enabled but no targets configured', async () => {
    const { createSignalsDeps } = await import('@/modules/signals/index.ts');
    const logger = createMockLogger();

    const registry = {
      getSignalsProvider: jest.fn(),
      getSignalsCompat: jest.fn()
    };

    const deps = await createSignalsDeps(registry as any, { enabled: true } as any, logger as any);
    expect(deps.isEnabled()).toBe(false);
    expect(logger.warning).toHaveBeenCalledWith(
      'Signals disabled: no targets configured',
      expect.objectContaining({ targets: [] })
    );
  });

  test('enables via env vars and fans out to multiple targets', async () => {
    process.env.LLM_ADAPTER_SIGNALS_ENABLED = '1';
    process.env.LLM_ADAPTER_SIGNALS_TARGETS = 'a,b';

    const { createSignalsDeps } = await import('@/modules/signals/index.ts');

    const compatA = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map([['env-a', 0]]) })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };
    const compatB = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map([['env-b', 0]]) })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const registry: any = {
      getSignalsProvider: jest.fn(async (id: string) => ({
        id,
        compat: id,
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      })),
      getSignalsCompatForProvider: jest.fn(async (id: string) => (id === 'a' ? compatA : compatB))
    };

    const deps = await createSignalsDeps(registry as any, undefined, createMockLogger() as any);
    expect(deps.isEnabled()).toBe(true);

    const exporter: any = deps.getExporter();
    exporter.recordSignal({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 1704067200000,
      level: 'error',
      message: 'boom',
      metadata: { api_key: 'secret' }
    });

    await exporter.flush();

    expect(compatA.buildBatch).toHaveBeenCalledTimes(1);
    expect(compatB.buildBatch).toHaveBeenCalledTimes(1);

    await deps.shutdown();
  });

  test('supports JSON targets via env and uses registry.getSignalsCompat when compatForProvider is unavailable', async () => {
    process.env.LLM_ADAPTER_SIGNALS_ENABLED = 'true';
    process.env.LLM_ADAPTER_SIGNALS_TARGETS = JSON.stringify([
      { provider: 'a' },
      { provider: 'b', providerConfig: { foo: 'bar' } }
    ]);

    const { createSignalsDeps } = await import('@/modules/signals/index.ts');

    const compat = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map([['env', 0]]) })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const registry: any = {
      getSignalsProvider: jest.fn(async (id: string) => ({
        id,
        compat: `compat-${id}`,
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      })),
      getSignalsCompat: jest.fn(async (_compatName: string) => compat)
    };

    const deps = await createSignalsDeps(registry as any, undefined, createMockLogger() as any);
    expect(deps.isEnabled()).toBe(true);

    const exporter: any = deps.getExporter();
    exporter.recordSignal({ traceId: 't', generationId: 'g', timestampMs: 0, level: 'info', message: 'ok' });
    await exporter.flush();

    expect(registry.getSignalsCompat).toHaveBeenCalled();
    expect(compat.buildBatch).toHaveBeenCalledTimes(2);

    await deps.shutdown();
  });

  test('sanitizes per-call exporter tuning overrides (clamps to safe ranges)', async () => {
    const { createSignalsDeps } = await import('@/modules/signals/index.ts');

    const compat = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map([['env', 0]]) })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const registry: any = {
      getSignalsProvider: jest.fn(async (_id: string) => ({
        id: 'a',
        compat: 'compat-a',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      })),
      getSignalsCompat: jest.fn(async () => compat)
    };

    const deps = await createSignalsDeps(registry as any, {
      enabled: true,
      targets: [{ provider: 'a' }],
      flushAt: 0,
      flushIntervalMs: -1,
      maxQueueSize: 0,
      maxAttempts: 999,
      baseDelayMs: -5,
      maxDelayMs: 999999999,
      timeoutMs: 'not-a-number' as any,
      maxAttributeValueBytes: 0
    } as any);

    const exporter: any = deps.getExporter();
    const targetExporters = exporter.exporters as any[];
    expect(targetExporters.length).toBe(1);

    const targetExporter = targetExporters[0];
    expect(targetExporter.config.flushAt).toBe(1);
    expect(targetExporter.config.maxQueueSize).toBe(1);
    expect(targetExporter.config.flushIntervalMs).toBe(250);
    expect(targetExporter.config.maxAttempts).toBe(20);
    expect(targetExporter.config.baseDelayMs).toBe(0);
    expect(targetExporter.config.maxDelayMs).toBe(300000);
    expect(targetExporter.config.timeoutMs).toBe(10000);
    expect(targetExporter.config.maxAttributeValueBytes).toBe(256);

    await deps.shutdown();
  });

  test('logs and disables when all targets fail to initialize', async () => {
    const { createSignalsDeps } = await import('@/modules/signals/index.ts');
    const logger = createMockLogger();

    const registry: any = {
      getSignalsProvider: jest.fn(async (id: string) => {
        if (id === 'a') throw new Error('boom');
        throw undefined;
      }),
      getSignalsCompat: jest.fn()
    };

    const deps = await createSignalsDeps(
      registry,
      { enabled: true, targets: [{ provider: 'a' }, { provider: 'b' }] } as any,
      logger as any
    );

    expect(deps.isEnabled()).toBe(false);
    expect(logger.warning).toHaveBeenCalledWith(
      'Signals target failed to initialize',
      expect.objectContaining({ provider: 'a', error: 'boom' })
    );
    expect(logger.warning).toHaveBeenCalledWith(
      'Signals target failed to initialize',
      expect.objectContaining({ provider: 'b', error: 'undefined' })
    );
  });

  test('includes per-target shutdown reasons when recording after a target is shut down', async () => {
    const { createSignalsDeps } = await import('@/modules/signals/index.ts');

    const compatA = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map([['env-a', 0]]) })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };
    const compatB = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map([['env-b', 0]]) })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const registry: any = {
      getSignalsProvider: jest.fn(async (id: string) => ({
        id,
        compat: id,
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      })),
      getSignalsCompatForProvider: jest.fn(async (id: string) => (id === 'a' ? compatA : compatB))
    };

    const deps = await createSignalsDeps(registry as any, {
      enabled: true,
      targets: [{ provider: 'a' }, { provider: 'b' }],
      flushAt: 9999,
      flushIntervalMs: 60000
    } as any, createMockLogger() as any);

    const exporter: any = deps.getExporter();
    await exporter.exporters[0].shutdown();

    const result1 = exporter.recordSignal({
      traceId: 'trace-1',
      generationId: 'gen-1',
      timestampMs: 0,
      level: 'error',
      message: 'boom'
    });

    expect(result1.queued).toBe(true);
    expect(result1.reason).toBeUndefined();
    expect(result1.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'a', queued: false, reason: 'shutdown' }),
        expect.objectContaining({ target: 'b', queued: true })
      ])
    );

    await exporter.exporters[1].shutdown();

    const result2 = exporter.recordSignal({
      traceId: 'trace-2',
      generationId: 'gen-2',
      timestampMs: 0,
      level: 'error',
      message: 'boom'
    });

    expect(result2.queued).toBe(false);
    expect(result2.reason).toBe('shutdown');
    expect(result2.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'a', queued: false, reason: 'shutdown' }),
        expect.objectContaining({ target: 'b', queued: false, reason: 'shutdown' })
      ])
    );

    await deps.shutdown();
  });

  test('resolveConfig tolerates invalid target shapes and env JSON parse failures', async () => {
    const { resolveConfig } = await import('@/modules/signals/internal/signals/internal/config.ts');
    const { getDefaults } = await import('@/kernel/index.ts');

    // Default logger param + non-array targets input
    expect(resolveConfig({ enabled: true, targets: {} as any } as any, getDefaults().signals)).toBeNull();

    // Invalid provider shapes are filtered out
    const cfg = resolveConfig(
      { enabled: true, targets: [{ provider: 123 } as any, { provider: 'ok' }] } as any,
      getDefaults().signals,
      createMockLogger() as any
    );
    expect(cfg?.targets).toEqual([{ provider: 'ok' }]);

    // JSON parse failure falls back to CSV, and defaults maxAttributeValueBytes fallback works when omitted
    process.env.LLM_ADAPTER_SIGNALS_TARGETS = '[a,b';
    const cfg2 = resolveConfig(
      { enabled: true } as any,
      { ...getDefaults().signals, maxAttributeValueBytes: undefined } as any,
      createMockLogger() as any
    );
    expect(cfg2?.targets.length).toBe(2);
    expect(cfg2?.maxAttributeValueBytes).toBe(16384);
  });
});
