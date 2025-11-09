import { jest } from '@jest/globals';
import AnthropicCompat from '@/plugins/compat/anthropic.ts';
import { Role, ToolCallEventType } from '@/core/types.ts';
import { aggregateSystemMessages } from '@/utils/messages/message-utils.ts';

describe('compat/anthropic', () => {
  let compat: AnthropicCompat;

  beforeEach(() => {
    compat = new AnthropicCompat();
  });

  describe('buildPayload', () => {
    test('builds payload with system message extracted', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 1000
        },
        [
          {
            role: Role.SYSTEM,
            content: [{ type: 'text', text: 'You are helpful' }]
          },
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.model).toBe('claude-haiku-4-5');
      expect(payload.system).toBe('You are helpful');
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].role).toBe('user');
      expect(payload.temperature).toBe(0.7);
      expect(payload.top_p).toBe(0.9);
      expect(payload.max_tokens).toBe(1000);
    });

    test('consumes pre-aggregated system message', () => {
      const aggregatedMessages = aggregateSystemMessages([
        {
          role: Role.SYSTEM,
          content: [{ type: 'text', text: 'First instruction' }]
        },
        {
          role: Role.SYSTEM,
          content: [{ type: 'text', text: 'Second instruction' }]
        },
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'Hello' }]
        }
      ]);

      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        aggregatedMessages,
        [],
        undefined
      );

      expect(payload.system).toBe('First instruction\n\nSecond instruction');
      expect(payload.messages).toHaveLength(1);
    });

    test('defaults max_tokens to 8192 when not provided', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {},
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.max_tokens).toBe(8192);
    });

    test('serializes tools correctly', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Use the tool' }]
          }
        ],
        [
          {
            name: 'test_tool',
            description: 'A test tool',
            parametersJsonSchema: {
              type: 'object',
              properties: {
                arg1: { type: 'string' }
              },
              required: ['arg1']
            }
          }
        ],
        undefined
      );

      expect(payload.tools).toBeDefined();
      expect(payload.tools).toHaveLength(1);
      expect(payload.tools[0]).toEqual({
        name: 'test_tool',
        description: 'A test tool',
        input_schema: {
          type: 'object',
          properties: {
            arg1: { type: 'string' }
          },
          required: ['arg1']
        }
      });
    });

    test('converts Role.TOOL messages to tool_result content blocks', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Use echo' }]
          },
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [
              {
                id: 'call_1',
                name: 'echo',
                arguments: { message: 'test' }
              }
            ]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call_1',
            content: [{ type: 'text', text: 'result: test' }]
          },
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Thanks' }]
          }
        ],
        [],
        undefined
      );

      // Find the user message that should contain the tool result
      const userMessageWithToolResult = payload.messages.find((m: any) =>
        m.content.some((c: any) => c.type === 'tool_result')
      );

      expect(userMessageWithToolResult).toBeDefined();
      const toolResultBlock = userMessageWithToolResult.content.find(
        (c: any) => c.type === 'tool_result'
      );
      expect(toolResultBlock).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'result: test'
      });
    });

    test('flushes pending tool results before consecutive assistant messages', () => {
      // This tests the fix for MCP multi-turn tool execution
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'First question' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'First answer' }],
            toolCalls: [{ id: 'call_1', name: 'tool1', arguments: {} }]
          },
          {
            role: Role.TOOL,
            content: [{ type: 'text', text: 'tool result 1' }],
            toolCallId: 'call_1'
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'Second answer' }],
            toolCalls: [{ id: 'call_2', name: 'tool2', arguments: {} }]
          },
          {
            role: Role.TOOL,
            content: [{ type: 'text', text: 'tool result 2' }],
            toolCallId: 'call_2'
          }
        ],
        [],
        undefined
      );

      // Should have: user, assistant, user (with tool_result), assistant, user (with tool_result)
      expect(payload.messages).toHaveLength(5);

      // Second message should be assistant with tool_use
      expect(payload.messages[1].role).toBe('assistant');

      // Third message should be user with tool_result (flushed before second assistant)
      expect(payload.messages[2].role).toBe('user');
      expect(payload.messages[2].content.some((c: any) => c.type === 'tool_result')).toBe(true);

      // Fourth message should be second assistant
      expect(payload.messages[3].role).toBe('assistant');

      // Fifth message should be user with second tool_result
      expect(payload.messages[4].role).toBe('user');
      expect(payload.messages[4].content.some((c: any) => c.type === 'tool_result')).toBe(true);
    });

    test('filters out empty text content', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [
              { type: 'text', text: '' },
              { type: 'text', text: '   ' },
              { type: 'text', text: 'actual content' }
            ]
          }
        ],
        [],
        undefined
      );

      // Should only have the non-empty text
      expect(payload.messages[0].content).toHaveLength(1);
      expect(payload.messages[0].content[0].text).toBe('actual content');
    });

    test('includes tool_use blocks in assistant messages with tool calls', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Use the tool' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'Sure, using tool' }],
            toolCalls: [
              {
                id: 'call_123',
                name: 'my_tool',
                arguments: { param: 'value' }
              }
            ]
          }
        ],
        [],
        undefined
      );

      const assistantMessage = payload.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMessage).toBeDefined();

      const toolUseBlock = assistantMessage.content.find((c: any) => c.type === 'tool_use');
      expect(toolUseBlock).toEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'my_tool',
        input: { param: 'value' }
      });
    });

    test('handles image content correctly', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', imageUrl: 'https://example.com/image.png' }
            ]
          }
        ],
        [],
        undefined
      );

      const userMessage = payload.messages[0];
      expect(userMessage.content).toHaveLength(2);
      expect(userMessage.content[1]).toEqual({
        type: 'image',
        source: {
          type: 'url',
          url: 'https://example.com/image.png'
        }
      });
    });

    test('handles stop sequences', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          stop: ['STOP', 'END']
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.stop_sequences).toEqual(['STOP', 'END']);
    });
  });

  describe('serializeToolChoice', () => {
    test('handles "auto" tool choice', () => {
      const result = compat.serializeToolChoice('auto');
      expect(result).toEqual({ tool_choice: { type: 'auto' } });
    });

    test('handles "none" tool choice by omitting it', () => {
      const result = compat.serializeToolChoice('none');
      expect(result).toEqual({});
    });

    test('handles single tool choice', () => {
      const result = compat.serializeToolChoice({
        type: 'single',
        name: 'specific_tool'
      });
      expect(result).toEqual({
        tool_choice: {
          type: 'tool',
          name: 'specific_tool'
        }
      });
    });

    test('handles required tool choice (any)', () => {
      const result = compat.serializeToolChoice({
        type: 'required',
        allowed: ['tool1', 'tool2']
      });
      expect(result).toEqual({
        tool_choice: { type: 'any' }
      });
    });

    test('handles undefined tool choice', () => {
      const result = compat.serializeToolChoice(undefined);
      expect(result).toEqual({});
    });

    test('handles unknown string tool choice', () => {
      const result = compat.serializeToolChoice('unknown' as any);
      expect(result).toEqual({});
    });
  });

  describe('extractReasoning', () => {
    test('returns undefined when chunk lacks reasoning candidate', () => {
      const result = (compat as any).extractReasoning({});
      expect(result).toBeUndefined();
    });

    test('handles string thinking blocks', () => {
      const chunk = {
        delta: {
          thinking: 'step by step'
        }
      };

      const result = (compat as any).extractReasoning(chunk);
      expect(result).toEqual({
        text: 'step by step',
        metadata: { provider: 'anthropic' }
      });
    });

    test('handles object thinking blocks with metadata', () => {
      const chunk = {
        delta: {
          analysis: {
            text: 'analysis',
            metadata: { confidence: 0.9 }
          }
        }
      };

      const result = (compat as any).extractReasoning(chunk);
      expect(result).toEqual({
        text: 'analysis',
        metadata: {
          provider: 'anthropic',
          confidence: 0.9
        }
      });
    });

    test('joins array content pieces into reasoning text', () => {
      const chunk = {
        thinking: {
          content: [{ text: 'piece1' }, { text: 'piece2' }],
          metadata: { stage: 'joined' }
        }
      };

      const result = (compat as any).extractReasoning(chunk);
      expect(result).toEqual({
        text: 'piece1piece2',
        metadata: {
          provider: 'anthropic',
          stage: 'joined'
        }
      });
    });

    test('returns undefined when array content lacks text parts', () => {
      const chunk = {
        thinking: {
          content: [{ text: null }, { other: 'value' }]
        }
      };

      const result = (compat as any).extractReasoning(chunk);
      expect(result).toBeUndefined();
    });
  });

  describe('extractUsageStats', () => {
    test('returns undefined when usage missing', () => {
      const stats = (compat as any).extractUsageStats({});
      expect(stats).toBeUndefined();
    });

    test('prefers input/output token fields when available', () => {
      const stats = (compat as any).extractUsageStats({
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          reasoning_tokens: 2
        }
      });

      expect(stats).toEqual({
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
        reasoningTokens: 2
      });
    });

    test('falls back to prompt/completion token aliases', () => {
      const stats = (compat as any).extractUsageStats({
        delta: {
          usage: {
            prompt_tokens: 3,
            completion_tokens: 7
          }
        }
      });

      expect(stats).toEqual({
        promptTokens: 3,
        completionTokens: 7,
        totalTokens: 10,
        reasoningTokens: undefined
      });
    });

    test('defaults missing tokens to zero', () => {
      const stats = (compat as any).extractUsageStats({ usage: {} });
      expect(stats).toEqual({
        promptTokens: undefined,
        completionTokens: undefined,
        totalTokens: 0,
        reasoningTokens: undefined
      });
    });
  });

  describe('parseResponse', () => {
    test('parses basic text response', () => {
      const raw = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello there!' }
        ],
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 5
        }
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');

      expect(response.provider).toBe('anthropic');
      expect(response.model).toBe('claude-haiku-4-5');
      expect(response.role).toBe(Role.ASSISTANT);
      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toEqual({ type: 'text', text: 'Hello there!' });
      expect(response.finishReason).toBe('stop');
      expect(response.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      });
    });

    test('parses response with tool calls', () => {
      const raw = {
        id: 'msg_456',
        content: [
          { type: 'text', text: 'Using the tool' },
          {
            type: 'tool_use',
            id: 'call_789',
            name: 'get_weather',
            input: { location: 'San Francisco' }
          }
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 20,
          output_tokens: 15
        }
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');

      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toEqual({ type: 'text', text: 'Using the tool' });
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]).toEqual({
        id: 'call_789',
        name: 'get_weather',
        arguments: { location: 'San Francisco' }
      });
      expect(response.finishReason).toBe('tool_calls');
    });

    test('maps stop reasons correctly', () => {
      const testCases = [
        { anthropic: 'end_turn', universal: 'stop' },
        { anthropic: 'max_tokens', universal: 'length' },
        { anthropic: 'tool_use', universal: 'tool_calls' },
        { anthropic: 'stop_sequence', universal: 'stop' }
      ];

      for (const { anthropic, universal } of testCases) {
        const raw = {
          content: [{ type: 'text', text: 'test' }],
          stop_reason: anthropic
        };
        const response = compat.parseResponse(raw, 'claude-haiku-4-5');
        expect(response.finishReason).toBe(universal);
      }
    });

    test('handles undefined stop reason', () => {
      const raw = {
        content: [{ type: 'text', text: 'test' }]
        // no stop_reason field
      };
      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.finishReason).toBeUndefined();
    });

    test('handles empty content', () => {
      const raw = {
        content: [],
        stop_reason: 'end_turn'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('handles missing usage', () => {
      const raw = {
        content: [{ type: 'text', text: 'test' }],
        stop_reason: 'end_turn'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.usage).toBeUndefined();
    });

    test('handles text block with missing text field', () => {
      const raw = {
        content: [
          { type: 'text', text: '' },
          { type: 'text' }
        ],
        stop_reason: 'end_turn'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      // Should default to empty string for missing text
      expect(response.content).toHaveLength(2);
      expect(response.content[0]).toEqual({ type: 'text', text: '' });
      expect(response.content[1]).toEqual({ type: 'text', text: '' });
    });

    test('handles tool call with missing id', () => {
      const raw = {
        content: [
          {
            type: 'tool_use',
            name: 'test_tool',
            input: { arg: 'value' }
          }
        ],
        stop_reason: 'tool_use'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0].id).toBe('call_0');
    });

    test('handles tool call with missing name', () => {
      const raw = {
        content: [
          {
            type: 'tool_use',
            id: 'call_123',
            input: { arg: 'value' }
          }
        ],
        stop_reason: 'tool_use'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0].name).toBe('');
    });

    test('handles tool call with missing input', () => {
      const raw = {
        content: [
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'test_tool'
          }
        ],
        stop_reason: 'tool_use'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0].arguments).toEqual({});
    });

    test('handles usage with missing input_tokens', () => {
      const raw = {
        content: [{ type: 'text', text: 'test' }],
        stop_reason: 'end_turn',
        usage: {
          output_tokens: 5
        }
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.usage).toEqual({
        promptTokens: undefined,
        completionTokens: 5,
        totalTokens: 5
      });
    });

    test('handles usage with missing output_tokens', () => {
      const raw = {
        content: [{ type: 'text', text: 'test' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10
        }
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.usage).toEqual({
        promptTokens: 10,
        completionTokens: undefined,
        totalTokens: 10
      });
    });

    test('handles unknown stop_reason', () => {
      const raw = {
        content: [{ type: 'text', text: 'test' }],
        stop_reason: 'unknown_reason'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.finishReason).toBe('unknown_reason');
    });
  });

  describe('parseStreamChunk', () => {
    test('parses text delta events', () => {
      const chunk = {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Hello'
        }
      };

      const result = compat.parseStreamChunk(chunk);
      expect(result.text).toBe('Hello');
    });

    test('parses tool use start event', () => {
      const chunk = {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_123',
          name: 'get_weather'
        }
      };

      const result = compat.parseStreamChunk(chunk);
      expect(result.toolEvents).toHaveLength(1);
      expect(result.toolEvents[0]).toEqual({
        type: ToolCallEventType.TOOL_CALL_START,
        callId: 'call_123',
        name: 'get_weather'
      });
    });

    test('parses tool input delta events', () => {
      // First, start the tool
      compat.parseStreamChunk({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_123',
          name: 'get_weather'
        }
      });

      // Then send input delta
      const chunk = {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"location":'
        }
      };

      const result = compat.parseStreamChunk(chunk);
      expect(result.toolEvents).toHaveLength(1);
      expect(result.toolEvents[0]).toEqual({
        type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
        callId: 'call_123',
        argumentsDelta: '{"location":'
      });
    });

    test('parses tool end event', () => {
      // Start the tool
      compat.parseStreamChunk({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_123',
          name: 'get_weather'
        }
      });

      // Add some input
      compat.parseStreamChunk({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"location": "SF"}'
        }
      });

      // End the block
      const chunk = {
        type: 'content_block_stop',
        index: 0
      };

      const result = compat.parseStreamChunk(chunk);
      expect(result.toolEvents).toHaveLength(1);
      expect(result.toolEvents[0].type).toBe(ToolCallEventType.TOOL_CALL_END);
      expect(result.toolEvents[0].callId).toBe('call_123');
      expect(result.toolEvents[0].name).toBe('get_weather');
      expect(result.toolEvents[0].arguments).toBe('{"location": "SF"}');
    });

    test('clears state on message_stop', () => {
      // Start a tool
      compat.parseStreamChunk({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_123',
          name: 'test_tool'
        }
      });

      // Stop the message
      const result = compat.parseStreamChunk({
        type: 'message_stop'
      });

      expect(result).toEqual({});
      // State should be cleared, so a new content_block_stop shouldn't emit events
      const afterStop = compat.parseStreamChunk({
        type: 'content_block_stop',
        index: 0
      });
      expect(afterStop.toolEvents).toBeUndefined();
    });

    test('clears state on message_start', () => {
      // Start a tool
      compat.parseStreamChunk({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_123',
          name: 'test_tool'
        }
      });

      // Receive a message_start (new stream)
      const result = compat.parseStreamChunk({
        type: 'message_start',
        message: {}
      });

      expect(result).toEqual({});
      // State should be cleared, so a content_block_stop shouldn't emit events
      const afterStart = compat.parseStreamChunk({
        type: 'content_block_stop',
        index: 0
      });
      expect(afterStart.toolEvents).toBeUndefined();
    });

    test('sets finishedWithToolCalls on message_delta with stop_reason tool_use', () => {
      const result = compat.parseStreamChunk({
        type: 'message_delta',
        delta: {
          stop_reason: 'tool_use'
        }
      });

      expect(result.finishedWithToolCalls).toBe(true);
    });

    test('does not set finishedWithToolCalls on message_delta without stop_reason', () => {
      const result = compat.parseStreamChunk({
        type: 'message_delta',
        delta: {}
      });

      expect(result.finishedWithToolCalls).toBeUndefined();
    });
  });

  describe('getStreamingFlags', () => {
    test('returns streaming flags', () => {
      const flags = compat.getStreamingFlags();
      expect(flags).toEqual({ stream: true });
    });
  });

  describe('serializeTools', () => {
    test('returns empty object when no tools', () => {
      const result = compat.serializeTools([]);
      expect(result).toEqual({});
    });

    test('provides default schema when missing', () => {
      const tools = [
        {
          name: 'no_schema_tool',
          description: 'A tool without schema'
        } as any
      ];

      const result = compat.serializeTools(tools);
      expect(result.tools[0].input_schema).toEqual({
        type: 'object',
        properties: {}
      });
    });
  });

  describe('edge cases', () => {
    test('handles pending tool results at end of messages', () => {
      // Tool result with no following user message
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Use tool' }]
          },
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call_1', name: 'tool', arguments: {} }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call_1',
            content: [{ type: 'text', text: 'result' }]
          }
        ],
        [],
        undefined
      );

      // Should create a user message for the pending tool result
      const lastMessage = payload.messages[payload.messages.length - 1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content.some((c: any) => c.type === 'tool_result')).toBe(true);
    });

    test('serializes non-text content in tool results as JSON', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Use tool' }]
          },
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call_1', name: 'tool', arguments: {} }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call_1',
            content: [{ type: 'tool_result', toolName: 'test', result: { data: 'value' } }]
          },
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Thanks' }]
          }
        ],
        [],
        undefined
      );

      const userMessage = payload.messages.find((m: any) =>
        m.content.some((c: any) => c.type === 'tool_result')
      );
      const toolResult = userMessage.content.find((c: any) => c.type === 'tool_result');
      // Should be JSON stringified
      expect(typeof toolResult.content).toBe('string');
    });

    test('handles unknown content types by filtering them out', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'unknown_type', data: 'test' } as any
            ]
          }
        ],
        [],
        undefined
      );

      // Should only include the text content
      expect(payload.messages[0].content).toHaveLength(1);
      expect(payload.messages[0].content[0].type).toBe('text');
    });

    test('handles unknown tool choice types', () => {
      const result = compat.serializeToolChoice({ type: 'unknown' } as any);
      expect(result).toEqual({});
    });

    test('parseResponse handles non-array content', () => {
      const raw = {
        content: null,
        stop_reason: 'end_turn'
      };
      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parseToolCalls handles non-array content', () => {
      const raw = {
        content: null,
        stop_reason: 'end_turn'
      };
      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.toolCalls).toBeUndefined();
    });

    test('applyProviderExtensions leaves runtime settings untouched (handled earlier)', () => {
      const payload = {
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [],
        maxToolIterations: 10,
        toolCountdownEnabled: true,
        preserveToolResults: 3
      };
      const result = compat.applyProviderExtensions(payload, {});
      // Coordinator is now responsible for stripping these; compat receives final payload
      expect(result).toEqual(payload);
    });

    test('applyProviderExtensions leaves reasoning fields as-is', () => {
      const payload = {
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [],
        reasoning: { enabled: true, budget: 10000 },
        reasoningBudget: 5000
      };
      const result = compat.applyProviderExtensions(payload, {});
      expect(result).toEqual(payload);
    });
  });

  describe('reasoning transformation', () => {
    test('transforms reasoning.enabled to thinking format with default budget', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          reasoning: { enabled: true }
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 51200
      });
    });

    test('transforms reasoning with custom budget', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          reasoning: { enabled: true, budget: 10000 }
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 10000
      });
    });

    test('uses reasoningBudget setting if no budget in reasoning object', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          reasoning: { enabled: true },
          reasoningBudget: 20000
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 20000
      });
    });

    test('reasoning.budget takes precedence over reasoningBudget', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          reasoning: { enabled: true, budget: 15000 },
          reasoningBudget: 20000
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 15000
      });
    });

    test('does not add thinking when reasoning.enabled is false', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          reasoning: { enabled: false }
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toBeUndefined();
    });

    test('does not add thinking when reasoning is not present', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toBeUndefined();
    });

    test('ignores reasoning defined in deprecated extra.reasoning', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          extra: {
            reasoning: { enabled: true, budget: 30000 }
          }
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toBeUndefined();
    });

    test('settings.reasoning takes precedence over extra.reasoning', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        {
          maxTokens: 1000,
          reasoning: { enabled: true, budget: 10000 },
          extra: {
            reasoning: { enabled: true, budget: 30000 }
          }
        },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          }
        ],
        [],
        undefined
      );

      expect(payload.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 10000
      });
    });
  });

  describe('thinking block extraction and serialization', () => {
    test('parseResponse extracts thinking blocks as reasoning', () => {
      const raw = {
        content: [
          { type: 'thinking', thinking: 'Let me think about this carefully...' },
          { type: 'text', text: 'The answer is 42.' }
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 20
        }
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.reasoning).toEqual({
        text: 'Let me think about this carefully...'
      });
    });

    test('parseResponse returns undefined reasoning when no thinking block', () => {
      const raw = {
        content: [
          { type: 'text', text: 'The answer is 42.' }
        ],
        stop_reason: 'end_turn'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.reasoning).toBeUndefined();
    });

    test('buildPayload injects thinking block at start of assistant message', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'What is 2+2?' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'The answer is 4.' }],
            reasoning: {
              text: 'I need to add 2 and 2...'
            }
          }
        ],
        [],
        undefined
      );

      const assistantMessage = payload.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.content).toHaveLength(2);

      // Thinking block MUST be first
      expect(assistantMessage.content[0]).toEqual({
        type: 'thinking',
        thinking: 'I need to add 2 and 2...'
      });

      // Text content comes after
      expect(assistantMessage.content[1]).toEqual({
        type: 'text',
        text: 'The answer is 4.'
      });
    });

    test('buildPayload ignores redacted flag and includes full reasoning', () => {
      // Anthropic requires cryptographically signed thinking blocks to be unaltered
      // The redacted flag is ignored - full reasoning is always included
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'What is 2+2?' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'The answer is 4.' }],
            reasoning: {
              text: 'I need to add 2 and 2...',
              redacted: true  // This flag is IGNORED by Anthropic compat
            }
          }
        ],
        [],
        undefined
      );

      const assistantMessage = payload.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.content).toHaveLength(2);

      // Full thinking block with original text (redacted flag ignored)
      expect(assistantMessage.content[0]).toEqual({
        type: 'thinking',
        thinking: 'I need to add 2 and 2...'  // Original text, NOT placeholder
      });

      // Text content comes after
      expect(assistantMessage.content[1]).toEqual({
        type: 'text',
        text: 'The answer is 4.'
      });
    });

    test('buildPayload does not inject thinking block when no reasoning', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Hello' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'Hi there!' }]
          }
        ],
        [],
        undefined
      );

      const assistantMessage = payload.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.content).toHaveLength(1);
      expect(assistantMessage.content[0]).toEqual({
        type: 'text',
        text: 'Hi there!'
      });
    });

    test('buildPayload positions thinking block before tool_use blocks', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'Use the tool' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'Using the tool' }],
            reasoning: {
              text: 'I should use the tool...'
            },
            toolCalls: [
              { id: 'call_1', name: 'test_tool', arguments: { arg: 'value' } }
            ]
          }
        ],
        [],
        undefined
      );

      const assistantMessage = payload.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.content).toHaveLength(3);

      // Thinking block MUST be first
      expect(assistantMessage.content[0].type).toBe('thinking');

      // Text comes second
      expect(assistantMessage.content[1].type).toBe('text');

      // Tool use comes last
      expect(assistantMessage.content[2].type).toBe('tool_use');
    });

    test('parseResponse preserves signature in metadata when present', () => {
      const raw = {
        content: [
          {
            type: 'thinking',
            thinking: 'Let me think about this carefully...',
            signature: 'abc123signature'
          },
          { type: 'text', text: 'The answer is 42.' }
        ],
        stop_reason: 'end_turn'
      };

      const response = compat.parseResponse(raw, 'claude-haiku-4-5');
      expect(response.reasoning).toEqual({
        text: 'Let me think about this carefully...',
        metadata: {
          signature: 'abc123signature'
        }
      });
    });

    test('buildPayload includes signature from metadata when serializing thinking block', () => {
      const payload = compat.buildPayload(
        'claude-haiku-4-5',
        { maxTokens: 1000 },
        [
          {
            role: Role.USER,
            content: [{ type: 'text', text: 'What is 2+2?' }]
          },
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text', text: 'The answer is 4.' }],
            reasoning: {
              text: 'I need to add 2 and 2...',
              metadata: {
                signature: 'xyz789signature'
              }
            }
          }
        ],
        [],
        undefined
      );

      const assistantMessage = payload.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.content[0]).toEqual({
        type: 'thinking',
        thinking: 'I need to add 2 and 2...',
        signature: 'xyz789signature'
      });
    });
  });
});
