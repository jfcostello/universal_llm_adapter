import { jest } from '@jest/globals';
import TestEmbeddingCompat from '@/plugins/embedding-compat/test/index.ts';
import type { EmbeddingProviderConfig, IEmbeddingOperationLogger } from '@/modules/kernel/index.ts';

function createConfig(overrides: Partial<EmbeddingProviderConfig> = {}): EmbeddingProviderConfig {
  return {
    id: 'test-embeddings',
    kind: 'test',
    endpoint: {
      urlTemplate: 'http://localhost/embeddings',
      headers: { 'Content-Type': 'application/json' }
    },
    model: 'test-model',
    dimensions: 8,
    ...overrides
  };
}

describe('plugins/embedding-compat/test', () => {
  test('embeds a single text with no logger', async () => {
    const compat = new TestEmbeddingCompat();
    const result = await compat.embed('hello world', createConfig());

    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(8);
    expect(result.model).toBe('test-model');
    expect(result.dimensions).toBe(8);
    expect(result.tokenCount).toBe(2);
  });

  test('embeds a batch and logs request/response', async () => {
    const logger: IEmbeddingOperationLogger = {
      logEmbeddingRequest: jest.fn(),
      logEmbeddingResponse: jest.fn()
    };

    const compat = new TestEmbeddingCompat();
    const result = await compat.embed(['a', 'b'], createConfig(), 'override-model', logger);

    expect(result.vectors).toHaveLength(2);
    expect(result.model).toBe('override-model');
    expect((logger.logEmbeddingRequest as any).mock.calls.length).toBe(1);
    expect((logger.logEmbeddingResponse as any).mock.calls.length).toBe(1);
  });

  test('embeds empty text without normalization (covers norm==0)', async () => {
    const compat = new TestEmbeddingCompat();
    const result = await compat.embed('', createConfig({ dimensions: 3 }));
    expect(result.vectors[0]).toEqual([0, 0, 0]);
  });

  test('getDimensions falls back when config.dimensions is missing', async () => {
    const compat = new TestEmbeddingCompat();
    const dimensions = compat.getDimensions(createConfig({ dimensions: undefined }));
    expect(dimensions).toBe(64);
  });

  test('validate checks dimensions > 0', async () => {
    const compat = new TestEmbeddingCompat();
    await expect(compat.validate!(createConfig({ dimensions: 0 }))).resolves.toBe(false);
    await expect(compat.validate!(createConfig({ dimensions: undefined }))).resolves.toBe(true);
  });
});
