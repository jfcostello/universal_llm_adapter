import { jest } from '@jest/globals';
import { EmbeddingManager } from '@/modules/embeddings/index.ts';
import { EmbeddingError, EmbeddingProviderError, getDefaults } from '@/kernel/index.ts';

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
    afterEach(() => {
      jest.useRealTimers();
    });

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

    test('retries same provider attempt before succeeding', async () => {
      jest.useFakeTimers();

      const compat = {
        embed: jest
          .fn()
          .mockRejectedValueOnce(new EmbeddingProviderError('provider1', 'Temporary server failure', 503, false))
          .mockResolvedValueOnce({
            vectors: [[0.7, 0.8]],
            model: 'test-model',
            dimensions: 2
          }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const promise = manager.embed('retry me', [{ provider: 'provider1' }]);
      await Promise.resolve();
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.vectors).toEqual([[0.7, 0.8]]);
      expect(compat.embed).toHaveBeenCalledTimes(2);
    });

    test('falls back to next provider on rate limit error', async () => {
      jest.useFakeTimers();

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

      const promise = manager.embed('test', [
        { provider: 'provider1' },
        { provider: 'provider2' }
      ]);
      await Promise.resolve();
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.vectors).toEqual([[0.4, 0.5]]);
      expect(failCompat.embed).toHaveBeenCalled();
      expect(successCompat.embed).toHaveBeenCalled();
    });

    test('falls back to next provider on non-rate-limit provider error', async () => {
      jest.useFakeTimers();

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

      const promise = manager.embed('test', [
        { provider: 'provider1' },
        { provider: 'provider2' }
      ]);
      await Promise.resolve();
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.vectors).toEqual([[0.4, 0.5]]);
      expect(failCompat.embed).toHaveBeenCalled();
      expect(successCompat.embed).toHaveBeenCalled();
    });

    test('exhausts retries for a provider before falling back to next provider', async () => {
      jest.useFakeTimers();

      const maxAttempts = getDefaults().retry.maxAttempts;
      const failCompat = {
        embed: jest.fn().mockRejectedValue(new EmbeddingProviderError('provider1', 'Server error', 500, false)),
        getDimensions: jest.fn()
      };
      const successCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.9, 1.0]],
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

      const promise = manager.embed('test', [
        { provider: 'provider1' },
        { provider: 'provider2' }
      ]);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.vectors).toEqual([[0.9, 1.0]]);
      expect(failCompat.embed).toHaveBeenCalledTimes(maxAttempts);
      expect(successCompat.embed).toHaveBeenCalledTimes(1);
    });

    test('throws when all providers fail', async () => {
      jest.useFakeTimers();

      const failCompat = {
        embed: jest.fn().mockRejectedValue(new Error('Failed')),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat: failCompat });
      const manager = new EmbeddingManager(registry);

      const promise = manager.embed('test', [{ provider: 'p1' }]);
      const expectation = expect(promise).rejects.toThrow(EmbeddingError);
      await Promise.resolve();
      await jest.runAllTimersAsync();
      await expectation;
    });

    test('throws with Unknown error when error has no message', async () => {
      jest.useFakeTimers();

      const failCompat = {
        embed: jest.fn().mockRejectedValue({}),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat: failCompat });
      const manager = new EmbeddingManager(registry);

      const promise = manager.embed('test', [{ provider: 'p1' }]);
      const expectation = expect(promise).rejects.toThrow('Unknown error');
      await Promise.resolve();
      await jest.runAllTimersAsync();
      await expectation;
    });

    test('does not treat non-object failures as abort errors', async () => {
      jest.useFakeTimers();

      const failCompat = {
        embed: jest.fn().mockRejectedValue('plain-failure'),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat: failCompat });
      const manager = new EmbeddingManager(registry);

      const promise = manager.embed('test', [{ provider: 'p1' }]);
      const expectation = expect(promise).rejects.toThrow('Unknown error');
      await Promise.resolve();
      await jest.runAllTimersAsync();
      await expectation;
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
        'custom-model',
        undefined, // no logger passed to manager
        undefined
      );
    });

    test('throws when abort signal is already aborted', async () => {
      const compat = {
        embed: jest.fn(),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        manager.embed('test', [{ provider: 'p1' }], { signal: abortController.signal })
      ).rejects.toThrow('Embedding request aborted');
      expect(compat.embed).not.toHaveBeenCalled();
    });

    test('passes signal options to compat when provided', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.1]],
          model: 'test',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);
      const abortController = new AbortController();

      await manager.embed('test', [{ provider: 'test' }], { signal: abortController.signal });

      expect(compat.embed).toHaveBeenCalledWith(
        'test',
        expect.anything(),
        undefined,
        undefined,
        { signal: abortController.signal }
      );
    });

    test('throws when signal aborts between provider fallback attempts', async () => {
      const abortController = new AbortController();
      const firstCompat = {
        embed: jest.fn().mockImplementation(async () => {
          abortController.abort();
          throw new EmbeddingProviderError('p1', 'Rate limit', 429, true);
        }),
        getDimensions: jest.fn()
      };
      const secondCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.2]],
          model: 'p2-model',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };

      let compatCalls = 0;
      const registry = {
        getEmbeddingProvider: jest.fn().mockImplementation(async (providerId: string) => ({
          id: providerId,
          kind: 'test',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: `${providerId}-model`,
          dimensions: 1
        })),
        getEmbeddingCompat: jest.fn().mockImplementation(async () => {
          compatCalls++;
          return compatCalls === 1 ? firstCompat : secondCompat;
        })
      };

      const manager = new EmbeddingManager(registry);

      await expect(
        manager.embed(
          'test',
          [{ provider: 'p1' }, { provider: 'p2' }],
          { signal: abortController.signal }
        )
      ).rejects.toThrow('Embedding request aborted');
      expect(firstCompat.embed).toHaveBeenCalledTimes(1);
      expect(secondCompat.embed).not.toHaveBeenCalled();
    });

    test('checks abort signal at next-provider boundary after a non-abort first failure', async () => {
      const abortController = new AbortController();
      const firstError: any = {
        name: 'ProviderError',
        message: 'temporary failure',
        get code() {
          abortController.abort();
          return 'E_TEMP';
        }
      };

      const firstCompat = {
        embed: jest.fn().mockRejectedValue(firstError),
        getDimensions: jest.fn()
      };
      const secondCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.2]],
          model: 'p2-model',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };

      let compatCalls = 0;
      const registry = {
        getEmbeddingProvider: jest.fn().mockImplementation(async (providerId: string) => ({
          id: providerId,
          kind: 'test',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: `${providerId}-model`,
          dimensions: 1
        })),
        getEmbeddingCompat: jest.fn().mockImplementation(async () => {
          compatCalls++;
          return compatCalls === 1 ? firstCompat : secondCompat;
        })
      };

      const manager = new EmbeddingManager(registry);
      await expect(
        manager.embed('test', [{ provider: 'p1' }, { provider: 'p2' }], { signal: abortController.signal })
      ).rejects.toThrow('Embedding request aborted');
      expect(firstCompat.embed).toHaveBeenCalledTimes(1);
      expect(secondCompat.embed).not.toHaveBeenCalled();
    });

    test('checks abort signal at next-provider boundary after provider config load failure', async () => {
      const abortController = new AbortController();
      let providerCalls = 0;
      const firstError: any = {
        name: 'ProviderConfigError',
        message: 'temporary config failure',
        get code() {
          abortController.abort();
          return 'E_TEMP';
        }
      };
      const compat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.3]],
          model: 'p2-model',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };

      const registry = {
        getEmbeddingProvider: jest.fn().mockImplementation(async (providerId: string) => {
          providerCalls++;
          if (providerCalls === 1) {
            throw firstError;
          }
          return {
            id: providerId,
            kind: 'test',
            endpoint: { urlTemplate: 'http://test', headers: {} },
            model: `${providerId}-model`,
            dimensions: 1
          };
        }),
        getEmbeddingCompat: jest.fn().mockResolvedValue(compat)
      };

      const manager = new EmbeddingManager(registry);

      await expect(
        manager.embed('test', [{ provider: 'p1' }, { provider: 'p2' }], { signal: abortController.signal })
      ).rejects.toThrow('Embedding request aborted');

      expect(registry.getEmbeddingProvider).toHaveBeenCalledTimes(1);
      expect(compat.embed).not.toHaveBeenCalled();
    });

    test('treats AbortError from compat as request cancellation and does not continue fallback', async () => {
      const firstCompat = {
        embed: jest.fn().mockRejectedValue(Object.assign(new Error('canceled'), { name: 'AbortError' })),
        getDimensions: jest.fn()
      };
      const secondCompat = {
        embed: jest.fn().mockResolvedValue({
          vectors: [[0.2]],
          model: 'p2-model',
          dimensions: 1
        }),
        getDimensions: jest.fn()
      };

      let compatCalls = 0;
      const registry = {
        getEmbeddingProvider: jest.fn().mockImplementation(async (providerId: string) => ({
          id: providerId,
          kind: 'test',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: `${providerId}-model`,
          dimensions: 1
        })),
        getEmbeddingCompat: jest.fn().mockImplementation(async () => {
          compatCalls++;
          return compatCalls === 1 ? firstCompat : secondCompat;
        })
      };

      const manager = new EmbeddingManager(registry);
      await expect(
        manager.embed('test', [{ provider: 'p1' }, { provider: 'p2' }], { signal: new AbortController().signal })
      ).rejects.toThrow('Embedding request aborted');
      expect(firstCompat.embed).toHaveBeenCalledTimes(1);
      expect(secondCompat.embed).not.toHaveBeenCalled();
    });

    test('treats cancelation error code from compat as request cancellation', async () => {
      const compat = {
        embed: jest.fn().mockRejectedValue({
          name: 'Error',
          code: 'ERR_CANCELED',
          message: 'provider canceled request'
        }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      await expect(
        manager.embed('test', [{ provider: 'p1' }], { signal: new AbortController().signal })
      ).rejects.toThrow('Embedding request aborted');
    });

    test('treats cancellation message from compat as request cancellation', async () => {
      const compat = {
        embed: jest.fn().mockRejectedValue(new Error('operation cancelled by user')),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      await expect(
        manager.embed('test', [{ provider: 'p1' }], { signal: new AbortController().signal })
      ).rejects.toThrow('Embedding request aborted');
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

    test('prefers getEmbeddingCompatForProvider when available', async () => {
      const compat = {
        embed: jest.fn(),
        getDimensions: jest.fn().mockReturnValue(64)
      };

      const registry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-provider',
          kind: 'test-kind',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 64
        }),
        getEmbeddingCompatForProvider: jest.fn().mockResolvedValue(compat),
        getEmbeddingCompat: jest.fn()
      };

      const manager = new EmbeddingManager(registry as any);
      const dims = await manager.getDimensions('test-provider');

      expect(dims).toBe(64);
      expect(registry.getEmbeddingCompatForProvider).toHaveBeenCalledWith('test-provider');
      expect(registry.getEmbeddingCompat).not.toHaveBeenCalled();
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

    test('prefers getEmbeddingCompatForProvider when available', async () => {
      const compat = {
        embed: jest.fn(),
        getDimensions: jest.fn(),
        validate: jest.fn().mockResolvedValue(true)
      };

      const registry = {
        getEmbeddingProvider: jest.fn().mockResolvedValue({
          id: 'test-provider',
          kind: 'test-kind',
          endpoint: { urlTemplate: 'http://test', headers: {} },
          model: 'test-model',
          dimensions: 64
        }),
        getEmbeddingCompatForProvider: jest.fn().mockResolvedValue(compat),
        getEmbeddingCompat: jest.fn()
      };

      const manager = new EmbeddingManager(registry as any);
      await expect(manager.validate('test-provider')).resolves.toBe(true);
      expect(registry.getEmbeddingCompatForProvider).toHaveBeenCalledWith('test-provider');
      expect(registry.getEmbeddingCompat).not.toHaveBeenCalled();
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
      expect(compat.embed).toHaveBeenCalledWith('test', expect.anything(), undefined, undefined);
    });
  });

  describe('setLogger', () => {
    test('sets the logger for the manager', async () => {
      const compat = {
        embed: jest.fn().mockResolvedValue({ vectors: [[1]], model: 'm', dimensions: 1 }),
        getDimensions: jest.fn()
      };
      const registry = createMockRegistry({ compat });
      const manager = new EmbeddingManager(registry);

      const mockLogger = {
        logEmbeddingRequest: jest.fn(),
        logEmbeddingResponse: jest.fn(),
        logVectorRequest: jest.fn(),
        logVectorResponse: jest.fn()
      };

      manager.setLogger(mockLogger);

      // Embed should now receive the logger
      await manager.embed('test', [{ provider: 'test' }]);

      expect(compat.embed).toHaveBeenCalledWith(
        'test',
        expect.anything(),
        undefined,
        mockLogger,
        undefined
      );
    });
  });
});
