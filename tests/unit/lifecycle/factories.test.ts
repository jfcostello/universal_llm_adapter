import { jest } from '@jest/globals';

describe('lifecycle/internal/factories', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createRegistry', () => {
    test('creates a PluginRegistry with the given plugins path', async () => {
      const mockRegistry = { loadAll: jest.fn() };
      const PluginRegistryMock = jest.fn().mockImplementation(() => mockRegistry);

      (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
        PluginRegistry: PluginRegistryMock
      }));

      const { createRegistry } = await import('@/modules/lifecycle/internal/factories.ts');
      const result = await createRegistry('./test-plugins');

      expect(PluginRegistryMock).toHaveBeenCalledWith('./test-plugins');
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

      (jest as any).unstable_mockModule('@/modules/logging/index.ts', () => ({
        closeLogger: closeLoggerMock
      }));

      const { closeLogger } = await import('@/modules/lifecycle/internal/factories.ts');
      await closeLogger();

      expect(closeLoggerMock).toHaveBeenCalled();
    });
  });
});
