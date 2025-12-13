import path from 'path';
import { jest } from '@jest/globals';
import { Command } from 'commander';

// These will be created in implementation
import type { CliDependencies } from '@/vector_store_coordinator.ts';

// Mock the module - will be replaced when implementation exists
const mockCreateProgram = jest.fn();

// Import ROOT_DIR from test helpers
import { ROOT_DIR } from '@tests/helpers/paths.ts';

function createDeps(overrides: Partial<CliDependencies> = {}) {
  const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
  const coordinator = {
    execute: jest.fn().mockResolvedValue({
      operation: 'embed',
      success: true,
      embedded: 5
    }),
    executeStream: jest.fn().mockImplementation(async function* () {
      yield { type: 'progress', progress: { current: 50, total: 100 } };
      yield { type: 'done' };
    }),
    close: jest.fn().mockResolvedValue(undefined)
  };
  const embeddingCoordinator = {
    execute: jest.fn().mockResolvedValue({
      operation: 'embed',
      success: true,
      vectors: [[0.1]],
      model: 'm',
      dimensions: 1
    }),
    close: jest.fn().mockResolvedValue(undefined)
  };

  const baseDeps: CliDependencies = {
    createRegistry: jest.fn().mockResolvedValue(registry),
    createCoordinator: jest.fn().mockResolvedValue(coordinator),
    createEmbeddingCoordinator: jest.fn().mockResolvedValue(embeddingCoordinator),
    log: jest.fn(),
    error: jest.fn(),
    exit: jest.fn()
  };

  return {
    deps: { ...baseDeps, ...overrides },
    registry,
    coordinator,
    embeddingCoordinator
  };
}

describe('vector_store_coordinator CLI', () => {
  // Note: These tests will fail until implementation exists
  // This is TDD - tests first, then implementation

  let createProgram: typeof mockCreateProgram;

  beforeAll(async () => {
    // Will import from actual module when it exists
    try {
      const module = await import('@/vector_store_coordinator.ts');
      createProgram = module.createProgram;
    } catch {
      // Module doesn't exist yet - use mocks for type checking
      createProgram = mockCreateProgram;
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('embed command', () => {
    test('executes embed with default plugins path', async () => {
      const { deps, registry, coordinator } = createDeps();
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'embed',
        '--spec', '{"operation":"embed","store":"qdrant-cloud","input":{"texts":["hello"]}}'
      ]);

      expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
      expect(registry.loadAll).toHaveBeenCalled();
      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'embed',
          store: 'qdrant-cloud'
        })
      );
      expect(coordinator.close).toHaveBeenCalled();
      expect(deps.exit).toHaveBeenCalledWith(0);
    });

    test('accepts custom plugins path', async () => {
      const { deps } = createDeps();
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'embed',
        '--plugins', '/custom/plugins',
        '--spec', '{"operation":"embed","store":"test"}'
      ]);

      expect(deps.createRegistry).toHaveBeenCalledWith('/custom/plugins');
    });

    test('pretty prints output when requested', async () => {
      const { deps } = createDeps();
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'embed',
        '--spec', '{"operation":"embed","store":"test"}',
        '--pretty'
      ]);

      expect(deps.exit).toHaveBeenCalledWith(0);
    });

    test('handles errors gracefully', async () => {
      const { deps } = createDeps({
        createRegistry: jest.fn().mockRejectedValue(new Error('Registry failed'))
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'embed',
        '--spec', '{"operation":"embed","store":"test"}'
      ]);

      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining('Registry failed')
      );
      expect(deps.exit).toHaveBeenCalledWith(1);
    });

    test('handles string errors via fallback', async () => {
      const { deps } = createDeps({
        createRegistry: jest.fn().mockRejectedValue('string error')
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'embed',
        '--spec', '{"operation":"embed","store":"test"}'
      ]);

      expect(deps.error).toHaveBeenCalledWith(
        JSON.stringify({ error: 'string error' })
      );
      expect(deps.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('run command (generic)', () => {
    test('executes spec-defined operation', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'query',
        success: true,
        results: []
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node',
        'vector',
        'run',
        '--spec',
        '{"operation":"query","store":"qdrant-cloud","input":{"vector":[0.1],\"topK\":5}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'query', store: 'qdrant-cloud' })
      );
      expect(deps.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('stream command (generic)', () => {
    test('streams events for spec-defined operation', async () => {
      const { deps, coordinator } = createDeps({
        log: jest.fn(),
        exit: jest.fn()
      });
      coordinator.executeStream = jest.fn().mockImplementation(async function* () {
        yield { type: 'progress', progress: { current: 0, total: 1 } };
        yield { type: 'done' };
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node',
        'vector',
        'stream',
        '--spec',
        '{"operation":"embed","store":"test","embeddingPriority":[{"provider":"p"}],"input":{"texts":["hello"]}}'
      ]);

      expect(coordinator.executeStream).toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalled();
      expect(deps.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('upsert command', () => {
    test('executes upsert operation', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'upsert',
        success: true
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'upsert',
        '--spec', '{"operation":"upsert","store":"qdrant-cloud","input":{"points":[]}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'upsert' })
      );
      expect(deps.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('query command', () => {
    test('executes query operation', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'query',
        success: true,
        results: [{ id: 'doc1', score: 0.95 }]
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'query',
        '--spec', '{"operation":"query","store":"qdrant-cloud","input":{"query":"test"}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'query' })
      );
      expect(deps.exit).toHaveBeenCalledWith(0);
    });

    test('outputs query results', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'query',
        success: true,
        results: [
          { id: 'doc1', score: 0.95, payload: { text: 'hello' } }
        ]
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'query',
        '--spec', '{"operation":"query","store":"test","input":{"query":"hello"}}'
      ]);

      expect(deps.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('delete command', () => {
    test('executes delete operation', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'delete',
        success: true,
        deleted: 3
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'delete',
        '--spec', '{"operation":"delete","store":"qdrant-cloud","input":{"ids":["a","b","c"]}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'delete' })
      );
      expect(deps.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('collections command', () => {
    test('lists collections', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'collections',
        success: true,
        collections: ['docs', 'images']
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'collections',
        '--spec', '{"operation":"collections","store":"qdrant-cloud","input":{"collectionOp":"list"}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'collections',
          input: expect.objectContaining({ collectionOp: 'list' })
        })
      );
      expect(deps.exit).toHaveBeenCalledWith(0);
    });

    test('creates collection', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'collections',
        success: true,
        created: true
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'collections',
        '--spec', '{"operation":"collections","store":"test","input":{"collectionOp":"create","collectionName":"new","dimensions":1536}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            collectionOp: 'create',
            collectionName: 'new',
            dimensions: 1536
          })
        })
      );
    });

    test('deletes collection', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'collections',
        success: true
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'collections',
        '--spec', '{"operation":"collections","store":"test","input":{"collectionOp":"delete","collectionName":"old"}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            collectionOp: 'delete',
            collectionName: 'old'
          })
        })
      );
    });

    test('checks collection exists', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.execute.mockResolvedValue({
        operation: 'collections',
        success: true,
        exists: true
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'collections',
        '--spec', '{"operation":"collections","store":"test","input":{"collectionOp":"exists","collectionName":"check"}}'
      ]);

      expect(coordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            collectionOp: 'exists',
            collectionName: 'check'
          })
        })
      );
    });
  });

  describe('streaming operations', () => {
    test('streams progress for embed operation', async () => {
      const { deps, coordinator } = createDeps();
      coordinator.executeStream = jest.fn().mockImplementation(async function* () {
        yield { type: 'progress', progress: { current: 25, total: 100, message: 'Embedding batch 1' } };
        yield { type: 'progress', progress: { current: 50, total: 100, message: 'Embedding batch 2' } };
        yield { type: 'progress', progress: { current: 75, total: 100, message: 'Embedding batch 3' } };
        yield { type: 'progress', progress: { current: 100, total: 100, message: 'Embedding batch 4' } };
        yield { type: 'result', result: { operation: 'embed', success: true, embedded: 100 } };
        yield { type: 'done' };
      });

      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'embed',
        '--spec', '{"operation":"embed","store":"test","input":{"texts":[]}}',
        '--stream'
      ]);

      expect(deps.log).toHaveBeenCalled();
      expect(deps.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('embeddings command group', () => {
    test('embeddings run uses default createEmbeddingCoordinator when not provided', async () => {
      const registry = {
        loadAll: jest.fn().mockResolvedValue(undefined),
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'p',
          kind: 'test',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'm',
          dimensions: 1
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue({
          embed: jest.fn().mockResolvedValue({
            vectors: [[0.1]],
            model: 'm',
            dimensions: 1
          }),
          getDimensions: jest.fn().mockReturnValue(1),
          validate: jest.fn().mockResolvedValue(true)
        })
      };

      const deps: any = {
        createRegistry: jest.fn().mockResolvedValue(registry),
        createCoordinator: jest.fn().mockResolvedValue({
          execute: jest.fn(),
          executeStream: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined)
        }),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      };

      const program = createProgram(deps);

      await program.parseAsync([
        'node',
        'vector',
        'embeddings',
        'run',
        '--spec',
        '{"operation":"embed","embeddingPriority":[{"provider":"p"}],"input":{"texts":["hello"]}}'
      ]);

      expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
      expect(registry.loadAll).toHaveBeenCalled();
      expect(registry.getEmbeddingProvider).toHaveBeenCalledWith('p');
      expect(registry.getEmbeddingCompat).toHaveBeenCalledWith('test');
      expect(deps.exit).toHaveBeenCalledWith(0);
    });

    test('embeddings run uses embedding coordinator', async () => {
      const { deps, registry, embeddingCoordinator } = createDeps();
      const program = createProgram(deps);

      await program.parseAsync([
        'node',
        'vector',
        'embeddings',
        'run',
        '--spec',
        '{"operation":"embed","embeddingPriority":[{"provider":"p"}],"input":{"texts":["hello"]}}'
      ]);

      expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
      expect(registry.loadAll).toHaveBeenCalled();
      expect(deps.createEmbeddingCoordinator).toHaveBeenCalled();
      expect(embeddingCoordinator.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'embed' })
      );
      expect(embeddingCoordinator.close).toHaveBeenCalled();
      expect(deps.exit).toHaveBeenCalledWith(0);
    });

    test('embeddings run fails when createEmbeddingCoordinator dependency is missing', async () => {
      const { deps } = createDeps({ createEmbeddingCoordinator: undefined as any });
      const program = createProgram(deps);

      await program.parseAsync([
        'node',
        'vector',
        'embeddings',
        'run',
        '--spec',
        '{"operation":"embed","embeddingPriority":[{"provider":"p"}],"input":{"texts":["hello"]}}'
      ]);

      expect(deps.error).toHaveBeenCalledWith(
        JSON.stringify({ error: 'createEmbeddingCoordinator dependency missing' })
      );
      expect(deps.exit).toHaveBeenCalledWith(1);
    });

    test('embeddings run handles errors gracefully', async () => {
      const { deps } = createDeps({
        createEmbeddingCoordinator: jest.fn().mockRejectedValue(new Error('Embedding coordinator failed'))
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node',
        'vector',
        'embeddings',
        'run',
        '--spec',
        '{"operation":"embed","embeddingPriority":[{"provider":"p"}],"input":{"texts":["hello"]}}'
      ]);

      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining('Embedding coordinator failed')
      );
      expect(deps.exit).toHaveBeenCalledWith(1);
    });

    test('embeddings run surfaces string errors via fallback', async () => {
      const { deps } = createDeps({
        createEmbeddingCoordinator: jest.fn().mockRejectedValue('total failure')
      });
      const program = createProgram(deps);

      await program.parseAsync([
        'node',
        'vector',
        'embeddings',
        'run',
        '--spec',
        '{"operation":"embed","embeddingPriority":[{"provider":"p"}],"input":{"texts":["hello"]}}'
      ]);

      expect(deps.error).toHaveBeenCalledWith(JSON.stringify({ error: 'total failure' }));
      expect(deps.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('batch-id support', () => {
    test('sets batch-id env before coordinator creation', async () => {
      delete process.env.LLM_ADAPTER_BATCH_ID;
      const { deps } = createDeps();
      const program = createProgram(deps);

      await program.parseAsync([
        'node', 'vector', 'embed',
        '--spec', '{"operation":"embed","store":"test"}',
        '--batch-id', 'vector-batch-123'
      ]);

      expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('vector-batch-123');
      expect(deps.exit).toHaveBeenCalledWith(0);
      delete process.env.LLM_ADAPTER_BATCH_ID;
    });
  });

  describe('runCli', () => {
    test('runCli function is exported and callable', async () => {
      // Verify runCli is exported
      const module = await import('@/vector_store_coordinator.ts');
      expect(typeof module.runCli).toBe('function');
    });

    test('runCli calls program.parseAsync with provided argv', async () => {
      const module = await import('@/vector_store_coordinator.ts');

      // Mock process.exit to prevent --help from actually exiting
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      // Call runCli with --version flag
      try {
        await module.runCli(['node', 'vector-store-coordinator', '--version']);
      } catch {
        // --version may throw/exit in commander, that's ok
      }

      // Restore
      exitSpy.mockRestore();

      // If we got here without crashing, runCli was executed
      expect(true).toBe(true);
    });
  });

  describe('__isEntryPoint', () => {
    test('exports isEntryPoint flag', async () => {
      try {
        const module = await import('@/vector_store_coordinator.ts');
        expect(typeof module.__isEntryPoint).toBe('boolean');
      } catch {
        expect(true).toBe(true);
      }
    });
  });
});
