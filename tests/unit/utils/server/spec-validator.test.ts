import { assertValidSpec, resolveAjvConstructor } from '@/utils/server/internal/spec-validator.ts';

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

  test('resolveAjvConstructor uses default when present', () => {
    const ctor = () => {};
    expect(resolveAjvConstructor({ default: ctor })).toBe(ctor);
  });

  test('resolveAjvConstructor falls back to module when no default', () => {
    const mod = () => {};
    expect(resolveAjvConstructor(mod)).toBe(mod);
  });
});
