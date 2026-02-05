import { jest } from '@jest/globals';

function createMockLogger() {
  return {
    withCorrelation: () => createMockLogger(),
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn()
  } as any;
}

describe('modules/observability target resolution', () => {
  test('resolveConfig coerces numeric strings and clamps bounds', async () => {
    const { resolveConfig } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    const config = resolveConfig({
      enabled: true,
      provider: 'spec-provider',
      maxQueueSize: '5',
      flushAt: '999',
      flushIntervalMs: '10',
      maxAttempts: '99',
      timeoutMs: '10',
      maxAttributeValueBytes: '10'
    } as any, defaults, logger);

    expect(config?.provider).toBe('spec-provider');
    expect(config?.maxQueueSize).toBe(5);
    expect(config?.flushAt).toBe(5);
    expect(config?.flushIntervalMs).toBe(250);
    expect(config?.maxAttempts).toBe(20);
    expect(config?.timeoutMs).toBe(250);
    expect(config?.maxAttributeValueBytes).toBe(256);
    expect(logger.warning).toHaveBeenCalledTimes(0);
  });

  test('resolveConfig returns null when disabled', async () => {
    const { resolveConfig } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    expect(resolveConfig({ enabled: false } as any, defaults, logger)).toBeNull();
    expect(logger.warning).toHaveBeenCalledTimes(0);
  });

  test('resolveConfig uses defaults when spec is omitted', async () => {
    const { resolveConfig } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    const config = resolveConfig(undefined, defaults, logger);
    expect(config?.provider).toBe('default-provider');
    expect(logger.warning).toHaveBeenCalledTimes(0);
  });

  test('resolveTargets returns null when disabled', async () => {
    const { resolveTargets } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: false,
      provider: 'x',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    expect(resolveTargets(undefined, defaults, logger)).toBeNull();
    expect(logger.warning).toHaveBeenCalledTimes(0);
  });

  test('resolveTargets falls back to single provider config when targets are not provided', async () => {
    const { resolveTargets } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    const targets = resolveTargets({ enabled: true, provider: 'spec-provider' } as any, defaults, logger);
    expect(targets).toBeTruthy();
    expect(targets?.length).toBe(1);
    expect(targets?.[0]?.provider).toBe('spec-provider');
    expect(targets?.[0]?.export).toEqual({ traces: true, tools: true, signals: true, traceUpdates: true });
  });

  test('resolveTargets uses defaults.targets when spec does not provide provider or targets', async () => {
    const { resolveTargets } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      targets: [{ provider: 'p1', export: { traces: false } }, { provider: 'p2' }],
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    const targets = resolveTargets({ enabled: true } as any, defaults, logger);

    expect(targets?.map(t => t.provider)).toEqual(['p1', 'p2']);
    expect(targets?.[0]?.export).toEqual({ traces: false, tools: true, signals: true, traceUpdates: true });
    expect(targets?.[1]?.export).toEqual({ traces: true, tools: true, signals: true, traceUpdates: true });
  });

  test('resolveTargets prefers spec.provider over defaults.targets when targets are not provided', async () => {
    const { resolveTargets } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      targets: [{ provider: 'p1' }, { provider: 'p2' }],
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    const targets = resolveTargets({ enabled: true, provider: 'spec-provider' } as any, defaults, logger);
    expect(targets?.length).toBe(1);
    expect(targets?.[0]?.provider).toBe('spec-provider');
  });

  test('resolveTargets keeps providerConfig objects and falls back maxAttributeValueBytes', async () => {
    const { resolveTargets } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000
    };

    const targets = resolveTargets(
      {
        enabled: true,
        targets: [{ provider: 'p1', providerConfig: { hello: 'world' } }]
      } as any,
      defaults,
      logger
    );

    expect(targets?.length).toBe(1);
    expect(targets?.[0]?.provider).toBe('p1');
    expect(targets?.[0]?.config?.providerConfig).toEqual({ hello: 'world' });
    expect(targets?.[0]?.config?.maxAttributeValueBytes).toBe(16384);
  });

  test('resolveTargets filters invalid targets and normalizes per-target overrides', async () => {
    const { resolveTargets } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    const targets = resolveTargets(
      {
        enabled: true,
        // global overrides should apply when the target omits its own
        flushAt: '9',
        maxQueueSize: '10',
        timeoutMs: Number.POSITIVE_INFINITY,
        targets: [
          { provider: '' },
          { provider: 123 },
          {
            provider: 'p1',
            providerConfig: 'not-an-object',
            export: { traces: false, tools: 'nope' }
          }
        ]
      } as any,
      defaults,
      logger
    );

    expect(targets?.length).toBe(1);
    expect(targets?.[0]?.provider).toBe('p1');
    expect(targets?.[0]?.config?.maxQueueSize).toBe(10);
    expect(targets?.[0]?.config?.flushAt).toBe(9);
    // timeoutMs uses defaults when given non-finite number
    expect(targets?.[0]?.config?.timeoutMs).toBe(defaults.timeoutMs);
    // providerConfig should be dropped when not an object
    expect(targets?.[0]?.config?.providerConfig).toBeUndefined();
    // export config normalizes non-boolean to fallback true
    expect(targets?.[0]?.export).toEqual({ traces: false, tools: true, signals: true, traceUpdates: true });
  });

  test('resolveTargets logs and returns null when targets are present but none are valid', async () => {
    const { resolveTargets } = await import('@/modules/observability/internal/exporter/internal/config.ts');
    const logger = createMockLogger();

    const defaults: any = {
      enabled: true,
      provider: 'default-provider',
      flushAt: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      timeoutMs: 10000,
      maxAttributeValueBytes: 16384
    };

    const targets = resolveTargets({ enabled: true, targets: [{ provider: '' }] } as any, defaults, logger);
    expect(targets).toBeNull();
    expect(logger.warning).toHaveBeenCalledWith(
      'Observability disabled: no valid targets configured',
      expect.objectContaining({ targets: 1 })
    );
  });
});
