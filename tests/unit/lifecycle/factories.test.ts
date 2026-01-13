import { jest } from '@jest/globals';

describe('lifecycle/internal/factories', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createRegistry', () => {
    test('creates a PluginRegistry with the given plugins path when no paths config exists', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const PluginRegistryMock = jest.fn().mockImplementation(() => mockRegistry);

      (jest as any).unstable_mockModule('@/kernel/index.ts', () => ({
        isPlainObject: (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
        PluginRegistry: PluginRegistryMock,
        getAdapterPathsConfig: () => null
      }));

      const { createRegistry } = await import('@/modules/lifecycle/internal/factories.ts');
      const result = await createRegistry('./test-plugins');

      expect(PluginRegistryMock).toHaveBeenCalledWith('./test-plugins');
      expect(result).toBe(mockRegistry);
    });

    test('uses llm-adapter.paths.json lookup config when present (multi-root mode)', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const PluginRegistryMock = jest.fn().mockImplementation(() => mockRegistry);

      (jest as any).unstable_mockModule('@/kernel/index.ts', () => ({
        isPlainObject: (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
        PluginRegistry: PluginRegistryMock,
        getAdapterPathsConfig: () => ({
          filePath: '/tmp/llm-adapter.paths.json',
          source: 'cwd',
          paths: {
            plugins: './plugins-from-config',
            lookup: {
              warnOnOverride: true,
              extensions: { builtin: true, externalRoots: [] },
              plugins: {
                builtinManifests: false,
                builtinCode: true,
                local: true,
                externalRoots: [],
                areas: { providers: { local: false } }
              },
              configs: {
                defaults: { builtin: true, local: true, externalRoots: [] },
                usageCosts: { builtin: true, local: true, externalRoots: [] }
              }
            }
          }
        })
      }));

      const { createRegistry } = await import('@/modules/lifecycle/internal/factories.ts');
      const result = await createRegistry('./plugins');

      expect(PluginRegistryMock).toHaveBeenCalledWith({
        pluginsPath: './plugins-from-config',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: true,
          local: true,
          externalRoots: [],
          areas: { providers: { local: false } }
        }
      });
      expect(result).toBe(mockRegistry);
    });

    test('prefers an explicit pluginsPath argument over llm-adapter.paths.json plugins path', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const PluginRegistryMock = jest.fn().mockImplementation(() => mockRegistry);

      (jest as any).unstable_mockModule('@/kernel/index.ts', () => ({
        isPlainObject: (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
        PluginRegistry: PluginRegistryMock,
        getAdapterPathsConfig: () => ({
          filePath: '/tmp/llm-adapter.paths.json',
          source: 'cwd',
          paths: {
            plugins: './plugins-from-config',
            lookup: {
              warnOnOverride: true,
              extensions: { builtin: true, externalRoots: [] },
              plugins: {
                builtinManifests: false,
                builtinCode: true,
                local: true,
                externalRoots: [],
                areas: {}
              },
              configs: {
                defaults: { builtin: true, local: true, externalRoots: [] },
                usageCosts: { builtin: true, local: true, externalRoots: [] }
              }
            }
          }
        })
      }));

      const { createRegistry } = await import('@/modules/lifecycle/internal/factories.ts');
      const result = await createRegistry('./custom-plugins');

      expect(PluginRegistryMock).toHaveBeenCalledWith({
        pluginsPath: './custom-plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: true,
          local: true,
          externalRoots: [],
          areas: {}
        }
      });
      expect(result).toBe(mockRegistry);
    });

    test('falls back to ./plugins when pluginsPath is blank and no paths.plugins is configured', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const PluginRegistryMock = jest.fn().mockImplementation(() => mockRegistry);

      (jest as any).unstable_mockModule('@/kernel/index.ts', () => ({
        isPlainObject: (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
        PluginRegistry: PluginRegistryMock,
        getAdapterPathsConfig: () => ({
          filePath: '/tmp/llm-adapter.paths.json',
          source: 'cwd',
          paths: {
            lookup: {
              warnOnOverride: true,
              extensions: { builtin: true, externalRoots: [] },
              plugins: {
                builtinManifests: false,
                builtinCode: true,
                local: true,
                externalRoots: [],
                areas: {}
              },
              configs: {
                defaults: { builtin: true, local: true, externalRoots: [] },
                usageCosts: { builtin: true, local: true, externalRoots: [] }
              }
            }
          }
        })
      }));

      const { createRegistry } = await import('@/modules/lifecycle/internal/factories.ts');
      const result = await createRegistry('   ');

      expect(PluginRegistryMock).toHaveBeenCalledWith({
        pluginsPath: './plugins',
        lookup: {
          warnOnOverride: true,
          builtinManifests: false,
          builtinCode: true,
          local: true,
          externalRoots: [],
          areas: {}
        }
      });
      expect(result).toBe(mockRegistry);
    });
  });

  describe('createLlmCoordinator', () => {
    test('creates LLMCoordinator with logging deps', async () => {
      const mockCoordinator = {
        run: jest.fn(),
        runStream: jest.fn(),
        close: jest.fn()
      };
      const LLMCoordinatorMock = jest.fn().mockImplementation(() => mockCoordinator);
      const mockLoggingDeps = { info: jest.fn() };
      const createLoggingDepsMock = jest.fn().mockReturnValue(mockLoggingDeps);

      (jest as any).unstable_mockModule('@/modules/llm/index.ts', () => ({
        LLMCoordinator: LLMCoordinatorMock
      }));

      (jest as any).unstable_mockModule('@/modules/logging/index.ts', () => ({
        createLoggingDeps: createLoggingDepsMock
      }));

      const { createLlmCoordinator } = await import('@/modules/lifecycle/internal/factories.ts');
      const mockRegistry = { loadAll: jest.fn() };
      const result = await createLlmCoordinator(mockRegistry);

      expect(LLMCoordinatorMock).toHaveBeenCalledWith(mockRegistry, {
        logging: mockLoggingDeps
      });
      expect(createLoggingDepsMock).toHaveBeenCalled();
      expect(result).toBe(mockCoordinator);
    });
  });

  describe('createVectorCoordinator', () => {
    test('creates VectorStoreCoordinator with logging deps', async () => {
      const mockCoordinator = {
        execute: jest.fn(),
        executeStream: jest.fn(),
        close: jest.fn()
      };
      const VectorStoreCoordinatorMock = jest.fn().mockImplementation(() => mockCoordinator);
      const mockLoggingDeps = { info: jest.fn() };
      const createLoggingDepsMock = jest.fn().mockReturnValue(mockLoggingDeps);

      (jest as any).unstable_mockModule('@/modules/vector/index.ts', () => ({
        VectorStoreCoordinator: VectorStoreCoordinatorMock
      }));

      (jest as any).unstable_mockModule('@/modules/logging/index.ts', () => ({
        createLoggingDeps: createLoggingDepsMock
      }));

      const { createVectorCoordinator } = await import('@/modules/lifecycle/internal/factories.ts');
      const mockRegistry = { loadAll: jest.fn() };
      const result = await createVectorCoordinator(mockRegistry);

      expect(VectorStoreCoordinatorMock).toHaveBeenCalledWith(mockRegistry, {
        logging: mockLoggingDeps
      });
      expect(createLoggingDepsMock).toHaveBeenCalled();
      expect(result).toBe(mockCoordinator);
    });
  });

  describe('createEmbeddingCoordinator', () => {
    test('creates EmbeddingCoordinator with logging deps', async () => {
      const mockCoordinator = {
        execute: jest.fn(),
        close: jest.fn()
      };
      const EmbeddingCoordinatorMock = jest.fn().mockImplementation(() => mockCoordinator);
      const mockLoggingDeps = { info: jest.fn() };
      const createLoggingDepsMock = jest.fn().mockReturnValue(mockLoggingDeps);

      (jest as any).unstable_mockModule('@/modules/embeddings/index.ts', () => ({
        EmbeddingCoordinator: EmbeddingCoordinatorMock
      }));

      (jest as any).unstable_mockModule('@/modules/logging/index.ts', () => ({
        createLoggingDeps: createLoggingDepsMock
      }));

      const { createEmbeddingCoordinator } = await import('@/modules/lifecycle/internal/factories.ts');
      const mockRegistry = { loadAll: jest.fn() };
      const result = await createEmbeddingCoordinator(mockRegistry);

      expect(EmbeddingCoordinatorMock).toHaveBeenCalledWith(mockRegistry, {
        logging: mockLoggingDeps
      });
      expect(createLoggingDepsMock).toHaveBeenCalled();
      expect(result).toBe(mockCoordinator);
    });
  });

  describe('closeLogger', () => {
    test('calls closeLogger from logging module', async () => {
      const closeLoggerMock = jest.fn().mockResolvedValue(undefined);
      const shutdownAllMock = jest.fn().mockResolvedValue(undefined);

      const runtimeSymbol = Symbol.for('llm_adapter_observability_runtime');
      (globalThis as any)[runtimeSymbol] = { shutdownAll: shutdownAllMock };

      (jest as any).unstable_mockModule('@/modules/logging/index.ts', () => ({
        closeLogger: closeLoggerMock
      }));

      const { closeLogger } = await import('@/modules/lifecycle/internal/factories.ts');
      await closeLogger();

      expect(shutdownAllMock).toHaveBeenCalled();
      expect(closeLoggerMock).toHaveBeenCalled();

      delete (globalThis as any)[runtimeSymbol];
    });

    test('swallows observability shutdown failures and still closes logging', async () => {
      const closeLoggerMock = jest.fn().mockResolvedValue(undefined);
      const shutdownAllMock = jest.fn().mockRejectedValue(undefined);

      const runtimeSymbol = Symbol.for('llm_adapter_observability_runtime');
      (globalThis as any)[runtimeSymbol] = { shutdownAll: shutdownAllMock };

      (jest as any).unstable_mockModule('@/modules/logging/index.ts', () => ({
        closeLogger: closeLoggerMock
      }));

      const { closeLogger } = await import('@/modules/lifecycle/internal/factories.ts');
      await expect(closeLogger()).resolves.toBeUndefined();

      expect(shutdownAllMock).toHaveBeenCalled();
      expect(closeLoggerMock).toHaveBeenCalled();

      delete (globalThis as any)[runtimeSymbol];
    });
  });
});
