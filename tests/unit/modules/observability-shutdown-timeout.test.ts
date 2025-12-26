import path from 'path';
import { describe, expect, jest, test } from '@jest/globals';
import { withTempCwd, writeJson } from '@tests/helpers/temp-files.ts';

describe('observability shutdownTimeoutMs', () => {
  test('deps.shutdown waits for exporter shutdown when shutdownTimeoutMs=0 (uncapped)', async () => {
    const originalFs = await import('fs');
    const packageDefaultsPath = path.resolve(process.cwd(), 'plugins', 'configs', 'defaults.json');
    const defaults = JSON.parse(originalFs.readFileSync(packageDefaultsPath, 'utf-8'));

    await withTempCwd('observability-shutdown-timeout-0', async (dir) => {
      writeJson(path.join(dir, 'plugins', 'configs', 'defaults.json'), {
        ...defaults,
        observability: {
          ...defaults.observability,
          shutdownTimeoutMs: 0
        }
      });

      jest.resetModules();

      const fsMock: any = {
        ...originalFs,
        __esModule: true,
        existsSync: jest.fn((p: string) => {
          if (path.resolve(String(p)) === packageDefaultsPath) return false;
          return originalFs.existsSync(p);
        }),
        readFileSync: originalFs.readFileSync
      };
      fsMock.default = fsMock;

      (jest as any).unstable_mockModule('fs', () => fsMock);

      const { getDefaults } = await import('@/modules/kernel/index.ts');
      expect(getDefaults().observability.shutdownTimeoutMs).toBe(0);

      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map() })),
        sendBatch: jest.fn(async () => ({ success: true, outcomes: [] }))
      };

      const mockManifest = {
        id: 'test',
        compat: 'test-compat',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const mockRegistry = {
        getObservabilityProvider: jest.fn(async () => mockManifest),
        getObservabilityCompat: jest.fn(async () => mockCompat)
      };

      const deps = await createObservabilityDeps(mockRegistry as any, {
        enabled: true,
        provider: 'test'
      });

      const exporter: any = deps.getExporter();
      let shutdownReject: ((error: unknown) => void) | undefined;
      const shutdownSpy = jest.spyOn(exporter, 'shutdown').mockImplementation(() => new Promise<void>((_resolve, reject) => {
        shutdownReject = reject;
      }));

      let resolved = false;
      const shutdownPromise = deps.shutdown().then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(typeof shutdownReject).toBe('function');

      shutdownReject?.(new Error('shutdown failed'));
      await shutdownPromise;
      expect(resolved).toBe(true);
      expect(shutdownSpy).toHaveBeenCalled();
    });
  });

  test('deps.shutdown aborts in-flight exports when shutdownTimeoutMs cap is hit', async () => {
    jest.useFakeTimers();

    const originalFs = await import('fs');
    const packageDefaultsPath = path.resolve(process.cwd(), 'plugins', 'configs', 'defaults.json');
    const defaults = JSON.parse(originalFs.readFileSync(packageDefaultsPath, 'utf-8'));

    await withTempCwd('observability-shutdown-timeout-abort', async (dir) => {
      writeJson(path.join(dir, 'plugins', 'configs', 'defaults.json'), {
        ...defaults,
        observability: {
          ...defaults.observability,
          shutdownTimeoutMs: 100
        }
      });

      jest.resetModules();

      const fsMock: any = {
        ...originalFs,
        __esModule: true,
        existsSync: jest.fn((p: string) => {
          if (path.resolve(String(p)) === packageDefaultsPath) return false;
          return originalFs.existsSync(p);
        }),
        readFileSync: originalFs.readFileSync
      };
      fsMock.default = fsMock;

      (jest as any).unstable_mockModule('fs', () => fsMock);

      const { createObservabilityDeps } = await import('@/modules/observability/index.ts');

      let receivedSignal: AbortSignal | undefined;

      const mockCompat = {
        buildBatch: jest.fn(() => ({ payload: {}, eventIndexByEnvelopeId: new Map([['env-1', 0]]) })),
        sendBatch: jest.fn(async (_payload: any, _manifest: any, context: any) => {
          receivedSignal = context?.signal as AbortSignal | undefined;
          if (!receivedSignal) {
            throw new Error('Expected ObservabilityCompatContext.signal to be provided during shutdown');
          }

          if (receivedSignal.aborted) {
            return { success: false, outcomes: [] };
          }

          return await new Promise((resolve) => {
            receivedSignal!.addEventListener('abort', () => resolve({ success: false, outcomes: [] }), { once: true });
          });
        })
      };

      const mockManifest = {
        id: 'test',
        compat: 'test-compat',
        endpoint: { urlTemplate: 'http://test', method: 'POST' }
      };

      const mockRegistry = {
        getObservabilityProvider: jest.fn(async () => mockManifest),
        getObservabilityCompat: jest.fn(async () => mockCompat)
      };

      const deps = await createObservabilityDeps(mockRegistry as any, { enabled: true, provider: 'test' });
      const exporter: any = deps.getExporter();

      exporter.recordLLMRequest({
        traceId: 'trace-1',
        timestampMs: 1704067200000,
        provider: 'test',
        model: 'model',
        messages: []
      });

      const shutdownPromise = deps.shutdown();

      // Allow shutdown to start and the first sendBatch to be invoked.
      await Promise.resolve();
      await Promise.resolve();

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);

      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      await shutdownPromise;

      expect(receivedSignal!.aborted).toBe(true);
    });

    jest.useRealTimers();
  });
});
