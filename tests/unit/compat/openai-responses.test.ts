import OpenAIResponsesCompat from '@/plugins/compat/openai-responses/index.ts';

describe('compat/openai-responses', () => {
  let compat: OpenAIResponsesCompat;

  beforeEach(() => {
    compat = new OpenAIResponsesCompat();
  });

  describe('serializeSettings', () => {
    test('maps reasoning.enabled + budget to a default reasoning.effort', () => {
      const result = (compat as any).serializeSettings({
        reasoning: { enabled: true, budget: 1024 }
      });

      expect(result.reasoning).toBeDefined();
      expect(result.reasoning.effort).toBe('low');
    });

    test('defaults derived effort to "medium" when enabled without budget/effort', () => {
      const result = (compat as any).serializeSettings({
        reasoning: { enabled: true }
      });

      expect(result.reasoning).toEqual({ effort: 'medium' });
    });

    test('derives effort from budget when enabled is omitted', () => {
      const result = (compat as any).serializeSettings({
        reasoning: { budget: 2048 }
      });

      expect(result.reasoning).toEqual({ effort: 'medium' });
    });

    test('derives "minimal" effort for non-positive budgets', () => {
      const result = (compat as any).serializeSettings({
        reasoning: { enabled: true, budget: 0 }
      });

      expect(result.reasoning).toEqual({ effort: 'minimal' });
    });

    test('derives "high" effort for large budgets', () => {
      const result = (compat as any).serializeSettings({
        reasoning: { enabled: true, budget: 5000 }
      });

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    test('uses explicit reasoning.effort when provided', () => {
      const result = (compat as any).serializeSettings({
        reasoning: { enabled: true, effort: 'high' }
      });

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    test('omits reasoning when reasoning.enabled is false', () => {
      const result = (compat as any).serializeSettings({
        reasoning: { enabled: false, effort: 'high' }
      });

      expect(result.reasoning).toBeUndefined();
    });
  });
});
