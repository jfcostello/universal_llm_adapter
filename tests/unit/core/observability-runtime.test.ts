import { jest } from '@jest/globals';

describe('modules/observability/internal/runtime', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('returns undefined when disabled by defaults', async () => {
    await jest.isolateModulesAsync(async () => {
      const createObservabilityDeps = jest.fn(() => ({
        isEnabled: () => true,
        getExporter: () => ({})
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/observability.js', () => ({
        createObservabilityDeps
      }));

      const { createObservabilityRuntime } = await import('@/modules/observability/internal/runtime.ts');

      await expect(createObservabilityRuntime({} as any)).resolves.toBeUndefined();
      expect(createObservabilityDeps).not.toHaveBeenCalled();
    });
  });

  test('returns undefined when sampleRate <= 0', async () => {
    await jest.isolateModulesAsync(async () => {
      const createObservabilityDeps = jest.fn(() => ({
        isEnabled: () => true,
        getExporter: () => ({})
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/observability.js', () => ({
        createObservabilityDeps
      }));

      const { createObservabilityRuntime } = await import('@/modules/observability/internal/runtime.ts');

      await expect(
        createObservabilityRuntime(
          {} as any,
          { enabled: true, sampleRate: 0 } as any
        )
      ).resolves.toBeUndefined();

      expect(createObservabilityDeps).not.toHaveBeenCalled();
    });
  });

  test('returns undefined when sampling excludes the call', async () => {
    await jest.isolateModulesAsync(async () => {
      const createObservabilityDeps = jest.fn(() => ({
        isEnabled: () => true,
        getExporter: () => ({})
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/observability.js', () => ({
        createObservabilityDeps
      }));

      jest.spyOn(Math, 'random').mockReturnValue(0.99);

      const { createObservabilityRuntime } = await import('@/modules/observability/internal/runtime.ts');

      await expect(
        createObservabilityRuntime(
          {} as any,
          { enabled: true, sampleRate: 0.25 } as any
        )
      ).resolves.toBeUndefined();

      expect(createObservabilityDeps).not.toHaveBeenCalled();
    });
  });

  test('returns undefined when observability deps are disabled', async () => {
    await jest.isolateModulesAsync(async () => {
      const exporter = { flush: jest.fn(async () => {}) };
      const createObservabilityDeps = jest.fn(() => ({
        isEnabled: () => false,
        getExporter: () => exporter
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/observability.js', () => ({
        createObservabilityDeps
      }));

      const { createObservabilityRuntime } = await import('@/modules/observability/internal/runtime.ts');

      await expect(
        createObservabilityRuntime(
          {} as any,
          { enabled: true, sampleRate: 1 } as any
        )
      ).resolves.toBeUndefined();

      expect(createObservabilityDeps).toHaveBeenCalledTimes(1);
    });
  });

  test('derives sessionId across fallback modes', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.LLM_ADAPTER_BATCH_ID = 'env-batch';

      const exporter = { flush: jest.fn(async () => {}) };
      const createObservabilityDeps = jest.fn(() => ({
        isEnabled: () => true,
        getExporter: () => exporter
      }));

      jest.unstable_mockModule('../../../modules/observability/internal/observability.js', () => ({
        createObservabilityDeps
      }));

      const { createObservabilityRuntime } = await import('@/modules/observability/internal/runtime.ts');

      const registry = {} as any;
      const spec = { enabled: true, sampleRate: 1 } as any;

      const batchRuntime = await createObservabilityRuntime(registry, spec, {
        runtime: { batchId: 'runtime-batch' }
      });
      expect(batchRuntime?.sessionId).toBe('runtime-batch');

      const batchEnvOnly = await createObservabilityRuntime(registry, spec, {});
      expect(batchEnvOnly?.sessionId).toBe('env-batch');

      const corrCorrId = await createObservabilityRuntime(registry, spec, {
        metadata: { correlationId: 'corr-1' },
        sessionIdFallback: 'correlation'
      });
      expect(corrCorrId?.sessionId).toBe('corr-1');

      const corrRuntimeBatch = await createObservabilityRuntime(registry, spec, {
        runtime: { batchId: 'runtime-batch' },
        sessionIdFallback: 'correlation'
      });
      expect(corrRuntimeBatch?.sessionId).toBe('runtime-batch');

      const corrEnvOnly = await createObservabilityRuntime(registry, spec, {
        sessionIdFallback: 'correlation'
      });
      expect(corrEnvOnly?.sessionId).toBe('env-batch');

      const autoCorrId = await createObservabilityRuntime(registry, spec, {
        metadata: { correlationId: 'corr-2' },
        sessionIdFallback: 'auto'
      });
      expect(autoCorrId?.sessionId).toBe('corr-2');

      const autoRuntimeBatch = await createObservabilityRuntime(registry, spec, {
        runtime: { batchId: 'runtime-batch' },
        sessionIdFallback: 'auto'
      });
      expect(autoRuntimeBatch?.sessionId).toBe('runtime-batch');

      const autoEnvOnly = await createObservabilityRuntime(registry, spec, {
        sessionIdFallback: 'auto'
      });
      expect(autoEnvOnly?.sessionId).toBe('env-batch');
    });
  });
});

