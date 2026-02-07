import { afterAll, beforeAll, describe, jest, test } from '@jest/globals';

type Derefable<T extends object> = { deref: () => T | undefined };

describe('modules/observability exporter runtime registry tracking', () => {
  const originalWeakRef = (globalThis as any).WeakRef as unknown;

  class FakeWeakRef<T extends object> implements Derefable<T> {
    private target: any;

    constructor(target: any) {
      this.target = target;
    }

    deref(): T | undefined {
      if (Object.prototype.hasOwnProperty.call(this.target, '__derefValue')) {
        return this.target.__derefValue as T | undefined;
      }
      return this.target as T;
    }
  }

  beforeAll(() => {
    (globalThis as any).WeakRef = FakeWeakRef;
  });

  afterAll(() => {
    (globalThis as any).WeakRef = originalWeakRef;
  });

  test('reuses providerConfig cache key material for repeated calls with the same object', async () => {
    jest.resetModules();

    const { getOrCreateSharedExporter, shutdownAllExporters } = await import(
      '@/modules/observability/internal/exporter/internal/runtime.ts'
    );

    const compat: any = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const manifest: any = {
      id: 'test-observability',
      compat: 'test-observability',
      endpoint: { urlTemplate: 'http://test', method: 'POST', headers: {} }
    };

    const registry: any = {
      getObservabilityProvider: jest.fn(async () => manifest),
      getObservabilityCompat: jest.fn(async () => compat)
    };

    let getterHits = 0;
    const providerConfig: Record<string, unknown> = {};
    Object.defineProperty(providerConfig, 'expensive', {
      enumerable: true,
      get() {
        getterHits += 1;
        return { nested: 'value' };
      }
    });

    const config: any = {
      provider: 'test-observability',
      providerConfig,
      flushAt: 10,
      flushIntervalMs: 60_000,
      maxQueueSize: 10,
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      timeoutMs: 1000,
      maxAttributeValueBytes: 1024
    };

    const exporter1 = await getOrCreateSharedExporter(registry, config);
    const exporter2 = await getOrCreateSharedExporter(registry, config);

    expect(exporter1).toBe(exporter2);
    expect(getterHits).toBe(1);

    await shutdownAllExporters();
  });

  test('prunes dead registry refs and tolerates missing runtimes', async () => {
    jest.resetModules();

    const { getOrCreateSharedExporter, shutdownAllExporters } = await import(
      '@/modules/observability/internal/exporter/internal/runtime.ts'
    );

    const compat: any = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const manifest: any = {
      id: 'test-observability',
      compat: 'test-observability',
      endpoint: { urlTemplate: 'http://test', method: 'POST', headers: {} }
    };

    const config: any = {
      provider: 'test-observability',
      flushAt: 10,
      flushIntervalMs: 60_000,
      maxQueueSize: 10,
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      timeoutMs: 1000,
      maxAttributeValueBytes: 1024
    };

    const createRegistry = (options: { setDerefValue?: boolean; derefValue?: unknown } = {}): any => {
      const registry: any = {
        getObservabilityProvider: jest.fn(async () => manifest),
        getObservabilityCompat: jest.fn(async () => compat)
      };

      if (options.setDerefValue) {
        registry.__derefValue = options.derefValue;
      }

      return registry;
    };

    // Seed a dead ref that should be removed once the registry ref set grows large enough.
    const deadBeforePrune = createRegistry({ setDerefValue: true, derefValue: undefined });
    const deadBeforePruneExporter = await getOrCreateSharedExporter(deadBeforePrune, config);

    // Seed a ref that dereferences to a different object (runtimeByRegistry miss).
    const dummyRuntimeKey: any = {};
    const missingRuntimeRegistry = createRegistry({ setDerefValue: true, derefValue: dummyRuntimeKey });
    const missingRuntimeExporter = await getOrCreateSharedExporter(missingRuntimeRegistry, config);

    // Add enough unique registries to trigger the runtime registry pruning path.
    for (let i = 0; i < 999; i++) {
      const registry = createRegistry();
      await getOrCreateSharedExporter(registry, config);
    }

    // Add one more dead ref after pruning runs, to exercise shutdown skipping.
    const deadAfterPrune = createRegistry({ setDerefValue: true, derefValue: undefined });
    const deadAfterPruneExporter = await getOrCreateSharedExporter(deadAfterPrune, config);

    await shutdownAllExporters();

    await Promise.all([
      Promise.resolve().then(() => deadBeforePruneExporter.shutdown()).catch(() => {}),
      Promise.resolve().then(() => missingRuntimeExporter.shutdown()).catch(() => {}),
      Promise.resolve().then(() => deadAfterPruneExporter.shutdown()).catch(() => {})
    ]);
  });

  test('re-tracks registries after shutdown so subsequent shutdowns include recreated exporters', async () => {
    jest.resetModules();

    const { getOrCreateSharedExporter, shutdownAllExporters } = await import(
      '@/modules/observability/internal/exporter/internal/runtime.ts'
    );

    const compat: any = {
      buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
      sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
    };

    const manifest: any = {
      id: 'test-observability',
      compat: 'test-observability',
      endpoint: { urlTemplate: 'http://test', method: 'POST', headers: {} }
    };

    const registry: any = {
      getObservabilityProvider: jest.fn(async () => manifest),
      getObservabilityCompat: jest.fn(async () => compat)
    };

    const config: any = {
      provider: 'test-observability',
      flushAt: 10,
      flushIntervalMs: 60_000,
      maxQueueSize: 10,
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      timeoutMs: 1000,
      maxAttributeValueBytes: 1024
    };

    await getOrCreateSharedExporter(registry, config);
    await shutdownAllExporters();

    const recreated = await getOrCreateSharedExporter(registry, config);
    const shutdownSpy = jest.spyOn(recreated, 'shutdown');

    await shutdownAllExporters();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });
});
