import {
  assertValidSpec,
  assertValidVectorSpec,
  assertValidEmbeddingSpec,
  resolveAjvConstructor
} from '@/utils/server/internal/transport/spec-validator.ts';

describe('utils/server assertValidSpec', () => {
  test('accepts minimal valid spec', () => {
    expect(() =>
      assertValidSpec({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        llmPriority: [{ provider: 'p', model: 'm' }],
        settings: { temperature: 0 }
      } as any)
    ).not.toThrow();
  });

  test('rejects missing required fields', () => {
    expect(() => assertValidSpec({ messages: [] } as any)).toThrow(/validation/i);
  });

  test('assertValidVectorSpec accepts minimal valid vector spec', () => {
    expect(() =>
      assertValidVectorSpec({
        operation: 'query',
        store: 'test-store',
        input: { vector: [0.1], topK: 1 }
      } as any)
    ).not.toThrow();
  });

  test('assertValidVectorSpec rejects missing required fields', () => {
    expect(() => assertValidVectorSpec({ operation: 'query' } as any)).toThrow(/validation/i);
  });

  test('assertValidEmbeddingSpec accepts minimal valid embedding spec', () => {
    expect(() =>
      assertValidEmbeddingSpec({
        operation: 'embed',
        embeddingPriority: [{ provider: 'p' }],
        input: { texts: ['hello'] }
      } as any)
    ).not.toThrow();
  });

  test('assertValidEmbeddingSpec rejects missing required fields', () => {
    expect(() => assertValidEmbeddingSpec({} as any)).toThrow(/validation/i);
  });

  test('resolveAjvConstructor uses default when present', () => {
    const ctor = () => {};
    expect(resolveAjvConstructor({ default: ctor })).toBe(ctor);
  });

  test('resolveAjvConstructor falls back to module when no default', () => {
    const mod = () => {};
    expect(resolveAjvConstructor(mod)).toBe(mod);
  });
});
