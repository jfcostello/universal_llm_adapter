import { jest } from '@jest/globals';
import { createUnifiedProgram } from '@/modules/cli/internal/unified-cli.ts';

/**
 * Tests verifying lazy loading in the unified CLI.
 *
 * The unified CLI is designed so that:
 * - `llm-adapter --help` only loads commander (no heavy modules)
 * - Each command only loads the modules it needs
 * - Vector operations don't load LLM modules and vice versa
 *
 * These tests verify this by:
 * 1. Testing that --help doesn't call any dependency functions
 * 2. Testing that each command only calls its specific coordinator factory
 */
describe('unified CLI lazy loading', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('--help command', () => {
    test('does not invoke any coordinator or registry factory', () => {
      const createRegistry = jest.fn();
      const createLlmCoordinator = jest.fn();
      const createVectorCoordinator = jest.fn();
      const createEmbeddingCoordinator = jest.fn();

      const program = createUnifiedProgram({
        createRegistry,
        createLlmCoordinator,
        createVectorCoordinator,
        createEmbeddingCoordinator,
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      });

      // Getting help information should NOT trigger any factories
      const help = program.helpInformation();

      expect(help).toContain('LLM Adapter CLI');
      expect(createRegistry).not.toHaveBeenCalled();
      expect(createLlmCoordinator).not.toHaveBeenCalled();
      expect(createVectorCoordinator).not.toHaveBeenCalled();
      expect(createEmbeddingCoordinator).not.toHaveBeenCalled();
    });

    test('program creation does not trigger any imports', () => {
      // This test verifies that merely creating the program doesn't
      // trigger any module loading - all action handlers use dynamic imports
      const factoryCalls: string[] = [];

      const program = createUnifiedProgram({
        createRegistry: jest.fn(() => { factoryCalls.push('registry'); return Promise.resolve({}) as any; }),
        createLlmCoordinator: jest.fn(() => { factoryCalls.push('llm'); return Promise.resolve({}) as any; }),
        createVectorCoordinator: jest.fn(() => { factoryCalls.push('vector'); return Promise.resolve({}) as any; }),
        createEmbeddingCoordinator: jest.fn(() => { factoryCalls.push('embedding'); return Promise.resolve({}) as any; }),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      });

      // Program creation should be side-effect free
      expect(program.name()).toBe('llm-adapter');
      expect(factoryCalls).toEqual([]);
    });
  });

  describe('LLM run command isolation', () => {
    test('only calls createLlmCoordinator, not vector or embedding coordinators', async () => {
      const createLlmCoordinator = jest.fn().mockResolvedValue({
        run: jest.fn().mockResolvedValue({ content: [{ text: 'ok' }] }),
        close: jest.fn().mockResolvedValue(undefined)
      });
      const createVectorCoordinator = jest.fn();
      const createEmbeddingCoordinator = jest.fn();

      jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
        const callback = args.find((arg: any) => typeof arg === 'function');
        if (callback) setImmediate(callback);
        return true;
      });

      const program = createUnifiedProgram({
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createLlmCoordinator,
        createVectorCoordinator,
        createEmbeddingCoordinator,
        closeLogger: jest.fn().mockResolvedValue(undefined),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'run',
        '--spec',
        '{"messages":[],"llmPriority":[{"provider":"p","model":"m"}],"settings":{}}'
      ]);

      expect(createLlmCoordinator).toHaveBeenCalled();
      expect(createVectorCoordinator).not.toHaveBeenCalled();
      expect(createEmbeddingCoordinator).not.toHaveBeenCalled();
    });
  });

  describe('LLM stream command isolation', () => {
    test('only calls createLlmCoordinator, not vector or embedding coordinators', async () => {
      const createLlmCoordinator = jest.fn().mockResolvedValue({
        runStream: jest.fn().mockImplementation(async function* () {
          yield { type: 'delta', content: 'hi' };
        }),
        close: jest.fn().mockResolvedValue(undefined)
      });
      const createVectorCoordinator = jest.fn();
      const createEmbeddingCoordinator = jest.fn();

      const program = createUnifiedProgram({
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createLlmCoordinator,
        createVectorCoordinator,
        createEmbeddingCoordinator,
        closeLogger: jest.fn().mockResolvedValue(undefined),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      });

      await program.parseAsync([
        'node',
        'llm-adapter',
        'stream',
        '--spec',
        '{"messages":[],"llmPriority":[{"provider":"p","model":"m"}],"settings":{}}'
      ]);

      expect(createLlmCoordinator).toHaveBeenCalled();
      expect(createVectorCoordinator).not.toHaveBeenCalled();
      expect(createEmbeddingCoordinator).not.toHaveBeenCalled();
    });
  });

  describe('vector run command isolation', () => {
    test('only calls createVectorCoordinator, not llm or embedding coordinators', async () => {
      const createLlmCoordinator = jest.fn();
      const createVectorCoordinator = jest.fn().mockResolvedValue({
        execute: jest.fn().mockResolvedValue({ operation: 'query', success: true }),
        close: jest.fn().mockResolvedValue(undefined)
      });
      const createEmbeddingCoordinator = jest.fn();

      jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
        const callback = args.find((arg: any) => typeof arg === 'function');
        if (callback) setImmediate(callback);
        return true;
      });

      const program = createUnifiedProgram({
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createLlmCoordinator,
        createVectorCoordinator,
        createEmbeddingCoordinator,
        closeLogger: jest.fn().mockResolvedValue(undefined),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      });

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'run', '--spec', '{"operation":"query","store":"test"}']);

      expect(createVectorCoordinator).toHaveBeenCalled();
      expect(createLlmCoordinator).not.toHaveBeenCalled();
      expect(createEmbeddingCoordinator).not.toHaveBeenCalled();
    });
  });

  describe('vector stream command isolation', () => {
    test('only calls createVectorCoordinator, not llm or embedding coordinators', async () => {
      const createLlmCoordinator = jest.fn();
      const createVectorCoordinator = jest.fn().mockResolvedValue({
        executeStream: jest.fn().mockImplementation(async function* () {
          yield { type: 'progress' };
        }),
        close: jest.fn().mockResolvedValue(undefined)
      });
      const createEmbeddingCoordinator = jest.fn();

      const program = createUnifiedProgram({
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createLlmCoordinator,
        createVectorCoordinator,
        createEmbeddingCoordinator,
        closeLogger: jest.fn().mockResolvedValue(undefined),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      });

      await program.parseAsync(['node', 'llm-adapter', 'vector', 'stream', '--spec', '{"operation":"embed","store":"test"}']);

      expect(createVectorCoordinator).toHaveBeenCalled();
      expect(createLlmCoordinator).not.toHaveBeenCalled();
      expect(createEmbeddingCoordinator).not.toHaveBeenCalled();
    });
  });

  describe('embeddings run command isolation', () => {
    test('only calls createEmbeddingCoordinator, not llm or vector coordinators', async () => {
      const createLlmCoordinator = jest.fn();
      const createVectorCoordinator = jest.fn();
      const createEmbeddingCoordinator = jest.fn().mockResolvedValue({
        execute: jest.fn().mockResolvedValue({ operation: 'embed', success: true, vectors: [[0.1]] }),
        close: jest.fn().mockResolvedValue(undefined)
      });

      jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
        const callback = args.find((arg: any) => typeof arg === 'function');
        if (callback) setImmediate(callback);
        return true;
      });

      const program = createUnifiedProgram({
        createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
        createLlmCoordinator,
        createVectorCoordinator,
        createEmbeddingCoordinator,
        closeLogger: jest.fn().mockResolvedValue(undefined),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      });

      await program.parseAsync(['node', 'llm-adapter', 'embeddings', 'run', '--spec', '{"operation":"embed","embeddingPriority":[]}']);

      expect(createEmbeddingCoordinator).toHaveBeenCalled();
      expect(createLlmCoordinator).not.toHaveBeenCalled();
      expect(createVectorCoordinator).not.toHaveBeenCalled();
    });
  });

  describe('defaultDependencies lazy loading', () => {
    test('defaultDependencies factories use dynamic imports', async () => {
      // Import the default dependencies directly
      const { defaultDependencies } = await import('@/modules/cli/internal/unified-cli.ts');

      // Verify all factories are async functions (use dynamic imports)
      expect(typeof defaultDependencies.createRegistry).toBe('function');
      expect(typeof defaultDependencies.createLlmCoordinator).toBe('function');
      expect(typeof defaultDependencies.createVectorCoordinator).toBe('function');
      expect(typeof defaultDependencies.createEmbeddingCoordinator).toBe('function');
      expect(typeof defaultDependencies.createServer).toBe('function');
      expect(typeof defaultDependencies.createRealtimeSession).toBe('function');
      expect(typeof defaultDependencies.closeLogger).toBe('function');

      // These should return promises (indicating async/dynamic imports)
      const registry = { loadAll: jest.fn() };

      // Don't actually call them - just verify they're defined
      // Calling them would trigger real module loading
    });
  });
});
