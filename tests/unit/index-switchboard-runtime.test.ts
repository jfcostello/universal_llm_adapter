import { jest } from '@jest/globals';

describe('root switchboard', () => {
  test('wrappers lazy-load, forward calls, and cache imports', async () => {
    jest.resetModules();

    await jest.isolateModulesAsync(async () => {
      const calls: string[] = [];

      let kernelImports = 0;
      let cliImports = 0;
      let serverImports = 0;
      let lifecycleImports = 0;
      let realtimeImports = 0;

      jest.unstable_mockModule('../../kernel/index.js', () => {
        kernelImports += 1;
        return {
          isPlainObject: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
          getDefaults: () => ({ defaults: true })
        };
      });

      jest.unstable_mockModule('../../modules/cli/index.js', () => {
        cliImports += 1;
        return {
          runUnifiedCli: async (argv?: string[]) => {
            calls.push(`cli:${JSON.stringify(argv ?? null)}`);
          }
        };
      });

      jest.unstable_mockModule('../../modules/server/index.js', () => {
        serverImports += 1;
        return {
          createServer: async (_options: any) => {
            calls.push('server.createServer');
            return { url: 'http://127.0.0.1:0', server: {}, close: async () => {} };
          },
          createServerHandlerWithDefaults: (_options: any) => {
            calls.push('server.createServerHandlerWithDefaults');
            return (() => undefined) as any;
          }
        };
      });

      jest.unstable_mockModule('../../modules/lifecycle/index.js', () => {
        lifecycleImports += 1;
        return {
          createRegistry: async (pluginsPath: string) => {
            calls.push(`lifecycle.createRegistry:${pluginsPath}`);
            return { loadAll: async () => {} };
          },
          createLlmCoordinator: async () => ({
            close: async () => {
              calls.push('lifecycle.llm.close');
            }
          }),
          createVectorCoordinator: async () => ({
            close: async () => {
              calls.push('lifecycle.vector.close');
            }
          }),
          createEmbeddingCoordinator: async () => ({
            close: async () => {
              calls.push('lifecycle.embedding.close');
            }
          }),
          closeLogger: async () => {
            calls.push('lifecycle.closeLogger');
          },
          runWithCoordinatorLifecycle: async (options: any) => {
            calls.push('lifecycle.runWithCoordinatorLifecycle');
            return options.run({} as any, options.spec);
          },
          streamWithCoordinatorLifecycle: async function* (options: any) {
            calls.push('lifecycle.streamWithCoordinatorLifecycle');
            yield* options.stream({} as any, options.spec);
          }
        };
      });

      jest.unstable_mockModule('../../modules/realtime/index.js', () => {
        realtimeImports += 1;
        return {
          createRealtimeSession: async (_registry: any, spec: any) => {
            calls.push(`realtime.createRealtimeSession:${String(spec?.provider)}`);
            return { session: true } as any;
          },
          createWsTransport: (options: any) => {
            calls.push(`realtime.createWsTransport:${String(options?.url)}`);
            return { transport: true } as any;
          }
        };
      });

      const root = await import('@/index.ts');

      await Promise.all([
        root.runUnifiedCli(['node', 'llm-adapter']),
        root.runUnifiedCli(['node', 'llm-adapter'])
      ]);
      expect(cliImports).toBe(1);

      const defaults = await Promise.all([root.getDefaults(), root.getDefaults()]);
      expect(defaults).toEqual([{ defaults: true }, { defaults: true }]);
      expect(kernelImports).toBe(1);

      await Promise.all([
        root.createServer(),
        root.createServer({} as any)
      ]);
      await Promise.all([
        root.createServerHandlerWithDefaults(),
        root.createServerHandlerWithDefaults({} as any),
        root.createServerHandlerWithDefaults({} as any)
      ]);
      expect(serverImports).toBe(1);

      const [registry] = await Promise.all([
        root.createRegistry('./plugins'),
        root.createRegistry('./plugins')
      ]);

      const [llm, vector, embedding] = await Promise.all([
        root.createLlmCoordinator(registry as any),
        root.createVectorCoordinator(registry as any),
        root.createEmbeddingCoordinator(registry as any)
      ]);
      await Promise.all([llm.close(), vector.close(), embedding.close()]);
      await root.closeLogger();
      expect(lifecycleImports).toBe(1);

      const runValue = await root.runWithCoordinatorLifecycle({
        spec: { a: 1 },
        deps: {},
        run: async () => 123
      } as any);
      expect(runValue).toBe(123);

      const streamed: number[] = [];
      for await (const event of root.streamWithCoordinatorLifecycle({
        spec: { a: 1 },
        deps: {},
        stream: async function* () {
          yield 1;
          yield 2;
        }
      } as any)) {
        streamed.push(event as any);
      }
      expect(streamed).toEqual([1, 2]);

      const realtimeSessions = await Promise.all([
        root.createRealtimeSession({} as any, { provider: 'test' } as any),
        root.createRealtimeSession({} as any, { provider: 'test' } as any)
      ]);
      expect(realtimeSessions).toEqual([{ session: true }, { session: true }]);

      const transports = await Promise.all([
        root.createWsTransport({ url: 'ws://localhost' } as any),
        root.createWsTransport({ url: 'ws://localhost' } as any)
      ]);
      expect(transports).toEqual([{ transport: true }, { transport: true }]);
      expect(realtimeImports).toBe(1);

      expect(calls).toEqual(
        expect.arrayContaining([
          'server.createServer',
          'server.createServerHandlerWithDefaults',
          'lifecycle.closeLogger',
          'lifecycle.runWithCoordinatorLifecycle',
          'lifecycle.streamWithCoordinatorLifecycle',
          'lifecycle.llm.close',
          'lifecycle.vector.close',
          'lifecycle.embedding.close',
          'realtime.createRealtimeSession:test',
          'realtime.createWsTransport:ws://localhost'
        ])
      );
    });
  });
});
