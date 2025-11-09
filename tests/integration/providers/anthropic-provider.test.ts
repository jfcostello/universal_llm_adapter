import { jest } from '@jest/globals';
import AnthropicCompat from '@/plugins/compat/anthropic.ts';
import { ToolCallEventType, Role } from '@/core/types.ts';
import {
  baseMessages,
  baseTools,
  multipleTools,
  imageMessages,
  toolCallMessages,
  toolResultMessages,
  reasoningMessages,
  reasoningWithSignatureMessages,
  complexConversation,
  multipleToolCallMessages,
  emptyContentMessages,
  multipleSystemMessages,
  pendingToolResultMessages,
  allSettings,
  minimalSettings,
  reasoningSettings
} from './test-fixtures.ts';

describe('integration/providers/anthropic-provider', () => {
  let compat: AnthropicCompat;

  beforeEach(() => {
    compat = new AnthropicCompat();
  });

  describe('1. Payload Building Tests', () => {
    describe('1.1 Basic Message Serialization', () => {
      test('extracts system messages to system field', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, [], undefined);

        expect(payload.system).toBe('system');
        expect(payload.messages).toHaveLength(1); // Only user message
      });

      test('extracts only first system message', () => {
        const payload = compat.buildPayload('claude-3', {}, multipleSystemMessages, [], undefined);

        // Anthropic implementation only uses messages.find() which gets the first one
        // All system messages are filtered from the messages array
        expect(payload.system).toBe('Part 1. ');
        expect(payload.messages).toHaveLength(1); // Only user message (system messages filtered out)
      });

      test('serializes user messages correctly', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: 'hello' }] }];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages[0]).toMatchObject({
          role: 'user',
          content: [{ type: 'text', text: 'hello' }]
        });
      });

      test('serializes assistant messages correctly', () => {
        const messages = [{ role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'response' }] }];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages[0]).toMatchObject({
          role: 'assistant',
          content: [{ type: 'text', text: 'response' }]
        });
      });

      test('converts tool messages to tool_result content blocks', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [{ type: 'text' as const, text: 'result' }]
          },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'continue' }] }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Tool result should be in user message
        const userMsg = payload.messages.find((m: any) => m.role === 'user');
        expect(userMsg.content).toContainEqual(
          expect.objectContaining({ type: 'tool_result', tool_use_id: 'call-1' })
        );
      });

      test('handles empty content correctly', () => {
        const payload = compat.buildPayload('claude-3', {}, emptyContentMessages, [], undefined);

        expect(payload.messages[0].content).toEqual([]);
      });
    });

    describe('1.2 Content Type Handling', () => {
      test('handles text content parts', () => {
        const messages = [
          {
            role: Role.USER,
            content: [
              { type: 'text' as const, text: 'First. ' },
              { type: 'text' as const, text: 'Second.' }
            ]
          }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages[0].content).toHaveLength(2);
      });

      test('filters empty text blocks', () => {
        const messages = [
          {
            role: Role.USER,
            content: [
              { type: 'text' as const, text: '' },
              { type: 'text' as const, text: 'valid' }
            ]
          }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        expect(payload.messages[0].content).toHaveLength(1);
        expect(payload.messages[0].content[0].text).toBe('valid');
      });

      test('handles image content parts', () => {
        const payload = compat.buildPayload('claude-3', {}, imageMessages, [], undefined);

        expect(payload.messages[0].content).toContainEqual({
          type: 'image',
          source: {
            type: 'url',
            url: 'https://example.com/image.jpg'
          }
        });
      });

      test('converts tool_result to tool_result content block in user message', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: {} }]
          },
          ...toolResultMessages
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Tool result should be converted to tool_result content in a user message
        const userMsg = payload.messages.find((m: any) => m.role === 'user');
        expect(userMsg.content[0]).toMatchObject({
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'Temperature is 72°F'
        });
      });
    });

    describe('1.3 Tool Calling', () => {
      test('serializes tools for function calling', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, baseTools, 'auto');

        expect(payload.tools).toHaveLength(1);
        expect(payload.tools[0]).toMatchObject({
          name: 'echo.text',
          description: 'Echo tool',
          input_schema: expect.objectContaining({ type: 'object' })
        });
      });

      test('serializes tool calls as tool_use blocks', () => {
        const payload = compat.buildPayload('claude-3', {}, toolCallMessages, [], undefined);

        expect(payload.messages[0].content).toContainEqual({
          type: 'tool_use',
          id: 'call-1',
          name: 'get.weather',
          input: { city: 'SF' }
        });
      });

      test('serializes multiple tool calls', () => {
        const payload = compat.buildPayload('claude-3', {}, multipleToolCallMessages, [], undefined);

        const toolUseBlocks = payload.messages[0].content.filter((c: any) => c.type === 'tool_use');
        expect(toolUseBlocks).toHaveLength(2);
      });

      test('handles tool choice "auto"', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, baseTools, 'auto');

        expect(payload.tool_choice).toEqual({ type: 'auto' });
      });

      test('handles tool choice "none" (omitted)', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, baseTools, 'none');

        expect(payload.tool_choice).toBeUndefined();
      });

      test('handles single tool choice', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, baseTools, {
          type: 'single',
          name: 'echo.text'
        });

        expect(payload.tool_choice).toEqual({
          type: 'tool',
          name: 'echo.text'
        });
      });

      test('handles required tool choice', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, multipleTools, {
          type: 'required',
          allowed: ['get.weather', 'search.web']
        });

        expect(payload.tool_choice).toEqual({ type: 'any' });
      });

      test('handles undefined tool choice', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, baseTools, undefined);

        expect(payload.tool_choice).toBeUndefined();
      });

      test('handles empty tools array', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, [], undefined);

        expect(payload.tools).toBeUndefined();
      });
    });

    describe('1.4 Settings Mapping', () => {
      test('maps supported settings', () => {
        const payload = compat.buildPayload('claude-3', allSettings, baseMessages, [], undefined);

        expect(payload.temperature).toBe(0.7);
        expect(payload.top_p).toBe(0.9);
        expect(payload.stop_sequences).toEqual(['STOP', 'END']);
      });

      test('requires max_tokens (defaults to 8192)', () => {
        const payload = compat.buildPayload('claude-3', {}, baseMessages, [], undefined);

        expect(payload.max_tokens).toBe(8192);
      });

      test('uses provided maxTokens', () => {
        const payload = compat.buildPayload('claude-3', { maxTokens: 1024 }, baseMessages, [], undefined);

        expect(payload.max_tokens).toBe(1024);
      });

      test('does not include unsupported settings', () => {
        const payload = compat.buildPayload('claude-3', allSettings, baseMessages, [], undefined);

        expect(payload.seed).toBeUndefined();
        expect(payload.frequency_penalty).toBeUndefined();
        expect(payload.presence_penalty).toBeUndefined();
      });
    });

    describe('1.5 Reasoning/Thinking', () => {
      test('enables thinking when all assistant messages have reasoning', () => {
        const messages = [
          { role: Role.USER, content: [{ type: 'text' as const, text: 'question' }] },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text' as const, text: 'answer' }],
            reasoning: { text: 'thinking...' }
          }
        ];
        const settings = { reasoning: { enabled: true, budget: 2048 } };
        const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

        expect(payload.thinking).toEqual({
          type: 'enabled',
          budget_tokens: 2048
        });
      });

      test('uses default thinking budget when not specified', () => {
        const messages = [
          { role: Role.USER, content: [{ type: 'text' as const, text: 'q' }] },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text' as const, text: 'a' }],
            reasoning: { text: 't' }
          }
        ];
        const settings = { reasoning: { enabled: true } };
        const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

        expect(payload.thinking?.budget_tokens).toBe(51200);
      });

      test('injects thinking blocks at start of assistant messages', () => {
        const payload = compat.buildPayload('claude-3', reasoningSettings, reasoningMessages, [], undefined);

        expect(payload.messages[0].content[0]).toMatchObject({
          type: 'thinking',
          thinking: 'Let me think about this step by step...'
        });
      });

      test('always includes signature (ignores redacted flag)', () => {
        const payload = compat.buildPayload('claude-3', reasoningSettings, reasoningWithSignatureMessages, [], undefined);

        expect(payload.messages[0].content[0]).toMatchObject({
          type: 'thinking',
          thinking: 'Deep thinking...',
          signature: 'abc123xyz'
        });
      });

      test('disables thinking when some assistant messages lack reasoning', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text' as const, text: 'first' }],
            reasoning: { text: 'thought' }
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text' as const, text: 'second' }]
            // No reasoning
          }
        ];
        const settings = { reasoning: { enabled: true } };
        const payload = compat.buildPayload('claude-3', settings, messages, [], undefined);

        expect(payload.thinking).toBeUndefined();
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
    });

    describe('1.6 Edge Cases', () => {
      test('handles empty messages array', () => {
        const payload = compat.buildPayload('claude-3', {}, [], [], undefined);

        expect(payload.messages).toEqual([]);
      });

      test('flushes pending tool results before assistant messages', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [{ type: 'text' as const, text: 'result' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text' as const, text: 'final' }]
          }
        ];
        const payload = compat.buildPayload('claude-3', {}, messages, [], undefined);

        // Should have 3 messages: assistant, user (with tool result), assistant
        expect(payload.messages).toHaveLength(3);
        expect(payload.messages[1].role).toBe('user');
        expect(payload.messages[1].content[0].type).toBe('tool_result');
      });

      test('creates user message for pending tool results at end', () => {
        const payload = compat.buildPayload('claude-3', {}, pendingToolResultMessages, [], undefined);

        // Last message should be user with tool result
        const lastMsg = payload.messages[payload.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(lastMsg.content[0].type).toBe('tool_result');
      });

      test('handles complex multi-turn conversation', () => {
        const payload = compat.buildPayload('claude-3', {}, complexConversation, multipleTools, 'auto');

        expect(payload.messages.length).toBeGreaterThan(0);
        expect(payload.system).toBe('You are helpful');
      });
    });
  });

  describe('2. Response Parsing Tests', () => {
    describe('2.1 Basic Parsing', () => {
      test('parses text responses', () => {
        const raw = {
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.content).toEqual([{ type: 'text', text: 'Hello!' }]);
        expect(unified.provider).toBe('anthropic');
        expect(unified.model).toBe('claude-3');
      });

      test('handles empty content', () => {
        const raw = {
          content: [],
          stop_reason: 'end_turn'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.content).toEqual([{ type: 'text', text: '' }]);
      });

      test('handles missing content', () => {
        const raw = {
          stop_reason: 'end_turn'
        };
        const unified = compat.parseResponse(raw as any, 'claude-3');

        expect(unified.content).toEqual([{ type: 'text', text: '' }]);
      });
    });

    describe('2.2 Tool Call Parsing', () => {
      test('parses single tool call from tool_use block', () => {
        const raw = {
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'echo.text',
              input: { text: 'hello' }
            }
          ],
          stop_reason: 'tool_use'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.toolCalls).toHaveLength(1);
        expect(unified.toolCalls?.[0]).toMatchObject({
          id: 'call-1',
          name: 'echo.text',
          arguments: { text: 'hello' }
        });
      });

      test('parses multiple tool calls', () => {
        const raw = {
          content: [
            { type: 'tool_use', id: 'call-1', name: 'tool1', input: { a: 1 } },
            { type: 'tool_use', id: 'call-2', name: 'tool2', input: { b: 2 } }
          ],
          stop_reason: 'tool_use'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.toolCalls).toHaveLength(2);
      });

      test('handles missing tool call ID', () => {
        const raw = {
          content: [{ type: 'tool_use', name: 'test', input: {} }],
          stop_reason: 'tool_use'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.toolCalls?.[0].id).toBe('call_0');
      });

      test('handles missing input', () => {
        const raw = {
          content: [{ type: 'tool_use', id: 'call-1', name: 'test' }],
          stop_reason: 'tool_use'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.toolCalls?.[0].arguments).toEqual({});
      });

      test('filters text content from tool_use blocks', () => {
        const raw = {
          content: [
            { type: 'text', text: 'Calling tool...' },
            { type: 'tool_use', id: 'call-1', name: 'test', input: {} }
          ],
          stop_reason: 'tool_use'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.content).toHaveLength(1);
        expect(unified.content[0].type).toBe('text');
      });
    });

    describe('2.3 Usage Statistics', () => {
      test('extracts usage stats', () => {
        const raw = {
          content: [{ type: 'text', text: 'test' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 5
          }
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        });
      });

      test('handles missing usage', () => {
        const raw = {
          content: [{ type: 'text', text: 'test' }],
          stop_reason: 'end_turn'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.usage).toBeUndefined();
      });
    });

    describe('2.4 Reasoning Parsing', () => {
      test('extracts reasoning from thinking blocks', () => {
        const raw = {
          content: [
            { type: 'thinking', thinking: 'deep thought...' },
            { type: 'text', text: 'answer' }
          ],
          stop_reason: 'end_turn'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.reasoning).toEqual({ text: 'deep thought...' });
      });

      test('preserves signature metadata', () => {
        const raw = {
          content: [
            {
              type: 'thinking',
              thinking: 'thought',
              signature: 'sig123'
            },
            { type: 'text', text: 'answer' }
          ],
          stop_reason: 'end_turn'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.reasoning?.metadata).toEqual({ signature: 'sig123' });
      });

      test('handles missing reasoning', () => {
        const raw = {
          content: [{ type: 'text', text: 'answer' }],
          stop_reason: 'end_turn'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.reasoning).toBeUndefined();
      });
    });

    describe('2.5 Finish Reason Mapping', () => {
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
          content: [{ type: 'text', text: 'stopped' }],
          stop_reason: 'stop_sequence'
        };
        const unified = compat.parseResponse(raw, 'claude-3');

        expect(unified.finishReason).toBe('stop');
      });
    });
  });

  describe('3. Streaming Tests', () => {
    describe('3.1 Text Streaming', () => {
      test('emits text deltas from text_delta', () => {
        const chunk = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.text).toBe('hello');
      });

      test('handles missing delta', () => {
        const chunk = { type: 'content_block_delta', index: 0, delta: {} };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.text).toBeUndefined();
      });
    });

    describe('3.2 Tool Call Streaming', () => {
      test('emits TOOL_CALL_START on content_block_start', () => {
        const chunk = {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'call-1',
            name: 'test'
          }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents).toHaveLength(1);
        expect(parsed.toolEvents?.[0]).toMatchObject({
          type: ToolCallEventType.TOOL_CALL_START,
          callId: 'call-1',
          name: 'test'
        });
      });

      test('emits TOOL_CALL_ARGUMENTS_DELTA on input_json_delta', () => {
        // Setup state
        compat.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-1', name: 'test' }
        });

        const chunk = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"key":' }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents?.[0]).toMatchObject({
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: 'call-1',
          argumentsDelta: '{"key":'
        });
      });

      test('emits TOOL_CALL_END on content_block_stop', () => {
        // Setup state
        compat.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-1', name: 'test' }
        });
        compat.parseStreamChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"a":1}' }
        });

        const chunk = {
          type: 'content_block_stop',
          index: 0
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents?.[0]).toMatchObject({
          type: ToolCallEventType.TOOL_CALL_END,
          callId: 'call-1',
          name: 'test',
          arguments: '{"a":1}'
        });
      });

      test('emits all events in sequence for complete stream', () => {
        const start = compat.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-1', name: 'echo' }
        });
        expect(start.toolEvents?.[0].type).toBe(ToolCallEventType.TOOL_CALL_START);

        const delta = compat.parseStreamChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' }
        });
        expect(delta.toolEvents?.[0].type).toBe(ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA);

        const end = compat.parseStreamChunk({
          type: 'content_block_stop',
          index: 0
        });
        expect(end.toolEvents?.[0].type).toBe(ToolCallEventType.TOOL_CALL_END);
      });
    });

    describe('3.3 State Management', () => {
      test('tracks content block index to call ID mapping', () => {
        compat.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-abc', name: 'test' }
        });

        const delta = compat.parseStreamChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' }
        });

        expect(delta.toolEvents?.[0].callId).toBe('call-abc');
      });

      test('clears state on message_start', () => {
        // Build up state
        compat.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-1', name: 'test' }
        });

        // Clear state
        compat.parseStreamChunk({ type: 'message_start' });

        // New start should work without old state
        const chunk = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-2', name: 'new' }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents?.[0].name).toBe('new');
      });

      test('clears state on message_stop', () => {
        compat.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-1', name: 'test' }
        });

        compat.parseStreamChunk({ type: 'message_stop' });

        // State should be cleared
        const newCompat = new AnthropicCompat();
        const chunk = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' }
        };
        const parsed = newCompat.parseStreamChunk(chunk);

        expect(parsed.toolEvents).toBeUndefined();
      });

      test('isolates state between instances', () => {
        const compat1 = new AnthropicCompat();
        const compat2 = new AnthropicCompat();

        compat1.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-1', name: 'test1' }
        });

        const chunk = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'call-2', name: 'test2' }
        };
        const parsed = compat2.parseStreamChunk(chunk);

        expect(parsed.toolEvents?.[0].name).toBe('test2');
      });
    });

    describe('3.4 Finish Conditions', () => {
      test('detects tool_use finish reason', () => {
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

    describe('3.5 Usage Tracking in Streams', () => {
      test('extracts usage from chunk.usage', () => {
        const chunk = {
          type: 'message_delta',
          usage: {
            input_tokens: 10,
            output_tokens: 5
          }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        });
      });

      test('extracts usage from delta.usage', () => {
        const chunk = {
          type: 'message_delta',
          delta: {
            usage: {
              input_tokens: 7,
              output_tokens: 3,
              reasoning_tokens: 1
            }
          }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.usage).toEqual({
          promptTokens: 7,
          completionTokens: 3,
          totalTokens: 10,
          reasoningTokens: 1
        });
      });

      test('handles missing usage', () => {
        const chunk = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.usage).toBeUndefined();
      });
    });

    describe('3.6 Reasoning Streaming', () => {
      test('extracts reasoning from delta.thinking (string)', () => {
        const chunk = {
          type: 'message_delta',
          delta: { thinking: 'analyzing...' }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning).toEqual({
          text: 'analyzing...',
          metadata: { provider: 'anthropic' }
        });
      });

      test('extracts reasoning from delta.thinking (object with text)', () => {
        const chunk = {
          type: 'message_delta',
          delta: {
            thinking: {
              text: 'step 1',
              metadata: { stage: 'planning' }
            }
          }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning?.text).toBe('step 1');
        expect(parsed.reasoning?.metadata).toMatchObject({ provider: 'anthropic', stage: 'planning' });
      });

      test('extracts reasoning from content array', () => {
        const chunk = {
          type: 'message_delta',
          delta: {
            thinking: {
              content: [{ text: 'Part A. ' }, { text: 'Part B.' }]
            }
          }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning?.text).toBe('Part A. Part B.');
      });

      test('handles missing reasoning', () => {
        const chunk = { type: 'message_delta', delta: {} };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning).toBeUndefined();
      });
    });
  });

  describe('4. Provider Extensions Tests', () => {
    test('returns payload unchanged (no-op)', () => {
      const payload = { model: 'test', data: 'value' };
      const result = compat.applyProviderExtensions(payload, { extra: 'ignored' });

      expect(result).toBe(payload);
      expect(result.extra).toBeUndefined();
    });
  });

  describe('5. Flags and Configuration Tests', () => {
    test('returns streaming flags', () => {
      const flags = compat.getStreamingFlags();

      expect(flags).toEqual({ stream: true });
    });

    test('serializeTools with tools array', () => {
      const result = compat.serializeTools(baseTools);

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].input_schema).toBeDefined();
    });

    test('serializeTools with empty array', () => {
      const result = compat.serializeTools([]);

      expect(result).toEqual({});
    });

    test('serializeToolChoice with all variants', () => {
      expect(compat.serializeToolChoice('auto')).toEqual({ tool_choice: { type: 'auto' } });
      expect(compat.serializeToolChoice('none')).toEqual({});
      expect(compat.serializeToolChoice({ type: 'single', name: 'test' })).toEqual({
        tool_choice: { type: 'tool', name: 'test' }
      });
      expect(compat.serializeToolChoice({ type: 'required', allowed: [] })).toEqual({
        tool_choice: { type: 'any' }
      });
      expect(compat.serializeToolChoice(undefined)).toEqual({});
    });
  });
});
