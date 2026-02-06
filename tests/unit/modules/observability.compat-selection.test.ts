import { createObservabilityDeps } from '@/modules/observability/index.ts';
import { jest } from '@jest/globals';

describe('modules/observability (compat selection)', () => {
  test('createObservabilityDeps prefers getObservabilityCompatForProvider when available', async () => {
    const mockCompat = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const mockManifest = {
      id: 'test',
      compat: 'test-compat',
      endpoint: { urlTemplate: 'http://test', method: 'POST' }
    };

    const registry = {
      getObservabilityProvider: jest.fn(async () => mockManifest),
      getObservabilityCompatForProvider: jest.fn(async () => mockCompat),
      getObservabilityCompat: jest.fn(async () => mockCompat)
    };

    const deps = await createObservabilityDeps(registry as any, {
      enabled: true,
      provider: 'test',
      sampleRate: 1
    } as any);

    expect(deps.isEnabled()).toBe(true);
    expect(registry.getObservabilityCompatForProvider).toHaveBeenCalledWith('test');
    expect(registry.getObservabilityCompat).not.toHaveBeenCalled();

    await deps.shutdown();
  });

  test('createObservabilityDeps initializes one exporter per target when targets are provided', async () => {
    const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

    const mockCompatA = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const mockCompatB = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const mockManifestA = {
      id: 'provider-a',
      compat: 'compat-a',
      endpoint: { urlTemplate: 'http://a', method: 'POST' }
    };

    const mockManifestB = {
      id: 'provider-b',
      compat: 'compat-b',
      endpoint: { urlTemplate: 'http://b', method: 'POST' }
    };

    const registry = {
      getObservabilityProvider: jest.fn(async (id: string) => (id === 'provider-a' ? mockManifestA : mockManifestB)),
      getObservabilityCompatForProvider: jest.fn(async (id: string) => (id === 'provider-a' ? mockCompatA : mockCompatB)),
      getObservabilityCompat: jest.fn(async () => {
        throw new Error('Unexpected getObservabilityCompat call');
      })
    };

    const deps = await createObservabilityDeps(registry as any, {
      enabled: true,
      targets: [{ provider: 'provider-a' }, { provider: 'provider-b' }]
    } as any);

    expect(deps.isEnabled()).toBe(true);
    expect(registry.getObservabilityProvider).toHaveBeenCalledWith('provider-a');
    expect(registry.getObservabilityProvider).toHaveBeenCalledWith('provider-b');
    expect(registry.getObservabilityCompatForProvider).toHaveBeenCalledWith('provider-a');
    expect(registry.getObservabilityCompatForProvider).toHaveBeenCalledWith('provider-b');

    await deps.shutdown();
  });

  test('createObservabilityDeps enforces export routing for a single target', async () => {
    const mockCompat = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const mockManifest = {
      id: 'provider-a',
      compat: 'compat-a',
      endpoint: { urlTemplate: 'http://a', method: 'POST' }
    };

    const registry = {
      getObservabilityProvider: jest.fn(async () => mockManifest),
      getObservabilityCompatForProvider: jest.fn(async () => mockCompat),
      getObservabilityCompat: jest.fn(async () => {
        throw new Error('Unexpected getObservabilityCompat call');
      })
    };

    const deps = await createObservabilityDeps(registry as any, {
      enabled: true,
      targets: [{
        provider: 'provider-a',
        export: { traces: true, tools: true, signals: false, traceUpdates: true }
      }]
    } as any);

    const exporter = deps.getExporter() as any;
    const llmResult = exporter.recordLLMRequest({
      type: 'llm_request',
      traceId: 'trace-1',
      timestampMs: Date.now(),
      provider: 'provider-a',
      model: 'test',
      messages: []
    });
    const signalResult = exporter.recordSignal({
      type: 'signal',
      traceId: 'trace-1',
      timestampMs: Date.now(),
      level: 'info',
      message: 'ignored',
      source: 'adapter'
    });

    expect(llmResult.queued).toBe(true);
    expect(signalResult).toEqual({ eventId: '', queued: false, reason: 'disabled' });

    await deps.shutdown();
  });

  test('createObservabilityDeps logs multi-target init failures without single-provider field', async () => {
    const logger: any = {
      withCorrelation: () => logger,
      debug: jest.fn(),
      info: jest.fn(),
      warning: jest.fn(),
      error: jest.fn()
    };

    const registry = {
      getObservabilityProvider: jest.fn(async () => {
        throw new Error('boom');
      }),
      getObservabilityCompatForProvider: jest.fn(async () => {
        throw new Error('boom');
      }),
      getObservabilityCompat: jest.fn(async () => {
        throw new Error('boom');
      })
    };

    const deps = await createObservabilityDeps(
      registry as any,
      { enabled: true, targets: [{ provider: 'a' }, { provider: 'b' }] } as any,
      logger
    );

    expect(deps.isEnabled()).toBe(false);
    expect(logger.warning).toHaveBeenCalledWith(
      'Observability failed to initialize',
      expect.objectContaining({ providers: ['a', 'b'], error: 'boom' })
    );

    const payload = (logger.warning as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, 'provider')).toBe(false);
  });
});
