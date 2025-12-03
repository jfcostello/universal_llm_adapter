import { jest } from '@jest/globals';
import { EmbeddingManager } from '@/managers/embedding-manager.ts';
import { EmbeddingError, EmbeddingProviderError } from '@/core/errors.ts';

function createMockRegistry(options: {
  providerConfig?: any;
  compat?: any;
  providerError?: Error;
  compatError?: Error;
} = {}) {
  return {
    getEmbeddingProvider: jest.fn().mockImplementation(async () => {
      if (options.providerError) throw options.providerError;
      return options.providerConfig || {
        id: 'test-provider',
        kind: 'test',
        endpoint: { urlTemplate: 'http://test', headers: {} },
        model: 'test-model',
        dimensions: 128
      };
    }),
    getEmbeddingCompat: jest.fn().mockImplementation(async () => {
      if (options.compatError) throw options.compatError;
      return options.compat || {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(128)
      };
    })
  };
}

describe('managers/embedding-manager', () => {
  describe('embed', () => {
    test('embeds text using first provider in priority', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2, 0.3]],
          model: 'test-model',
          dimensions: 3
        }),
        getDimensions: jest.fn().mockReturnValue(128)
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const result = await manager.embed('hello world', [{ provider: 'test-provider' }]);

      expect(result.vectors).toEqual([[0.1, 0.2, 0.3]]);
      expect(result.model).toBe('test-model');
      expect(compat.embed).toHaveBeenCalled();
    });

    test('falls back to next provider on rate limit error', async () => {
      const failCompat = {
        embed: jest.fn().mockRejectedValue(new EmbeddingProviderError('provider1', 'Rate limit', 429, true)),
        getDimensions: jest.fn()
      };
      const successCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.4, 0.5]],
          model: 'backup-model',
          dimensions: 2
        }),
        getDimensions: jest.fn()
      };

      let callCount = 0;
      const registry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test',
          kind: 'test',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test',
          dimensions: 2
        }),
        getEmbeddingCompat: jest.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1 ? failCompat : successCompat;
        })
      };

      const manager = new EmbeddingManager(registry);

      const result = await manager.embed('test', [
        { provider: 'provider1' },
        { provider: 'provider2' }
      ]);

      expect(result.vectors).toEqual([[0.4, 0.5]]);
      expect(failCompat.embed).toHaveBeenCalled();
      expect(successCompat.embed).toHaveBeenCalled();
    });

    test('falls back to next provider on non-rate-limit provider error', async () => {
      const failCompat = {
        embed: jest.fn().mockRejectedValue(new EmbeddingProviderError('provider1', 'Server error', 500, false)),
        getDimensions: jest.fn()
      };
      const successCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.4, 0.5]],
          model: 'backup-model',
          dimensions: 2
        }),
        getDimensions: jest.fn()
      };

      let callCount = 0;
      const registry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test',
          kind: 'test',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test',
          dimensions: 2
        }),
        getEmbeddingCompat: jest.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1 ? failCompat : successCompat;
        })
      };

      const manager = new EmbeddingManager(registry);

      const result = await manager.embed('test', [
        { provider: 'provider1' },
        { provider: 'provider2' }
      ]);

      expect(result.vectors).toEqual([[0.4, 0.5]]);
      expect(failCompat.embed).toHaveBeenCalled();
      expect(successCompat.embed).toHaveBeenCalled();
    });

    test('throws when all providers fail', async () => {
      const failCompat = {
        embed: jest.fn().mockRejectedValue(new Error('Failed')),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat: failCompat });
      const manager = new EmbeddingManager(registry);

      await expect(manager.embed('test', [{ provider: 'p1' }])).rejects.toThrow(EmbeddingError);
    });

    test('throws with Unknown error when error has no message', async () => {
      const failCompat = {
        embed: jest.fn().mockRejectedValue({}),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat: failCompat });
      const manager = new EmbeddingManager(registry);

      await expect(manager.embed('test', [{ provider: 'p1' }])).rejects.toThrow('Unknown error');
    });

    test('throws when priority list is empty', async () => {
      const registry = createMockRegistry();
      const manager = new EmbeddingManager(registry);

      await expect(manager.embed('test', [])).rejects.toThrow('No embedding providers specified');
    });

    test('passes model override to compat', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'custom-model',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      await manager.embed('test', [{ provider: 'test', model: 'custom-model' }]);

      expect(compat.embed).toHaveBeenCalledWith(
        'test',
        expect.anything(),
        'custom-model'
      );
    });

    test('continues to next provider on config loading error', async () => {
      let callCount = 0;
      const successCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[1, 2]],
          model: 'm',
          dimensions: 2
        }),
        getDimensions: jest.fn()
      };

      const registry = {
        getEmbeddingProvider: jest.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) throw new Error('Config not found');
          return { id: 'p2', kind: 'test', endpoint: {}, model: 'm', dimensions: 2 };
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(successCompat)
      };

      const manager = new EmbeddingManager(registry);
      const result = await manager.embed('test', [{ provider: 'p1' }, { provider: 'p2' }]);

      expect(result.vectors).toEqual([[1, 2]]);
    });
  });

  describe('getDimensions', () => {
    test('returns dimensions from compat', async () => {
      const registry = createMockRegistry();
      const manager = new EmbeddingManager(registry);

      const dims = await manager.getDimensions('test-provider');

      expect(dims).toBe(128);
    });

    test('passes model to compat getDimensions', async () => {
      const compat = {
        embed: jest.fn(),
        getDimensions: jest.fn().mockReturnValue(256)
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const dims = await manager.getDimensions('test-provider', 'large-model');

      expect(dims).toBe(256);
      expect(compat.getDimensions).toHaveBeenCalledWith(expect.anything(), 'large-model');
    });
  });

  describe('createEmbedderFn', () => {
    test('creates function that returns single vector for string input', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2]],
          model: 'm',
          dimensions: 2
        }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const embedFn = manager.createEmbedderFn([{ provider: 'test' }]);
      const result = await embedFn('hello');

      expect(result).toEqual([0.1, 0.2]);
    });

    test('creates function that returns multiple vectors for array input', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1, 0.2], [0.3, 0.4]],
          model: 'm',
          dimensions: 2
        }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const embedFn = manager.createEmbedderFn([{ provider: 'test' }]);
      const result = await embedFn(['hello', 'world']);

      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    });
  });

  describe('validate', () => {
    test('returns true when provider is accessible', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({ vectors: [[1]], model: 'm', dimensions: 1 }),
        getDimensions: jest.fn(),
        validate: jest.fn().mockResolvedValue(true)
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const result = await manager.validate('test-provider');

      expect(result).toBe(true);
      expect(compat.validate).toHaveBeenCalled();
    });

    test('returns false when provider fails', async () => {
      const registry = createMockRegistry({
        providerError: new Error('Not found')
      });
      const manager = new EmbeddingManager(registry);

      const result = await manager.validate('unknown');

      expect(result).toBe(false);
    });

    test('falls back to embed when validate method not present', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({ vectors: [[1]], model: 'm', dimensions: 1 }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const result = await manager.validate('test-provider');

      expect(result).toBe(true);
      expect(compat.embed).toHaveBeenCalledWith('test', expect.anything());
    });
  });
});
