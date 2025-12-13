import { jest } from '@jest/globals';

import type { EmbeddingCoordinator } from '@/coordinator/embedding-coordinator.ts';
import type { EmbeddingCallSpec, EmbeddingOperationResult } from '@/core/embedding-spec-types.ts';

function createMockRegistry(options: {
  embeddingProvider?: any;
  embeddingCompat?: any;
  providerError?: Error;
  compatError?: Error;
} = {}) {
  return {
    getEmbeddingProvider: jest.fn().mockImplementation(async () => {
      if (options.providerError) throw options.providerError;
      return (
        options.embeddingProvider ?? {
          id: 'test-embeddings',
          kind: 'test',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 128
        }
      );
    }),
    getEmbeddingCompat: jest.fn().mockImplementation(async () => {
      if (options.compatError) throw options.compatError;
      return (
        options.embeddingCompat ?? {
          embed: jest.fn().mockResolvedValue({
            vectors: [[0.1, 0.2, 0.3]],
            model: 'test-model',
            dimensions: 3
          }),
          getDimensions: jest.fn().mockReturnValue(128),
          validate: jest.fn().mockResolvedValue(true)
        }
      );
    }),
    loadAll: jest.fn().mockResolvedValue(undefined)
  };
}

describe('coordinator/embedding-coordinator', () => {
  let EmbeddingCoordinatorClass: any;

  beforeAll(async () => {
    try {
      const module = await import('@/coordinator/embedding-coordinator.ts');
      EmbeddingCoordinatorClass = module.EmbeddingCoordinator;
    } catch {
      EmbeddingCoordinatorClass = class MockEmbeddingCoordinator {
        constructor(public registry: any) {}
        async execute(spec: EmbeddingCallSpec): Promise<EmbeddingOperationResult> {
          throw new Error('Not implemented');
        }
        async close() {}
      };
    }
  });

  describe('execute', () => {
    test('embed operation returns vectors and dimensions', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2], [0.3, 0.4]],
          model: 'test-model',
          dimensions: 2,
          tokenCount: 12
        }),
        getDimensions: jest.fn().mockReturnValue(2),
        validate: jest.fn().mockResolvedValue(true)
      };

      const registry = createMockRegistry({ embeddingCompat });
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        embeddingPriority: [{ provider: 'test-embeddings' }],
        input: { texts: ['hello', 'world'] }
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('embed');
      expect(result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
      expect(result.model).toBe('test-model');
      expect(result.dimensions).toBe(2);
      expect(result.tokenCount).toBe(12);

      expect(embeddingCompat.embed).toHaveBeenCalledWith(
        ['hello', 'world'],
        expect.anything(),
        undefined,
        expect.anything()
      );
    });

    test('embed operation accepts single text', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'm',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(3),
        validate: jest.fn().mockResolvedValue(true)
      };

      const registry = createMockRegistry({ embeddingCompat });
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        embeddingPriority: [{ provider: 'test-embeddings' }],
        input: { text: 'hello' }
      });

      expect(result.success).toBe(true);
      expect(result.vectors?.length).toBe(1);
      expect(embeddingCompat.embed).toHaveBeenCalledWith(
        'hello',
        expect.anything(),
        undefined,
        expect.anything()
      );
    });

    test('embed operation requires embeddingPriority', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        input: { texts: ['hello'] }
      } as any);

      expect(result.success).toBe(false);
      expect(result.operation).toBe('embed');
      expect(String(result.error)).toContain('embeddingPriority is required');
    });

    test('embed operation rejects empty embeddingPriority', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        embeddingPriority: [],
        input: { texts: ['hello'] }
      });

      expect(result.success).toBe(false);
      expect(result.operation).toBe('embed');
      expect(String(result.error)).toContain('embeddingPriority is required');
    });

    test('embed operation requires input.text or input.texts', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        embeddingPriority: [{ provider: 'test-embeddings' }]
      } as any);

      expect(result.success).toBe(false);
      expect(result.operation).toBe('embed');
      expect(String(result.error)).toContain('input.text or input.texts is required');
    });

    test('embed operation rejects empty input.texts', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        embeddingPriority: [{ provider: 'test-embeddings' }],
        input: { texts: [] }
      });

      expect(result.success).toBe(false);
      expect(result.operation).toBe('embed');
      expect(String(result.error)).toContain('input.text or input.texts is required');
    });

    test('dimensions operation calls getDimensions', async () => {
      const embeddingCompat = {
        embed: jest.fn(),
        getDimensions: jest.fn().mockReturnValue(256),
        validate: jest.fn().mockResolvedValue(true)
      };

      const registry = createMockRegistry({ embeddingCompat });
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'dimensions',
        provider: 'test-embeddings'
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('dimensions');
      expect(result.dimensions).toBe(256);
      expect(embeddingCompat.getDimensions).toHaveBeenCalled();
    });

    test('dimensions operation requires provider', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({ operation: 'dimensions' } as any);

      expect(result.success).toBe(false);
      expect(result.operation).toBe('dimensions');
      expect(String(result.error)).toContain('provider is required');
    });

    test('validate operation calls validate when available', async () => {
      const embeddingCompat = {
        embed: jest.fn(),
        getDimensions: jest.fn().mockReturnValue(1),
        validate: jest.fn().mockResolvedValue(true)
      };

      const registry = createMockRegistry({ embeddingCompat });
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'validate',
        provider: 'test-embeddings'
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('validate');
      expect(result.valid).toBe(true);
      expect(embeddingCompat.validate).toHaveBeenCalled();
      expect(embeddingCompat.embed).not.toHaveBeenCalled();
    });

    test('validate operation requires provider', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({ operation: 'validate' } as any);

      expect(result.success).toBe(false);
      expect(result.operation).toBe('validate');
      expect(String(result.error)).toContain('provider is required');
    });

    test('unknown operation returns success=false', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({ operation: 'nope' } as any);

      expect(result.success).toBe(false);
      expect(result.operation).toBe('nope');
      expect(String(result.error)).toContain('Unknown operation');
    });

    test('defaults missing operation to unknown', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute(undefined as any);

      expect(result.success).toBe(false);
      expect(result.operation).toBe('unknown');
      expect(String(result.error)).toContain('Unknown operation');
    });

    test('returns success=false when underlying manager throws', async () => {
      const embeddingCompat = {
        embed: jest.fn().mockRejectedValue(new Error('API boom')),
        getDimensions: jest.fn().mockReturnValue(1),
        validate: jest.fn().mockResolvedValue(true)
      };

      const registry = createMockRegistry({ embeddingCompat });
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'embed',
        embeddingPriority: [{ provider: 'test-embeddings' }],
        input: { texts: ['hello'] }
      });

      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('API boom');
    });

    test('formats non-Error throws into error message string', async () => {
      const registry: any = createMockRegistry();
      registry.getEmbeddingProvider.mockImplementation(async () => {
        throw 'provider boom';
      });

      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);

      const result = await coordinator.execute({
        operation: 'dimensions',
        provider: 'test-embeddings'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('provider boom');
    });
  });

  describe('close', () => {
    test('is a no-op', async () => {
      const registry = createMockRegistry();
      const coordinator: EmbeddingCoordinator = new EmbeddingCoordinatorClass(registry);
      await expect(coordinator.close()).resolves.toBeUndefined();
    });
  });
});
