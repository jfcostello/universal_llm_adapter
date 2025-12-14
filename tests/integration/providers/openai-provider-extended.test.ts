import { jest } from '@jest/globals';
import OpenAICompat from '@/plugins/compat/openai/index.ts';
import { ToolCallEventType, Role } from '@/core/types.ts';

/**
 * Extended comprehensive tests for OpenAI provider
 * Covers all permutations from PROVIDER_INTEGRATION_TEST_SPECIFICATION.md
 */
describe('integration/providers/openai-provider-extended', () => {
  let compat: OpenAICompat;

  beforeEach(() => {
    compat = new OpenAICompat();
  });

  describe('2.1 Message Serialization - All Permutations', () => {
    describe('System messages', () => {
      test('handles system message with empty content array', () => {
        const messages = [
          { role: Role.SYSTEM, content: [] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        // OpenAI keeps empty array for system messages
        expect(payload.messages[0].content).toEqual([]);
      });

      test('handles multiple system messages', () => {
        const messages = [
          { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'First' }] },
          { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'Second' }] }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages).toHaveLength(2);
      });

      test('handles system message with non-text content', () => {
        const messages = [
          { role: Role.SYSTEM, content: [{ type: 'image' as any, imageUrl: 'url' }] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        // OpenAI doesn't filter non-text content, but converts it
        expect(payload.messages[0].content).toHaveLength(1);
        expect(payload.messages[0].content[0].type).toBe('image_url');
      });
    });

    describe('User messages', () => {
      test('handles user message with empty content array', () => {
        const messages = [{ role: Role.USER, content: [] }];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        // OpenAI keeps empty array for empty content
        expect(payload.messages[0].content).toEqual([]);
      });

      test('handles user message with empty string text', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '' }] }];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].content[0].text).toBe('');
      });

      test('handles user message with whitespace-only text', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '   ' }] }];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].content[0].text).toBe('   ');
      });
    });

    describe('Assistant messages', () => {
      test('handles assistant message with empty content array', () => {
        const messages = [{ role: Role.ASSISTANT, content: [] }];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].content).toBe('');
      });

      test('handles consecutive assistant messages', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'First' }] },
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'Second' }] }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages).toHaveLength(2);
        expect(payload.messages[0].role).toBe('assistant');
        expect(payload.messages[1].role).toBe('assistant');
      });

      test('handles assistant message with empty string text', () => {
        const messages = [{ role: Role.ASSISTANT, content: [{ type: 'text' as const, text: '' }] }];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].content[0].text).toBe('');
      });
    });

    describe('Tool messages', () => {
      test('handles tool message without toolCallId', () => {
        const messages = [
          { role: Role.TOOL, content: [{ type: 'text' as const, text: 'result' }] } as any
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].tool_call_id).toBeUndefined();
      });

      test('handles tool message with only tool_result (no text)', () => {
        const messages = [
          { role: Role.TOOL, toolCallId: 'call-1', content: [{ type: 'tool_result' as const, toolName: 'test', result: { data: 123 } }] }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        // tool_result content is filtered out for OpenAI, becomes empty string
        expect(payload.messages[0].content).toBe('');
      });
    });
  });

  describe('2.4 Settings - Individual Parameter Tests', () => {
    test('temperature: defined', () => {
      const payload = compat.buildPayload('gpt-4', { temperature: 0.5 }, [], [], undefined);
      expect(payload.temperature).toBe(0.5);
    });

    test('temperature: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.temperature).toBeUndefined();
    });

    test('temperature: zero (edge case)', () => {
      const payload = compat.buildPayload('gpt-4', { temperature: 0 }, [], [], undefined);
      expect(payload.temperature).toBe(0);
    });

    test('topP: defined', () => {
      const payload = compat.buildPayload('gpt-4', { topP: 0.9 }, [], [], undefined);
      expect(payload.top_p).toBe(0.9);
    });

    test('topP: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.top_p).toBeUndefined();
    });

    test('topP: 1.0 (edge case)', () => {
      const payload = compat.buildPayload('gpt-4', { topP: 1.0 }, [], [], undefined);
      expect(payload.top_p).toBe(1.0);
    });

    test('maxTokens: defined', () => {
      const payload = compat.buildPayload('gpt-4', { maxTokens: 100 }, [], [], undefined);
      expect(payload.max_tokens).toBe(100);
    });

    test('maxTokens: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.max_tokens).toBeUndefined();
    });

    test('maxTokens: 1 (minimum)', () => {
      const payload = compat.buildPayload('gpt-4', { maxTokens: 1 }, [], [], undefined);
      expect(payload.max_tokens).toBe(1);
    });

    test('stop: single sequence', () => {
      const payload = compat.buildPayload('gpt-4', { stop: ['STOP'] }, [], [], undefined);
      expect(payload.stop).toEqual(['STOP']);
    });

    test('stop: multiple sequences', () => {
      const payload = compat.buildPayload('gpt-4', { stop: ['STOP', 'END', '###'] }, [], [], undefined);
      expect(payload.stop).toEqual(['STOP', 'END', '###']);
    });

    test('stop: empty array', () => {
      const payload = compat.buildPayload('gpt-4', { stop: [] }, [], [], undefined);
      expect(payload.stop).toEqual([]);
    });

    test('stop: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.stop).toBeUndefined();
    });

    test('responseFormat: json_object', () => {
      const payload = compat.buildPayload('gpt-4', { responseFormat: 'json_object' }, [], [], undefined);
      expect(payload.response_format).toEqual({ type: 'json_object' });
    });

    test('responseFormat: text', () => {
      const payload = compat.buildPayload('gpt-4', { responseFormat: 'text' }, [], [], undefined);
      expect(payload.response_format).toEqual({ type: 'text' });
    });

    test('responseFormat: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.response_format).toBeUndefined();
    });

    test('seed: defined', () => {
      const payload = compat.buildPayload('gpt-4', { seed: 42 }, [], [], undefined);
      expect(payload.seed).toBe(42);
    });

    test('seed: zero', () => {
      const payload = compat.buildPayload('gpt-4', { seed: 0 }, [], [], undefined);
      expect(payload.seed).toBe(0);
    });

    test('seed: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.seed).toBeUndefined();
    });

    test('frequencyPenalty: positive', () => {
      const payload = compat.buildPayload('gpt-4', { frequencyPenalty: 0.5 }, [], [], undefined);
      expect(payload.frequency_penalty).toBe(0.5);
    });

    test('frequencyPenalty: negative', () => {
      const payload = compat.buildPayload('gpt-4', { frequencyPenalty: -0.5 }, [], [], undefined);
      expect(payload.frequency_penalty).toBe(-0.5);
    });

    test('frequencyPenalty: zero', () => {
      const payload = compat.buildPayload('gpt-4', { frequencyPenalty: 0 }, [], [], undefined);
      expect(payload.frequency_penalty).toBe(0);
    });

    test('frequencyPenalty: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.frequency_penalty).toBeUndefined();
    });

    test('presencePenalty: positive', () => {
      const payload = compat.buildPayload('gpt-4', { presencePenalty: 0.3 }, [], [], undefined);
      expect(payload.presence_penalty).toBe(0.3);
    });

    test('presencePenalty: negative', () => {
      const payload = compat.buildPayload('gpt-4', { presencePenalty: -0.3 }, [], [], undefined);
      expect(payload.presence_penalty).toBe(-0.3);
    });

    test('presencePenalty: zero', () => {
      const payload = compat.buildPayload('gpt-4', { presencePenalty: 0 }, [], [], undefined);
      expect(payload.presence_penalty).toBe(0);
    });

    test('presencePenalty: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.presence_penalty).toBeUndefined();
    });

    test('logitBias: single token', () => {
      const payload = compat.buildPayload('gpt-4', { logitBias: { 123: -100 } }, [], [], undefined);
      expect(payload.logit_bias).toEqual({ 123: -100 });
    });

    test('logitBias: multiple tokens', () => {
      const payload = compat.buildPayload('gpt-4', { logitBias: { 123: -100, 456: 50 } }, [], [], undefined);
      expect(payload.logit_bias).toEqual({ 123: -100, 456: 50 });
    });

    test('logitBias: empty object', () => {
      const payload = compat.buildPayload('gpt-4', { logitBias: {} }, [], [], undefined);
      expect(payload.logit_bias).toEqual({});
    });

    test('logitBias: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.logit_bias).toBeUndefined();
    });

    test('logprobs: true', () => {
      const payload = compat.buildPayload('gpt-4', { logprobs: true }, [], [], undefined);
      expect(payload.logprobs).toBe(true);
    });

    test('logprobs: false', () => {
      const payload = compat.buildPayload('gpt-4', { logprobs: false }, [], [], undefined);
      expect(payload.logprobs).toBe(false);
    });

    test('logprobs: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.logprobs).toBeUndefined();
    });

    test('topLogprobs: defined', () => {
      const payload = compat.buildPayload('gpt-4', { topLogprobs: 5 }, [], [], undefined);
      expect(payload.top_logprobs).toBe(5);
    });

    test('topLogprobs: 1 (minimum)', () => {
      const payload = compat.buildPayload('gpt-4', { topLogprobs: 1 }, [], [], undefined);
      expect(payload.top_logprobs).toBe(1);
    });

    test('topLogprobs: undefined', () => {
      const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);
      expect(payload.top_logprobs).toBeUndefined();
    });
  });

  describe('4. Response Parsing - Edge Cases', () => {
    test('parses response with null choices', () => {
      const raw = { choices: null };
      const unified = compat.parseResponse(raw as any, 'gpt-4');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parses response with undefined choices', () => {
      const raw = {};
      const unified = compat.parseResponse(raw as any, 'gpt-4');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parses response with empty choices array', () => {
      const raw = { choices: [] };

      // When choices is empty array, OpenAI implementation throws
      expect(() => compat.parseResponse(raw, 'gpt-4')).toThrow();
    });

    test('handles choice with null message', () => {
      const raw = { choices: [{ message: null, finish_reason: 'stop' }] };
      const unified = compat.parseResponse(raw as any, 'gpt-4');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('handles message with empty string content', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parses tool call with empty arguments string', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                { id: 'call-1', function: { name: 'test', arguments: '' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.toolCalls?.[0].arguments).toEqual({});
    });

    test('parses tool call with null function', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                { id: 'call-1', function: null as any }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.toolCalls?.[0].name).toBe('');
      expect(unified.toolCalls?.[0].arguments).toEqual({});
    });

    test('handles tool calls array as undefined', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: undefined
            },
            finish_reason: 'stop'
          }
        ]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.toolCalls).toBeUndefined();
    });

    test('handles tool calls array as null', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: null
            },
            finish_reason: 'stop'
          }
        ]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.toolCalls).toBeUndefined();
    });

    test('handles usage with null values', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null
        }
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.usage?.promptTokens).toBeNull();
      expect(unified.usage?.completionTokens).toBeNull();
    });

    test('handles reasoning_details with empty array', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_details: []
            },
            finish_reason: 'stop'
          }
        ]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.reasoning).toBeUndefined();
    });
  });

  describe('5. Finish Reason - All Variants', () => {
    test('preserves stop finish reason', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBe('stop');
    });

    test('preserves length finish reason', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: 'cut off' }, finish_reason: 'length' }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBe('length');
    });

    test('preserves tool_calls finish reason', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'call-1', function: { name: 'test', arguments: '{}' } }]
            },
            finish_reason: 'tool_calls'
          }
        ]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBe('tool_calls');
    });

    test('preserves content_filter finish reason', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: 'blocked' }, finish_reason: 'content_filter' }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBe('content_filter');
    });

    test('preserves function_call finish reason', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'function_call' }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBe('function_call');
    });

    test('handles null finish reason', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: null }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBeNull();
    });

    test('handles undefined finish reason', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: 'test' } }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBeUndefined();
    });

    test('handles unknown finish reason (passes through)', () => {
      const raw = {
        choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'unknown_reason' }]
      };
      const unified = compat.parseResponse(raw, 'gpt-4');

      expect(unified.finishReason).toBe('unknown_reason');
    });
  });

  describe('6. Streaming - Edge Cases', () => {
    test('handles chunk with null choices', () => {
      const chunk = { choices: null };
      const parsed = compat.parseStreamChunk(chunk as any);

      expect(parsed).toEqual({});
    });

    test('handles chunk with undefined choices', () => {
      const chunk = {};
      const parsed = compat.parseStreamChunk(chunk as any);

      expect(parsed).toEqual({});
    });

    test('handles chunk with empty choices array', () => {
      const chunk = { choices: [] };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed).toEqual({});
    });

    test('handles choice with null delta', () => {
      const chunk = { choices: [{ delta: null }] };
      const parsed = compat.parseStreamChunk(chunk as any);

      expect(parsed.text).toBeUndefined();
    });

    test('handles delta with empty string content', () => {
      const chunk = { choices: [{ delta: { content: '' } }] };
      const parsed = compat.parseStreamChunk(chunk);

      // Empty string is ignored in streaming
      expect(parsed.text).toBeUndefined();
    });

    test('handles tool call with missing function object', () => {
      const chunk = {
        choices: [
          {
            delta: {
              tool_calls: [{ id: 'call-1', index: 0 }]
            }
          }
        ]
      };
      const parsed = compat.parseStreamChunk(chunk);

      // Should not crash, may not emit events
      expect(parsed.toolEvents || []).toBeDefined();
    });

    test('handles tool call with null function', () => {
      const chunk = {
        choices: [
          {
            delta: {
              tool_calls: [{ id: 'call-1', index: 0, function: null as any }]
            }
          }
        ]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.toolEvents || []).toBeDefined();
    });

    test('handles multiple tool calls in single chunk', () => {
      const chunk = {
        choices: [
          {
            delta: {
              tool_calls: [
                { id: 'call-1', index: 0, function: { name: 'tool1', arguments: '' } },
                { id: 'call-2', index: 1, function: { name: 'tool2', arguments: '' } }
              ]
            }
          }
        ]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.toolEvents).toHaveLength(2);
    });

    test('handles interleaved tool call deltas', () => {
      const compat2 = new OpenAICompat();

      // Start tool 1
      compat2.parseStreamChunk({
        choices: [{
          delta: {
            tool_calls: [{ id: 'call-1', index: 0, function: { name: 'tool1', arguments: '' } }]
          }
        }]
      });

      // Start tool 2
      compat2.parseStreamChunk({
        choices: [{
          delta: {
            tool_calls: [{ id: 'call-2', index: 1, function: { name: 'tool2', arguments: '' } }]
          }
        }]
      });

      // Delta for tool 1
      const parsed1 = compat2.parseStreamChunk({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }]
          }
        }]
      });

      // Delta for tool 2
      const parsed2 = compat2.parseStreamChunk({
        choices: [{
          delta: {
            tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }]
          }
        }]
      });

      expect(parsed1.toolEvents?.[0].callId).toBe('call-1');
      expect(parsed2.toolEvents?.[0].callId).toBe('call-2');
    });

    test('handles usage metadata with null values', () => {
      const chunk = {
        choices: [{ delta: { content: 'test' } }],
        usage: {
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null
        }
      };
      const parsed = compat.parseStreamChunk(chunk);

      // Null values are converted to undefined
      expect(parsed.usage).toBeDefined();
      expect(parsed.usage?.promptTokens).toBeUndefined();
    });

    test('handles reasoning with empty text', () => {
      const chunk = {
        choices: [
          {
            delta: { content: 'answer', reasoning: '' }
          }
        ]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.reasoning).toBeUndefined();
    });

    test('handles reasoning content array with empty items', () => {
      const chunk = {
        choices: [
          {
            delta: {
              reasoning: [
                { content: [] }
              ]
            }
          }
        ]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.reasoning).toBeUndefined();
    });

    test('handles finish conditions: content_filter', () => {
      const chunk = {
        choices: [{ delta: {}, finish_reason: 'content_filter' }]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.finishedWithToolCalls).toBeUndefined();
    });

    test('handles finish conditions: null finish_reason', () => {
      const chunk = {
        choices: [{ delta: { content: 'text' }, finish_reason: null }]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.text).toBe('text');
    });

    test('handles finish conditions: missing finish_reason', () => {
      const chunk = {
        choices: [{ delta: { content: 'text' } }]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.text).toBe('text');
    });
  });
});
