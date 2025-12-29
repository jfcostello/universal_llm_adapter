import { jest } from '@jest/globals';

describe('server: extensions httpConfig', () => {
  test('passes serverDefaults.extensions through to extensions', async () => {
    jest.resetModules();

    await jest.isolateModulesAsync(async () => {
      let capturedHttpConfig: any | undefined;

      jest.unstable_mockModule('@/modules/server/internal/extensions/host.ts', () => ({
        loadServerExtensions: async (options: any) => {
          capturedHttpConfig = options.httpConfig;
          return { handleHttp: async () => false, close: async () => {} };
        }
      }));

      const { createServer } = await import('@/modules/server/index.ts');

      const running = await createServer({
        extensions: { enabled: ['voice'] },
        deps: {
          getDefaults: () => ({
            server: {
              maxRequestBytes: 1,
              bodyReadTimeoutMs: 1,
              requestTimeoutMs: 0,
              streamIdleTimeoutMs: 0,
              maxConcurrentRequests: 1,
              maxConcurrentStreams: 1,
              maxQueueSize: 0,
              queueTimeoutMs: 0,
              securityHeadersEnabled: true,
              extensions: {
                enabled: ['voice'],
                voice: { assistantFirstTurn: { enabled: true } }
              }
            }
          }),
          createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
          createCoordinator: jest.fn(),
          closeLogger: jest.fn().mockResolvedValue(undefined)
        }
      } as any);

      try {
        expect(capturedHttpConfig?.extensions).toEqual({
          enabled: ['voice'],
          voice: { assistantFirstTurn: { enabled: true } }
        });
      } finally {
        await running.close();
      }
    });
  });
});
