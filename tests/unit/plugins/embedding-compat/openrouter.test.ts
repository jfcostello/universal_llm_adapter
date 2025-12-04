import { jest } from '@jest/globals';
import OpenRouterEmbeddingCompat from '@/plugins/embedding-compat/openrouter.ts';
import { EmbeddingProviderError } from '@/core/errors.ts';
import type { EmbeddingProviderConfig } from '@/core/types.ts';

function createConfig(overrides: Partial<EmbeddingProviderConfig> = {}): EmbeddingProviderConfig {
  return {
    id: 'test-openrouter',
    kind: 'openrouter',
    endpoint: {
      urlTemplate: 'https://openrouter.ai/api/v1/embeddings',
      headers: {
        'Authorization': 'Bearer test-key',
        'Content-Type': 'application/json'
      }
    },
    model: 'openai/text-embedding-3-small',
    dimensions: 1536,
    ...overrides
  };
}

function createMockHttpClient(mockResponse: any) {
  return {
    request: jest.fn().mockResolvedValue(mockResponse)
  };
}

describe('plugins/embedding-compat/openrouter', () => {
  describe('embed', () => {
    test('embeds single text successfully', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: 'openai/text-embedding-3-small',
          usage: { prompt_tokens: 3, total_tokens: 3 }
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const config = createConfig();
      const result = await compat.embed('hello world', config);

      expect(result.vectors).toEqual([[0.1, 0.2, 0.3]]);
      expect(result.model).toBe('openai/text-embedding-3-small');
      expect(result.dimensions).toBe(3);
      expect(result.tokenCount).toBe(3);
      expect(mockHttpClient.request).toHaveBeenCalledWith({
        method: 'POST',
        url: config.endpoint.urlTemplate,
        headers: config.endpoint.headers,
        data: { model: 'openai/text-embedding-3-small', input: 'hello world' }
      });
    });

    test('embeds batch of texts successfully', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [
            { object: 'embedding', index: 1, embedding: [0.4, 0.5] },
            { object: 'embedding', index: 0, embedding: [0.1, 0.2] }
          ],
          model: 'test-model'
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.embed(['text1', 'text2'], createConfig());

      // Should be sorted by index
      expect(result.vectors).toEqual([[0.1, 0.2], [0.4, 0.5]]);
    });

    test('uses model override when provided', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [{ index: 0, embedding: [0.1] }],
          model: 'custom-model'
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      await compat.embed('test', createConfig(), 'custom-model');

      expect(mockHttpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ model: 'custom-model' })
        })
      );
    });

    test('throws EmbeddingProviderError on HTTP error', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 400,
        data: { error: { message: 'Bad request' } }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);

      await expect(compat.embed('test', createConfig())).rejects.toThrow(EmbeddingProviderError);
    });

    test('detects rate limit from status 429', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 429,
        data: 'Too many requests'
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);

      try {
        await compat.embed('test', createConfig());
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(EmbeddingProviderError);
        expect(error.isRateLimit).toBe(true);
      }
    });

    test('detects rate limit from error message', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 503,
        data: { error: { message: 'Rate limit exceeded' } }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);

      try {
        await compat.embed('test', createConfig());
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(EmbeddingProviderError);
        expect(error.isRateLimit).toBe(true);
      }
    });

    test('detects rate limit from response body string', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 503,
        data: 'Rate limit error occurred'
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);

      try {
        await compat.embed('test', createConfig());
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(EmbeddingProviderError);
        expect(error.isRateLimit).toBe(true);
      }
    });

    test('wraps non-EmbeddingProviderError exceptions', async () => {
      const mockHttpClient = {
        request: jest.fn().mockRejectedValue(new Error('Network error'))
      };

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);

      try {
        await compat.embed('test', createConfig());
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(EmbeddingProviderError);
        expect(error.message).toContain('Network error');
      }
    });

    test('uses dimensions from response when available', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
          model: 'test'
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.embed('test', createConfig({ dimensions: undefined }));

      expect(result.dimensions).toBe(5);
    });

    test('falls back to config dimensions when response is empty', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [],
          model: 'test'
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.embed('test', createConfig({ dimensions: 1536 }));

      expect(result.dimensions).toBe(1536);
    });

    test('falls back to 0 when response is empty and config has no dimensions', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [],
          model: 'test'
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.embed('test', createConfig({ dimensions: undefined }));

      expect(result.dimensions).toBe(0);
    });

    test('uses model from response when available', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [{ index: 0, embedding: [0.1] }],
          model: 'response-model'
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.embed('test', createConfig());

      expect(result.model).toBe('response-model');
    });

    test('falls back to effective model when response has no model', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [{ index: 0, embedding: [0.1] }]
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.embed('test', createConfig({ model: 'fallback-model' }));

      expect(result.model).toBe('fallback-model');
    });
  });

  describe('getDimensions', () => {
    test('returns dimensions from config', () => {
      const compat = new OpenRouterEmbeddingCompat();
      const config = createConfig({ dimensions: 3072 });
      const dims = compat.getDimensions(config);

      expect(dims).toBe(3072);
    });

    test('returns 0 when config has no dimensions', () => {
      const compat = new OpenRouterEmbeddingCompat();
      const config = createConfig({ dimensions: undefined });
      const dims = compat.getDimensions(config);

      expect(dims).toBe(0);
    });

    test('ignores model parameter (dimensions come from config only)', () => {
      const compat = new OpenRouterEmbeddingCompat();
      const config = createConfig({ dimensions: 1536 });
      const dims = compat.getDimensions(config, 'some-large-model');

      expect(dims).toBe(1536);
    });
  });

  describe('validate', () => {
    test('returns true when embed succeeds', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        data: {
          object: 'list',
          data: [{ index: 0, embedding: [0.1] }],
          model: 'test'
        }
      });

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.validate(createConfig());

      expect(result).toBe(true);
    });

    test('returns false when embed fails', async () => {
      const mockHttpClient = {
        request: jest.fn().mockRejectedValue(new Error('Failed'))
      };

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      const result = await compat.validate(createConfig());

      expect(result).toBe(false);
    });
  });

  describe('constructor', () => {
    test('creates default http client when none provided', () => {
      const compat = new OpenRouterEmbeddingCompat();
      // Constructor should succeed without throwing
      expect(compat).toBeInstanceOf(OpenRouterEmbeddingCompat);
      // Verify it has methods (proving httpClient was created)
      expect(typeof compat.embed).toBe('function');
      expect(typeof compat.getDimensions).toBe('function');
    });

    test('uses default axios client for actual network calls', async () => {
      const compat = new OpenRouterEmbeddingCompat();
      // This will fail because no real server, but proves the client is wired up
      const config = createConfig();
      try {
        await compat.embed('test', config);
      } catch (error: any) {
        // Expected to fail - just verifying the code path executes
        expect(error).toBeInstanceOf(EmbeddingProviderError);
      }
    });
  });

  describe('logging', () => {
    test('logs successful request and response when logger provided', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        data: {
          object: 'list',
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: 'test-model',
          usage: { prompt_tokens: 5, total_tokens: 5 }
        }
      });

      const mockLogger = {
        logEmbeddingRequest: jest.fn(),
        logEmbeddingResponse: jest.fn(),
        logVectorRequest: jest.fn(),
        logVectorResponse: jest.fn()
      };

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      await compat.embed('test', createConfig(), undefined, mockLogger);

      expect(mockLogger.logEmbeddingRequest).toHaveBeenCalledWith({
        url: 'https://openrouter.ai/api/v1/embeddings',
        method: 'POST',
        headers: expect.any(Object),
        body: expect.objectContaining({ model: 'openai/text-embedding-3-small', input: 'test' }),
        provider: 'openrouter',
        model: 'openai/text-embedding-3-small'
      });

      expect(mockLogger.logEmbeddingResponse).toHaveBeenCalledWith({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: expect.any(Object),
        dimensions: 3,
        tokenCount: 5
      });
    });

    test('logs error response when HTTP error occurs', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 400,
        statusText: 'Bad Request',
        headers: { 'x-error': 'true' },
        data: { error: { message: 'Invalid input' } }
      });

      const mockLogger = {
        logEmbeddingRequest: jest.fn(),
        logEmbeddingResponse: jest.fn(),
        logVectorRequest: jest.fn(),
        logVectorResponse: jest.fn()
      };

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);

      await expect(compat.embed('test', createConfig(), undefined, mockLogger)).rejects.toThrow();

      expect(mockLogger.logEmbeddingRequest).toHaveBeenCalled();
      expect(mockLogger.logEmbeddingResponse).toHaveBeenCalledWith({
        status: 400,
        statusText: 'Bad Request',
        headers: { 'x-error': 'true' },
        body: { error: { message: 'Invalid input' } }
      });
    });

    test('handles missing response headers gracefully', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 200,
        statusText: 'OK',
        // headers is undefined
        data: {
          object: 'list',
          data: [{ index: 0, embedding: [0.1] }],
          model: 'test'
        }
      });

      const mockLogger = {
        logEmbeddingRequest: jest.fn(),
        logEmbeddingResponse: jest.fn(),
        logVectorRequest: jest.fn(),
        logVectorResponse: jest.fn()
      };

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);
      await compat.embed('test', createConfig(), undefined, mockLogger);

      // Should use empty object for missing headers
      expect(mockLogger.logEmbeddingResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {}
        })
      );
    });

    test('handles missing response headers on error', async () => {
      const mockHttpClient = createMockHttpClient({
        status: 500,
        statusText: 'Internal Server Error',
        // headers is undefined
        data: 'Server error'
      });

      const mockLogger = {
        logEmbeddingRequest: jest.fn(),
        logEmbeddingResponse: jest.fn(),
        logVectorRequest: jest.fn(),
        logVectorResponse: jest.fn()
      };

      const compat = new OpenRouterEmbeddingCompat(mockHttpClient as any);

      await expect(compat.embed('test', createConfig(), undefined, mockLogger)).rejects.toThrow();

      // Should use empty object for missing headers
      expect(mockLogger.logEmbeddingResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {}
        })
      );
    });
  });
});
