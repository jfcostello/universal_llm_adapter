import { jest } from '@jest/globals';
import AnthropicCompat from '@/plugins/compat/anthropic.ts';
import { ToolCallEventType, Role } from '@/core/types.ts';

/**
 * Extended comprehensive tests for Anthropic provider
 * Covers all permutations from PROVIDER_INTEGRATION_TEST_SPECIFICATION.md
 */
describe('integration/providers/anthropic-provider-extended', () => {
  let compat: AnthropicCompat;

  beforeEach(() => {
    compat = new AnthropicCompat();
  });

  describe('2.1 Message Serialization - All Permutations', () => {
    describe('System messages', () => {
      test('handles system message with empty content array', () => {
        const messages = [
          { role: Role.SYSTEM, content: [] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.system).toBe('');
      });

      test('handles system message with non-text content', () => {
        const messages = [
          { role: Role.SYSTEM, content: [{ type: 'image' as any, imageUrl: 'url' }] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.system).toBe(''); // Non-text filtered out
      });

      test('handles multiple system messages (only first is used)', () => {
        const messages = [
          { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'First. ' }] },
          { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'Second.' }] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Anthropic implementation only uses first system message
        expect(payload.system).toBe('First. ');
        expect(payload.messages).toHaveLength(1); // Only user message
      });
    });

    describe('User messages', () => {
      test('handles user message with empty content array', () => {
        const messages = [{ role: Role.USER, content: [] }];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages[0].content).toEqual([]);
      });

      test('handles user message with empty string text (filtered)', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '' }] }];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Anthropic filters empty text blocks
        expect(payload.messages[0].content).toEqual([]);
      });

      test('handles user message with whitespace-only text (filtered)', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '   ' }] }];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Anthropic filters whitespace-only text
        expect(payload.messages[0].content).toEqual([]);
      });

      test('handles user message with mixed empty and valid text', () => {
        const messages = [
          {
            role: Role.USER,
            content: [
              { type: 'text' as const, text: '' },
              { type: 'text' as const, text: 'valid' },
              { type: 'text' as const, text: '   ' }
            ]
          }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Only valid text remains
        expect(payload.messages[0].content).toHaveLength(1);
        expect(payload.messages[0].content[0].text).toBe('valid');
      });
    });

    describe('Assistant messages', () => {
      test('handles assistant message with empty content array', () => {
        const messages = [{ role: Role.ASSISTANT, content: [] }];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages[0].content).toEqual([]);
      });

      test('handles consecutive assistant messages', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'First' }] },
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'Second' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages).toHaveLength(2);
        expect(payload.messages[0].role).toBe('assistant');
        expect(payload.messages[1].role).toBe('assistant');
      });

      test('handles assistant message with empty string text (filtered)', () => {
        const messages = [{ role: Role.ASSISTANT, content: [{ type: 'text' as const, text: '' }] }];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages[0].content).toEqual([]);
      });
    });

    describe('Tool messages', () => {
      test('handles tool message without toolCallId', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }] },
          { role: Role.TOOL, content: [{ type: 'text' as const, text: 'result' }] } as any
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        const userMsg = payload.messages.find((m: any) => m.role === 'user');
        expect(userMsg.content[0].tool_use_id).toBeUndefined();
      });

      test('flushes tool results before consecutive assistant messages', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }] },
          { role: Role.TOOL, toolCallId: 'call-1', content: [{ type: 'text' as const, text: 'result1' }] },
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'Second assistant' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Should have: assistant, user (with tool result), assistant
        expect(payload.messages).toHaveLength(3);
        expect(payload.messages[0].role).toBe('assistant');
        expect(payload.messages[1].role).toBe('user');
        expect(payload.messages[2].role).toBe('assistant');
      });

      test('handles multiple consecutive tool results', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [
            { id: 'call-1', name: 'test1', arguments: {} },
            { id: 'call-2', name: 'test2', arguments: {} }
          ]},
          { role: Role.TOOL, toolCallId: 'call-1', content: [{ type: 'text' as const, text: 'result1' }] },
          { role: Role.TOOL, toolCallId: 'call-2', content: [{ type: 'text' as const, text: 'result2' }] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'Continue' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // User message should have both tool results
        const userMsg = payload.messages.find((m: any) => m.role === 'user' && m.content.some((c: any) => c.type === 'tool_result'));
        expect(userMsg.content.filter((c: any) => c.type === 'tool_result')).toHaveLength(2);
      });

      test('creates user message for pending tool results at end', () => {
        const messages = [
          { role: Role.USER, content: [{ type: 'text' as const, text: 'Call tool' }] },
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }] },
          { role: Role.TOOL, toolCallId: 'call-1', content: [{ type: 'text' as const, text: 'result' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Last message should be user with tool result
        const lastMsg = payload.messages[payload.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(lastMsg.content[0].type).toBe('tool_result');
      });
    });
  });

  describe('2.4 Settings - Individual Parameter Tests', () => {
    test('temperature: defined', () => {
      const payload = compat.buildPayload('claude-3', { temperature: 0.5 }, [], [], undefined);
      expect(payload.temperature).toBe(0.5);
    });

    test('temperature: undefined', () => {
      const payload = compat.buildPayload('claude-3', {}, [], [], undefined);
      expect(payload.temperature).toBeUndefined();
    });

    test('temperature: zero', () => {
      const payload = compat.buildPayload('claude-3', { temperature: 0 }, [], [], undefined);
      expect(payload.temperature).toBe(0);
    });

    test('topP: defined', () => {
      const payload = compat.buildPayload('claude-3', { topP: 0.9 }, [], [], undefined);
      expect(payload.top_p).toBe(0.9);
    });

    test('topP: undefined', () => {
      const payload = compat.buildPayload('claude-3', {}, [], [], undefined);
      expect(payload.top_p).toBeUndefined();
    });

    test('topP: 1.0', () => {
      const payload = compat.buildPayload('claude-3', { topP: 1.0 }, [], [], undefined);
      expect(payload.top_p).toBe(1.0);
    });

    test('maxTokens: defined', () => {
      const payload = compat.buildPayload('claude-3', { maxTokens: 100 }, [], [], undefined);
      expect(payload.max_tokens).toBe(100);
    });

    test('maxTokens: undefined (defaults to 8192)', () => {
      const payload = compat.buildPayload('claude-3', {}, [], [], undefined);
      expect(payload.max_tokens).toBe(8192);
    });

    test('maxTokens: 1 (minimum)', () => {
      const payload = compat.buildPayload('claude-3', { maxTokens: 1 }, [], [], undefined);
      expect(payload.max_tokens).toBe(1);
    });

    test('stop: single sequence (renamed to stop_sequences)', () => {
      const payload = compat.buildPayload('claude-3', { stop: ['STOP'] }, [], [], undefined);
      expect(payload.stop_sequences).toEqual(['STOP']);
    });

    test('stop: multiple sequences', () => {
      const payload = compat.buildPayload('claude-3', { stop: ['STOP', 'END', '###'] }, [], [], undefined);
      expect(payload.stop_sequences).toEqual(['STOP', 'END', '###']);
    });

    test('stop: empty array', () => {
      const payload = compat.buildPayload('claude-3', { stop: [] }, [], [], undefined);
      expect(payload.stop_sequences).toEqual([]);
    });

    test('stop: undefined', () => {
      const payload = compat.buildPayload('claude-3', {}, [], [], undefined);
      expect(payload.stop_sequences).toBeUndefined();
    });

    test('unsupported setting: seed (not included)', () => {
      const payload = compat.buildPayload('claude-3', { seed: 42 } as any, [], [], undefined);
      expect((payload as any).seed).toBeUndefined();
    });

    test('unsupported setting: frequencyPenalty (not included)', () => {
      const payload = compat.buildPayload('claude-3', { frequencyPenalty: 0.5 } as any, [], [], undefined);
      expect((payload as any).frequency_penalty).toBeUndefined();
    });

    test('unsupported setting: presencePenalty (not included)', () => {
      const payload = compat.buildPayload('claude-3', { presencePenalty: 0.5 } as any, [], [], undefined);
      expect((payload as any).presence_penalty).toBeUndefined();
    });

    test('unsupported setting: logitBias (not included)', () => {
      const payload = compat.buildPayload('claude-3', { logitBias: { 123: -100 } } as any, [], [], undefined);
      expect((payload as any).logit_bias).toBeUndefined();
    });

    test('unsupported setting: logprobs (not included)', () => {
      const payload = compat.buildPayload('claude-3', { logprobs: true } as any, [], [], undefined);
      expect((payload as any).logprobs).toBeUndefined();
    });
  });

  describe('2.5 Reasoning/Thinking - Comprehensive', () => {
    test('enables thinking only when ALL assistant messages have reasoning', () => {
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: 'q1' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a1' }], reasoning: { text: 't1' } },
        { role: Role.USER, content: [{ type: 'text' as const, text: 'q2' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a2' }], reasoning: { text: 't2' } }
      ];
      const settings = { reasoning: { enabled: true } };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.thinking).toBeDefined();
      expect(payload.thinking?.type).toBe('enabled');
    });

    test('disables thinking when even one assistant message lacks reasoning', () => {
      const messages = [
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a1' }], reasoning: { text: 't1' } },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a2' }] } // No reasoning
      ];
      const settings = { reasoning: { enabled: true } };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.thinking).toBeUndefined();
    });

    test('disables thinking when reasoning.enabled is false', () => {
      const messages = [
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a1' }], reasoning: { text: 't1' } }
      ];
      const settings = { reasoning: { enabled: false } };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.thinking).toBeUndefined();
    });

    test('includes redacted reasoning (ignores redacted flag)', () => {
      const messages = [
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a' }], reasoning: { text: 'secret', redacted: true } }
      ];
      const settings = { reasoning: { enabled: true } };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.messages[0].content[0]).toMatchObject({
        type: 'thinking',
        thinking: 'secret'
      });
    });

    test('preserves signature in thinking block', () => {
      const messages = [
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a' }], reasoning: { text: 't', metadata: { signature: 'sig123', other: 'data' } } }
      ];
      const settings = { reasoning: { enabled: true } };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.messages[0].content[0]).toMatchObject({
        type: 'thinking',
        thinking: 't',
        signature: 'sig123'
      });
    });

    test('uses reasoningBudget fallback', () => {
      const messages = [
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a' }], reasoning: { text: 't' } }
      ];
      const settings = { reasoning: { enabled: true }, reasoningBudget: 10000 };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.thinking?.budget_tokens).toBe(10000);
    });

    test('uses default budget when not specified', () => {
      const messages = [
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a' }], reasoning: { text: 't' } }
      ];
      const settings = { reasoning: { enabled: true } };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.thinking?.budget_tokens).toBe(51200);
    });

    test('maintains thinking block order: thinking → text → tool_use', () => {
      const messages = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text' as const, text: 'I will call a tool' }],
          reasoning: { text: 'I should use the weather tool' },
          toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: {} }]
        }
      ];
      const settings = { reasoning: { enabled: true } };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.messages[0].content[0].type).toBe('thinking');
      expect(payload.messages[0].content[1].type).toBe('text');
      expect(payload.messages[0].content[2].type).toBe('tool_use');
    });

    test('uses reasoning.budget over reasoningBudget', () => {
      const messages = [
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'a' }], reasoning: { text: 't' } }
      ];
      const settings = { reasoning: { enabled: true, budget: 5000 }, reasoningBudget: 10000 };
      const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

      expect(payload.thinking?.budget_tokens).toBe(5000);
    });
  });

  describe('4. Response Parsing - Edge Cases', () => {
    test('parses response with null content', () => {
      const raw = { content: null, stop_reason: 'end_turn' };
      const unified = compat.parseResponse(raw as any, 'claude-3');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parses response with undefined content', () => {
      const raw = { stop_reason: 'end_turn' };
      const unified = compat.parseResponse(raw as any, 'claude-3');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parses response with empty content array', () => {
      const raw = { content: [], stop_reason: 'end_turn' };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('handles content with only thinking block', () => {
      const raw = {
        content: [{ type: 'thinking', thinking: 'thought' }],
        stop_reason: 'end_turn'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      // Text content should be empty, reasoning extracted
      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
      expect(unified.reasoning?.text).toBe('thought');
    });

    test('parses tool_use with null input', () => {
      const raw = {
        content: [{ type: 'tool_use', id: 'call-1', name: 'test', input: null }],
        stop_reason: 'tool_use'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.toolCalls?.[0].arguments).toEqual({});
    });

    test('parses tool_use with undefined input', () => {
      const raw = {
        content: [{ type: 'tool_use', id: 'call-1', name: 'test' }],
        stop_reason: 'tool_use'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.toolCalls?.[0].arguments).toEqual({});
    });

    test('parses tool_use with missing id (generates default)', () => {
      const raw = {
        content: [{ type: 'tool_use', name: 'test', input: {} }],
        stop_reason: 'tool_use'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.toolCalls?.[0].id).toBe('call_0');
    });

    test('handles usage with null values', () => {
      const raw = {
        content: [{ type: 'text', text: 'test' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: null,
          output_tokens: null
        }
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.usage?.promptTokens).toBeNull();
      expect(unified.usage?.completionTokens).toBeNull();
    });

    test('handles thinking with null signature', () => {
      const raw = {
        content: [
          { type: 'thinking', thinking: 'thought', signature: null },
          { type: 'text', text: 'answer' }
        ],
        stop_reason: 'end_turn'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      // Null signature is not added to metadata
      expect(unified.reasoning?.metadata?.signature).toBeUndefined();
    });
  });

  describe('5. Finish Reason Mapping - All Variants', () => {
    test('maps end_turn to stop', () => {
      const raw = {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.finishReason).toBe('stop');
    });

    test('maps max_tokens to length', () => {
      const raw = {
        content: [{ type: 'text', text: 'cut off' }],
        stop_reason: 'max_tokens'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.finishReason).toBe('length');
    });

    test('maps tool_use to tool_calls', () => {
      const raw = {
        content: [{ type: 'tool_use', id: 'call-1', name: 'test', input: {} }],
        stop_reason: 'tool_use'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.finishReason).toBe('tool_calls');
    });

    test('maps stop_sequence to stop', () => {
      const raw = {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'stop_sequence'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.finishReason).toBe('stop');
    });

    test('handles null stop_reason', () => {
      const raw = {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: null
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.finishReason).toBeUndefined();
    });

    test('handles undefined stop_reason', () => {
      const raw = {
        content: [{ type: 'text', text: 'done' }]
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.finishReason).toBeUndefined();
    });

    test('handles unknown stop_reason (passes through)', () => {
      const raw = {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'unknown_reason'
      };
      const unified = compat.parseResponse(raw, 'claude-3');

      expect(unified.finishReason).toBe('unknown_reason');
    });
  });

  describe('6. Streaming - Edge Cases', () => {
    test('handles chunk with null type', () => {
      const chunk = { type: null };
      const parsed = compat.parseStreamChunk(chunk as any);

      expect(parsed).toBeDefined();
    });

    test('handles chunk with undefined type', () => {
      const chunk = {};
      const parsed = compat.parseStreamChunk(chunk as any);

      expect(parsed).toBeDefined();
    });

    test('handles content_block_start with null content_block', () => {
      const chunk = {
        type: 'content_block_start',
        index: 0,
        content_block: null
      };

      // Null content_block causes error
      expect(() => compat.parseStreamChunk(chunk as any)).toThrow();
    });

    test('handles content_block_delta with null delta', () => {
      const chunk = {
        type: 'content_block_delta',
        index: 0,
        delta: null
      };

      // Null delta causes error
      expect(() => compat.parseStreamChunk(chunk as any)).toThrow();
    });

    test('handles text_delta with empty text', () => {
      const chunk = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '' }
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.text).toBe('');
    });

    test('handles input_json_delta for unknown content block', () => {
      const chunk = {
        type: 'content_block_delta',
        index: 99, // No corresponding start
        delta: { type: 'input_json_delta', partial_json: '{}' }
      };
      const parsed = compat.parseStreamChunk(chunk);

      // Should not emit events for unknown block
      expect(parsed.toolEvents).toBeUndefined();
    });

    test('handles content_block_stop for unknown content block', () => {
      const chunk = {
        type: 'content_block_stop',
        index: 99 // No corresponding start
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.toolEvents).toBeUndefined();
    });

    test('handles multiple tool calls in same message', () => {
      const compat2 = new AnthropicCompat();

      // Start first tool
      compat2.parseStreamChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'tool1' }
      });

      // Start second tool
      compat2.parseStreamChunk({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call-2', name: 'tool2' }
      });

      // Delta for first
      compat2.parseStreamChunk({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' }
      });

      // Delta for second
      const parsed = compat2.parseStreamChunk({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"b":2}' }
      });

      expect(parsed.toolEvents?.[0].callId).toBe('call-2');
    });

    test('handles usage metadata in delta with null values', () => {
      const chunk = {
        type: 'message_delta',
        delta: {
          usage: {
            input_tokens: null,
            output_tokens: null
          }
        }
      };
      const parsed = compat.parseStreamChunk(chunk);

      // Null values are converted to undefined
      expect(parsed.usage?.promptTokens).toBeUndefined();
    });

    test('handles reasoning from delta.analysis', () => {
      const chunk = {
        type: 'message_delta',
        delta: { analysis: 'analyzing data...' }
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.reasoning?.text).toBe('analyzing data...');
    });

    test('handles reasoning from chunk.thinking (top-level)', () => {
      const chunk = {
        type: 'some_type',
        thinking: 'top level thought'
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.reasoning?.text).toBe('top level thought');
    });

    test('handles reasoning as empty string', () => {
      const chunk = {
        type: 'message_delta',
        delta: { thinking: '' }
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.reasoning).toBeUndefined();
    });

    test('handles reasoning with null text', () => {
      const chunk = {
        type: 'message_delta',
        delta: { thinking: { text: null } }
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.reasoning).toBeUndefined();
    });

    test('handles reasoning content array with non-text items', () => {
      const chunk = {
        type: 'message_delta',
        delta: {
          thinking: {
            content: [{ type: 'other' }, { text: 'actual text' }]
          }
        }
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.reasoning?.text).toBe('actual text');
    });

    test('handles message_start (clears state)', () => {
      // Build up state
      compat.parseStreamChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'test' }
      });

      // Clear state
      const parsed = compat.parseStreamChunk({ type: 'message_start' });

      expect(parsed).toBeDefined();
    });

    test('handles message_stop (clears state)', () => {
      // Build up state
      compat.parseStreamChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'test' }
      });

      // Clear state
      const parsed = compat.parseStreamChunk({ type: 'message_stop' });

      expect(parsed).toBeDefined();
    });

    test('handles tool_use finish condition', () => {
      const chunk = {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' }
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.finishedWithToolCalls).toBe(true);
    });

    test('does not set finishedWithToolCalls for other finish reasons', () => {
      const chunk = {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' }
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.finishedWithToolCalls).toBeUndefined();
    });
  });
});
