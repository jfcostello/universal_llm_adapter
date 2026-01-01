import { jest } from '@jest/globals';

describe('modules/realtime/internal/create-session (optional deps)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('continues without a realtime logger when logging module fails to load', async () => {
    await jest.isolateModulesAsync(async () => {
      let captured: any;

      jest.unstable_mockModule('../../../modules/realtime/internal/realtime-session.js', () => ({
        createRealtimeSessionController: (options: any) => {
          captured = options;
          return {
            sendText: async () => {},
            injectContext: async () => {},
            sendDTMF: async () => {},
            sendAudio: async () => {},
            commit: async () => {},
            interrupt: async () => {},
            close: async () => {},
            events: async function* () {}
          };
        }
      }));

      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module missing');
      });

      const { createRealtimeSession } = await import('@/modules/realtime/index.ts');

      const registry = {
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: 'p', compat: 'rt' }),
        getRealtimeCompat: jest.fn().mockResolvedValue({ createSession: jest.fn().mockResolvedValue({}) }),
        getTools: jest.fn(),
        getProcessRoutes: jest.fn().mockResolvedValue([])
      };

      const session = await createRealtimeSession(registry as any, { provider: 'p' } as any);
      expect(session).toBeDefined();
      expect(captured?.logger).toBeUndefined();
      expect(captured?.observability).toBeUndefined();
    });
  });

  test('continues when logging module is available but does not expose logger factories', async () => {
    await jest.isolateModulesAsync(async () => {
      let captured: any;

      jest.unstable_mockModule('../../../modules/realtime/internal/realtime-session.js', () => ({
        createRealtimeSessionController: (options: any) => {
          captured = options;
          return {
            sendText: async () => {},
            injectContext: async () => {},
            sendDTMF: async () => {},
            sendAudio: async () => {},
            commit: async () => {},
            interrupt: async () => {},
            close: async () => {},
            events: async function* () {}
          };
        }
      }));

      jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
        getLogger: undefined,
        getRealtimeLogger: undefined
      }));

      const { createRealtimeSession } = await import('@/modules/realtime/index.ts');

      const registry = {
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: 'p', compat: 'rt' }),
        getRealtimeCompat: jest.fn().mockResolvedValue({ createSession: jest.fn().mockResolvedValue({}) }),
        getTools: jest.fn(),
        getProcessRoutes: jest.fn().mockResolvedValue([])
      };

      const session = await createRealtimeSession(registry as any, { provider: 'p', observability: { enabled: false } } as any);
      expect(session).toBeDefined();
      expect(captured?.logger).toBeUndefined();
    });
  });

  test('passes observability runtime and swallows getLogger import failures', async () => {
    await jest.isolateModulesAsync(async () => {
      let captured: any;

      jest.unstable_mockModule('../../../modules/realtime/internal/realtime-session.js', () => ({
        createRealtimeSessionController: (options: any) => {
          captured = options;
          return {
            sendText: async () => {},
            injectContext: async () => {},
            sendDTMF: async () => {},
            sendAudio: async () => {},
            commit: async () => {},
            interrupt: async () => {},
            close: async () => {},
            events: async function* () {}
          };
        }
      }));

      jest.unstable_mockModule('../../../modules/logging/index.js', () => {
        throw new Error('logging module missing');
      });

      const runtime = {
        exporter: { flush: jest.fn(async () => {}) },
        baseTraceId: 'trace',
        sessionId: 'session-1',
        metadata: {},
        captureMessages: 'full',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      };

      const createObservabilityRuntime = jest.fn(async () => runtime);

      jest.unstable_mockModule('../../../modules/observability/index.js', () => ({
        createObservabilityRuntime
      }));

      const { createRealtimeSession } = await import('@/modules/realtime/index.ts');

      const registry = {
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: 'p', compat: 'rt' }),
        getRealtimeCompat: jest.fn().mockResolvedValue({ createSession: jest.fn().mockResolvedValue({}) }),
        getTools: jest.fn(),
        getProcessRoutes: jest.fn().mockResolvedValue([])
      };

      await createRealtimeSession(registry as any, {
        provider: 'p',
        metadata: { correlationId: 'corr-1' },
        observability: { enabled: true }
      } as any);

      expect(createObservabilityRuntime).toHaveBeenCalledWith(
        registry,
        { enabled: true },
        expect.objectContaining({ sessionIdFallback: 'correlation', metadata: { correlationId: 'corr-1' } })
      );
      expect(captured?.logger).toBeUndefined();
      expect(captured?.observability).toBe(runtime);
    });
  });

  test('swallows observability module import failures when enabled', async () => {
    await jest.isolateModulesAsync(async () => {
      let captured: any;

      jest.unstable_mockModule('../../../modules/realtime/internal/realtime-session.js', () => ({
        createRealtimeSessionController: (options: any) => {
          captured = options;
          return {
            sendText: async () => {},
            injectContext: async () => {},
            sendDTMF: async () => {},
            sendAudio: async () => {},
            commit: async () => {},
            interrupt: async () => {},
            close: async () => {},
            events: async function* () {}
          };
        }
      }));

      jest.unstable_mockModule('../../../modules/observability/index.js', () => {
        throw new Error('observability module missing');
      });

      const { createRealtimeSession } = await import('@/modules/realtime/index.ts');

      const registry = {
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: 'p', compat: 'rt' }),
        getRealtimeCompat: jest.fn().mockResolvedValue({ createSession: jest.fn().mockResolvedValue({}) }),
        getTools: jest.fn(),
        getProcessRoutes: jest.fn().mockResolvedValue([])
      };

      await createRealtimeSession(registry as any, { provider: 'p', observability: { enabled: true } } as any);
      expect(captured?.observability).toBeUndefined();
    });
  });

  test('provides getLogger instance to createObservabilityRuntime when available', async () => {
    await jest.isolateModulesAsync(async () => {
      let captured: any;

      jest.unstable_mockModule('../../../modules/realtime/internal/realtime-session.js', () => ({
        createRealtimeSessionController: (options: any) => {
          captured = options;
          return {
            sendText: async () => {},
            injectContext: async () => {},
            sendDTMF: async () => {},
            sendAudio: async () => {},
            commit: async () => {},
            interrupt: async () => {},
            close: async () => {},
            events: async function* () {}
          };
        }
      }));

      const baseLogger = { id: 'base' };
      const realtimeLogger = { id: 'realtime' };
      const getLogger = jest.fn(() => baseLogger as any);
      const getRealtimeLogger = jest.fn(() => realtimeLogger as any);

      jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
        getLogger,
        getRealtimeLogger
      }));

      const runtime = {
        exporter: { flush: jest.fn(async () => {}) },
        baseTraceId: 'trace',
        sessionId: 'session-1',
        metadata: {},
        captureMessages: 'full',
        captureToolArgs: false,
        captureRequestPayload: false,
        captureRawResponse: false,
        sampleRate: 1,
        maxInputTextBytes: 4096,
        maxOutputTextBytes: 4096,
        maxJsonBytes: 8192
      };

      const createObservabilityRuntime = jest.fn(async (_registry: any, _spec: any, options: any) => {
        expect(options.logger).toBe(baseLogger);
        return runtime;
      });

      jest.unstable_mockModule('../../../modules/observability/index.js', () => ({
        createObservabilityRuntime
      }));

      const { createRealtimeSession } = await import('@/modules/realtime/index.ts');

      const registry = {
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: 'p', compat: 'rt' }),
        getRealtimeCompat: jest.fn().mockResolvedValue({ createSession: jest.fn().mockResolvedValue({}) }),
        getTools: jest.fn(),
        getProcessRoutes: jest.fn().mockResolvedValue([])
      };

      await createRealtimeSession(registry as any, {
        provider: 'p',
        metadata: { correlationId: 'corr-1' },
        observability: { enabled: true }
      } as any);

      expect(getRealtimeLogger).toHaveBeenCalledWith('corr-1');
      expect(getLogger).toHaveBeenCalledWith('corr-1');
      expect(captured?.logger).toBe(realtimeLogger);
      expect(captured?.observability).toBe(runtime);
    });
  });

  test('warns when observability is explicitly enabled but cannot be initialized', async () => {
    await jest.isolateModulesAsync(async () => {
      const warning = jest.fn();

      jest.unstable_mockModule('../../../modules/logging/index.js', () => ({
        getLogger: jest.fn(() => ({ warning })),
        getRealtimeLogger: jest.fn(() => ({ warning }))
      }));

      jest.unstable_mockModule('../../../modules/observability/index.js', () => {
        throw new Error('observability module missing');
      });

      const { createRealtimeSession } = await import('@/modules/realtime/index.ts');

      const registry = {
        getRealtimeProvider: jest.fn().mockResolvedValue({ id: 'p', compat: 'rt' }),
        getRealtimeCompat: jest.fn().mockResolvedValue({ createSession: jest.fn().mockResolvedValue({}) }),
        getTools: jest.fn(),
        getProcessRoutes: jest.fn().mockResolvedValue([])
      };

      await createRealtimeSession(registry as any, {
        provider: 'p',
        observability: { enabled: true, sampleRate: 1 }
      } as any);

      expect(warning).toHaveBeenCalledWith(
        'realtime.observability.unavailable',
        expect.objectContaining({ message: expect.any(String) })
      );
    });
  });
});
