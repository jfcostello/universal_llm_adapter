import OpenAIResponsesCompat from '@/plugins/compat/openai-responses/index.ts';
import { Role } from '@/kernel/index.ts';

describe('compat/openai-responses', () => {
  let compat: OpenAIResponsesCompat;

  beforeEach(() => {
    compat = new OpenAIResponsesCompat();
  });

  describe('serializeToolChoice', () => {
    const baseMessages: any[] = [
      { role: Role.USER, content: [{ type: 'text', text: 'hi' }] }
    ];

    const baseTools: any[] = [
      {
        name: 'test.echo',
        description: 'Echo tool',
        parametersJsonSchema: { type: 'object', properties: {} }
      },
      {
        name: 'test.random',
        description: 'Random tool',
        parametersJsonSchema: { type: 'object', properties: {} }
      }
    ];

    test('passes toolChoice string modes through to tool_choice', () => {
      const payloadNone = compat.buildPayload('gpt-4o', {} as any, baseMessages as any, baseTools as any, 'none');
      expect(payloadNone.tool_choice).toBe('none');

      const payloadAuto = compat.buildPayload('gpt-4o', {} as any, baseMessages as any, baseTools as any, 'auto');
      expect(payloadAuto.tool_choice).toBe('auto');

      const payloadRequired = compat.buildPayload('gpt-4o', {} as any, baseMessages as any, baseTools as any, 'required');
      expect(payloadRequired.tool_choice).toBe('required');
    });

    test('serializes ToolChoiceSingle as a function tool_choice object', () => {
      const payload = compat.buildPayload(
        'gpt-4o',
        {} as any,
        baseMessages as any,
        baseTools as any,
        { type: 'single', name: 'test.echo' } as any
      );

      expect(payload.tool_choice).toEqual({ type: 'function', name: 'test.echo' });
    });

    test('serializes ToolChoiceRequired allowed[1] as a function tool_choice object', () => {
      const payload = compat.buildPayload(
        'gpt-4o',
        {} as any,
        baseMessages as any,
        baseTools as any,
        { type: 'required', allowed: ['test.echo'] } as any
      );

      expect(payload.tool_choice).toEqual({ type: 'function', name: 'test.echo' });
    });

    test('serializes ToolChoiceRequired allowed[>1] as an allowed_tools tool_choice object', () => {
      const payload = compat.buildPayload(
        'gpt-4o',
        {} as any,
        baseMessages as any,
        baseTools as any,
        { type: 'required', allowed: ['test.echo', 'test.random'] } as any
      );

      expect(payload.tool_choice).toEqual({
        type: 'allowed_tools',
        mode: 'required',
        tools: [
          { type: 'function', name: 'test.echo' },
          { type: 'function', name: 'test.random' }
        ]
      });
    });

    test('serializes ToolChoiceRequired with empty allowed list as auto', () => {
      const payload = compat.buildPayload(
        'gpt-4o',
        {} as any,
        baseMessages as any,
        baseTools as any,
        { type: 'required', allowed: [] } as any
      );

      expect(payload.tool_choice).toBe('auto');
    });

    test('serializes ToolChoiceRequired with non-array allowed as auto', () => {
      const payload = compat.buildPayload(
        'gpt-4o',
        {} as any,
        baseMessages as any,
        baseTools as any,
        { type: 'required', allowed: undefined } as any
      );

      expect(payload.tool_choice).toBe('auto');
    });
  });

  describe('serializeSettings', () => {
    test('passes through parallelToolCalls as parallel_tool_calls', () => {
      const result = (compat as any).serializeSettings({
        parallelToolCalls: true
      });

      expect(result.parallel_tool_calls).toBe(true);
    });

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
