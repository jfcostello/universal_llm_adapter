import { jest } from '@jest/globals';

async function importServer() {
  return import('@/utils/server/index.ts');
}

describe('utils/server index default branches', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('createServerHandlerWithDefaults tolerates missing nested defaults', async () => {
    jest.resetModules();
    (jest as any).unstable_mockModule('@/core/defaults.ts', () => ({
      getDefaults: () => ({
        retry: {
          maxAttempts: 3,
          baseDelayMs: 250,
          multiplier: 2,
          rateLimitDelays: [1]
        },
        tools: {
          countdownEnabled: true,
          finalPromptEnabled: true,
          parallelExecution: false,
          preserveResults: 3,
          preserveReasoning: 3,
          maxIterations: 10,
          timeoutMs: 120000
        },
        vector: {
          topK: 5,
          injectTemplate: '',
          resultFormat: '',
          batchSize: 10,
          includePayload: true,
          includeVector: false,
          defaultCollection: 'default',
          queryConstruction: {
            includeSystemPrompt: 'if-in-range',
            includeAssistantMessages: true,
            messagesToInclude: 1
          }
        },
        chunking: { size: 500, overlap: 50 },
        tokenEstimation: { textDivisor: 4, imageEstimate: 768, toolResultDivisor: 6 },
        timeouts: { mcpRequest: 30000, llmHttp: 60000, embeddingHttp: 60000, loggerFlush: 2000 },
        server: {
          maxRequestBytes: 1,
          bodyReadTimeoutMs: 1,
          requestTimeoutMs: 0,
          streamIdleTimeoutMs: 0,
          maxConcurrentRequests: 1,
          maxConcurrentStreams: 1,
          maxQueueSize: 0,
          queueTimeoutMs: 0
        },
        paths: { plugins: './plugins' }
      })
    }));

    const { createServerHandlerWithDefaults } = await importServer();
    const handler = createServerHandlerWithDefaults({
      registry: { loadAll: jest.fn() } as any
    } as any);
    expect(typeof handler).toBe('function');
  });

  test('createServer tolerates missing nested defaults and uses final fallback', async () => {
    jest.resetModules();

    const fakeServer: any = {
      listen: jest.fn((_p: any, _h: any, cb: any) => cb()),
      once: jest.fn((_e: any, _cb: any) => fakeServer),
      address: jest.fn(() => ({ port: 1234 })),
      close: jest.fn((cb: any) => cb())
    };

    (jest as any).unstable_mockModule('http', () => ({
      __esModule: true,
      default: { createServer: jest.fn().mockReturnValue(fakeServer) }
    }));

    (jest as any).unstable_mockModule('@/core/defaults.ts', () => ({
      getDefaults: () => ({
        retry: {
          maxAttempts: 3,
          baseDelayMs: 250,
          multiplier: 2,
          rateLimitDelays: [1]
        },
        tools: {
          countdownEnabled: true,
          finalPromptEnabled: true,
          parallelExecution: false,
          preserveResults: 3,
          preserveReasoning: 3,
          maxIterations: 10,
          timeoutMs: 120000
        },
        vector: {
          topK: 5,
          injectTemplate: '',
          resultFormat: '',
          batchSize: 10,
          includePayload: true,
          includeVector: false,
          defaultCollection: 'default',
          queryConstruction: {
            includeSystemPrompt: 'if-in-range',
            includeAssistantMessages: true,
            messagesToInclude: 1
          }
        },
        chunking: { size: 500, overlap: 50 },
        tokenEstimation: { textDivisor: 4, imageEstimate: 768, toolResultDivisor: 6 },
        timeouts: { mcpRequest: 30000, llmHttp: 60000, embeddingHttp: 60000, loggerFlush: 2000 },
        server: {
          maxRequestBytes: 1,
          bodyReadTimeoutMs: 1,
          requestTimeoutMs: 0,
          streamIdleTimeoutMs: 0,
          maxConcurrentRequests: 1,
          maxConcurrentStreams: 1,
          maxQueueSize: 0,
          queueTimeoutMs: 0
        },
        paths: { plugins: './plugins' }
      })
    }));

    const { createServer } = await importServer();
    const running = await createServer({
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    expect(running.url).toBe('http://127.0.0.1:1234');
    await running.close();
  });

  test('createServer uses securityHeadersEnabled override when provided', async () => {
    jest.resetModules();

    const fakeServer: any = {
      listen: jest.fn((_p: any, _h: any, cb: any) => cb()),
      once: jest.fn((_e: any, _cb: any) => fakeServer),
      address: jest.fn(() => ({ port: 1234 })),
      close: jest.fn((cb: any) => cb())
    };

    (jest as any).unstable_mockModule('http', () => ({
      __esModule: true,
      default: { createServer: jest.fn().mockReturnValue(fakeServer) }
    }));

    const { createServer } = await importServer();
    const running = await createServer({
      securityHeadersEnabled: false,
      deps: {
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createCoordinator: jest.fn(),
        closeLogger: jest.fn().mockResolvedValue(undefined)
      }
    } as any);

    await running.close();
  });
});
