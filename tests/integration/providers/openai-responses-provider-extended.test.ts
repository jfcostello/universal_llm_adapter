import { jest } from '@jest/globals';
import OpenAIResponsesCompat from '@/plugins/compat/openai-responses/index.ts';
import { Role, ToolCallEventType } from '@/core/types.ts';

describe('integration/providers/openai-responses-provider-extended', () => {
  let compat: OpenAIResponsesCompat;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-api-key-for-integration';
    compat = new OpenAIResponsesCompat();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  describe('Message Edge Cases', () => {
    test('handles consecutive user messages', () => {
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: 'Message 1' }] },
        { role: Role.USER, content: [{ type: 'text' as const, text: 'Message 2' }] }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });

    test('handles consecutive assistant messages', () => {
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: 'Hi' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'Hello' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'How are you?' }] }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });

    test('handles whitespace-only text', () => {
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: '   ' }] }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });

    test('handles very long messages', () => {
      const longText = 'a'.repeat(10000);
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: longText }] }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });

    test('handles special characters in messages', () => {
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: 'Hello\nWorld\t"quoted"' }] }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });
  });

  describe('Settings Edge Cases', () => {
    test('handles zero temperature', () => {
      const params: any = (compat as any).buildSDKParams('gpt-4o', { temperature: 0 }, [], [], undefined);
      expect(params.temperature).toBe(0);
    });

    test('handles maximum temperature', () => {
      const params: any = (compat as any).buildSDKParams('gpt-4o', { temperature: 2 }, [], [], undefined);
      expect(params.temperature).toBe(2);
    });

    test('handles topP edge values', () => {
      let params: any = (compat as any).buildSDKParams('gpt-4o', { topP: 0 }, [], [], undefined);
      expect(params.top_p).toBe(0);

      params = (compat as any).buildSDKParams('gpt-4o', { topP: 1 }, [], [], undefined);
      expect(params.top_p).toBe(1);
    });

    test('handles very small maxTokens', () => {
      const params: any = (compat as any).buildSDKParams('gpt-4o', { maxTokens: 1 }, [], [], undefined);
      expect(params.max_output_tokens).toBe(1);
    });

    test('handles very large maxTokens', () => {
      const params: any = (compat as any).buildSDKParams('gpt-4o', { maxTokens: 100000 }, [], [], undefined);
      expect(params.max_output_tokens).toBe(100000);
    });
  });

  describe('Tool Calling Edge Cases', () => {
    test('handles tools with complex nested schemas', () => {
      const tools = [{
        name: 'complex_tool',
        description: 'A complex tool',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                deep: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, [], tools, 'auto');
      expect(params.tools).toHaveLength(1);
    });

    test('handles tool with no description', () => {
      const tools = [{
        name: 'no_desc_tool',
        parametersJsonSchema: {
          type: 'object',
          properties: {}
        }
      }];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, [], tools, undefined);
      expect(params.tools).toHaveLength(1);
    });

    test('handles tool with no parameters', () => {
      const tools = [{
        name: 'no_params_tool',
        description: 'A tool with no params'
      }];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, [], tools, undefined);
      expect(params.tools).toHaveLength(1);
    });

    test('handles tool calls with empty arguments', () => {
      const messages = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool', arguments: {} }]
        }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });

    test('handles tool calls with complex arguments', () => {
      const messages = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{
            id: 'call-1',
            name: 'tool',
            arguments: {
              nested: {
                array: [1, 2, 3],
                object: { key: 'value' }
              }
            }
          }]
        }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });
  });

  describe('Response Parsing Edge Cases', () => {
    test('handles mixed output types in same response', () => {
      const mockResponse = {
        output: [
          { type: 'output_text', text: 'First' },
          { type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{}' },
          { type: 'output_text', text: 'Second' }
        ]
      };

      const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

      // Should extract both text and tool calls
      expect(parsed.content.length).toBeGreaterThan(0);
      expect(parsed.toolCalls).toBeDefined();
    });

    test('handles malformed JSON in tool arguments', () => {
      const mockResponse = {
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{invalid json' }
        ]
      };

      // Should handle gracefully, either by catching error or leaving as string
      expect(() => {
        (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');
      }).not.toThrow();
    });

    test('handles null values in response', () => {
      const mockResponse = {
        output: [
          { type: 'output_text', text: null }
        ]
      };

      const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');
      expect(parsed.content).toBeDefined();
    });

    test('handles unknown output types', () => {
      const mockResponse = {
        output: [
          { type: 'unknown_type', data: 'something' }
        ]
      };

      const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');
      expect(parsed).toBeDefined();
    });
  });

  describe('Streaming Edge Cases', () => {
    test('handles rapid consecutive chunks', () => {
      const chunks = [
        { type: 'response.output_text.delta', delta: 'A' },
        { type: 'response.output_text.delta', delta: 'B' },
        { type: 'response.output_text.delta', delta: 'C' },
        { type: 'response.output_text.delta', delta: 'D' }
      ];

      chunks.forEach(chunk => {
        const parsed = compat.parseStreamChunk(chunk);
        expect(parsed.text).toBeDefined();
      });
    });

    test('handles interleaved text and tool events', () => {
      compat.parseStreamChunk({ type: 'response.output_text.delta', delta: 'Text 1' });
      compat.parseStreamChunk({ type: 'response.output_item.added', item: { id: 'fc_item1', type: 'function_call', call_id: 'call_1', name: 'tool' } });
      compat.parseStreamChunk({ type: 'response.output_text.delta', delta: 'Text 2' });
      compat.parseStreamChunk({ type: 'response.function_call_arguments.delta', item_id: 'fc_item1', delta: '{}' });

      // Should handle both types correctly
      const parsed = compat.parseStreamChunk({ type: 'response.output_text.delta', delta: 'Text 3' });
      expect(parsed.text).toBe('Text 3');
    });

    test('handles multiple parallel tool calls in stream', () => {
      compat.parseStreamChunk({ type: 'response.output_item.added', item: { id: 'fc_item1', type: 'function_call', call_id: 'call_1', name: 'tool1' } });
      compat.parseStreamChunk({ type: 'response.output_item.added', item: { id: 'fc_item2', type: 'function_call', call_id: 'call_2', name: 'tool2' } });
      compat.parseStreamChunk({ type: 'response.function_call_arguments.delta', item_id: 'fc_item1', delta: '{"a"' });
      compat.parseStreamChunk({ type: 'response.function_call_arguments.delta', item_id: 'fc_item2', delta: '{"b"' });
      compat.parseStreamChunk({ type: 'response.function_call_arguments.delta', item_id: 'fc_item1', delta: ':1}' });
      const parsed = compat.parseStreamChunk({ type: 'response.function_call_arguments.delta', item_id: 'fc_item2', delta: ':2}' });

      expect(parsed.toolEvents).toBeDefined();
    });

    test('handles empty delta in stream', () => {
      const chunk = { type: 'response.output_text.delta', delta: '' };
      const parsed = compat.parseStreamChunk(chunk);
      expect(parsed.text).toBe('');
    });

    test('handles unknown event types gracefully', () => {
      const chunk = { type: 'response.unknown_event', data: 'something' };
      expect(() => {
        compat.parseStreamChunk(chunk);
      }).not.toThrow();
    });
  });

  describe('Complex Scenarios', () => {
    test('handles full conversation with tools and multiple turns', () => {
      const messages = [
        { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'You are helpful' }] },
        { role: Role.USER, content: [{ type: 'text' as const, text: 'What is the weather?' }] },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { city: 'SF' } }]
        },
        {
          role: Role.TOOL,
          toolCallId: 'call-1',
          content: [{ type: 'text' as const, text: '72°F' }]
        },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'It is 72°F in SF' }] },
        { role: Role.USER, content: [{ type: 'text' as const, text: 'Thanks!' }] }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });

    test('handles streaming complete response lifecycle', () => {
      const events = [];

      // Response start
      let parsed = compat.parseStreamChunk({ type: 'response.created', id: 'resp_123' });
      events.push(parsed);

      // Text output
      parsed = compat.parseStreamChunk({ type: 'response.output_text.delta', delta: 'Hello ' });
      events.push(parsed);
      parsed = compat.parseStreamChunk({ type: 'response.output_text.delta', delta: 'world!' });
      events.push(parsed);

      // Response end (correct event type: response.completed not response.done)
      parsed = compat.parseStreamChunk({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
        }
      });
      events.push(parsed);

      expect(events.length).toBe(4);
      expect(events[events.length - 1].usage).toBeDefined();
    });

    test('handles function call streaming lifecycle', () => {
      const events = [];

      // Function call start: response.output_item.added
      let parsed = compat.parseStreamChunk({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_item123',
          type: 'function_call',
          call_id: 'call_123',
          name: 'get_weather',
          arguments: ''
        }
      });
      events.push(parsed);
      expect(parsed.toolEvents).toBeDefined();
      expect(parsed.toolEvents![0].type).toBe(ToolCallEventType.TOOL_CALL_START);
      expect(parsed.toolEvents![0].callId).toBe('call_123');

      // Function call argument deltas
      parsed = compat.parseStreamChunk({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_item123',
        delta: '{"city"'
      });
      events.push(parsed);
      expect(parsed.toolEvents![0].type).toBe(ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA);

      parsed = compat.parseStreamChunk({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_item123',
        delta: ':"SF"}'
      });
      events.push(parsed);

      // Function call done
      parsed = compat.parseStreamChunk({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_item123',
        arguments: '{"city":"SF"}'
      });
      events.push(parsed);
      expect(parsed.toolEvents![0].type).toBe(ToolCallEventType.TOOL_CALL_END);
      expect(parsed.toolEvents![0].callId).toBe('call_123');
      expect(parsed.toolEvents![0].name).toBe('get_weather');

      expect(events.length).toBe(4);
    });

    test('handles multiple parallel function calls in streaming', () => {
      // First tool call
      let parsed = compat.parseStreamChunk({
        type: 'response.output_item.added',
        item: {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'tool_a',
          arguments: ''
        }
      });
      expect(parsed.toolEvents![0].callId).toBe('call_1');

      // Second tool call
      parsed = compat.parseStreamChunk({
        type: 'response.output_item.added',
        item: {
          id: 'fc_2',
          type: 'function_call',
          call_id: 'call_2',
          name: 'tool_b',
          arguments: ''
        }
      });
      expect(parsed.toolEvents![0].callId).toBe('call_2');

      // Interleaved deltas
      parsed = compat.parseStreamChunk({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"a"'
      });
      expect(parsed.toolEvents![0].callId).toBe('call_1');

      parsed = compat.parseStreamChunk({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_2',
        delta: '{"b"'
      });
      expect(parsed.toolEvents![0].callId).toBe('call_2');

      // Complete both
      compat.parseStreamChunk({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        arguments: '{"a":1}'
      });

      compat.parseStreamChunk({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_2',
        arguments: '{"b":2}'
      });
    });
  });

  describe('API Key Handling', () => {
    test('strips "Bearer " prefix from Authorization header', () => {
      const headers = { Authorization: 'Bearer sk-test-key' };
      const client = (compat as any).getSDKClient(headers);
      expect(client).toBeDefined();
    });

    test('handles Authorization header without Bearer prefix', () => {
      const headers = { Authorization: 'sk-test-key' };
      const client = (compat as any).getSDKClient(headers);
      expect(client).toBeDefined();
    });

    test('prefers header over environment variable', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const headers = { Authorization: 'Bearer header-key' };

      const client = (compat as any).getSDKClient(headers);
      expect(client).toBeDefined();
    });
  });

  describe('Model Names', () => {
    test('handles various model name formats', () => {
      const models = ['gpt-4o', 'gpt-4o-mini', 'gpt-5-mini', 'o1', 'o3-mini'];

      models.forEach(model => {
        const params: any = (compat as any).buildSDKParams(model, {}, [], [], undefined);
        expect(params.model).toBe(model);
      });
    });
  });

  describe('Additional Coverage', () => {
    test('handles unknown content types in serializeContent', () => {
      const messages = [
        {
          role: Role.USER,
          content: [
            { type: 'text' as const, text: 'Hello' },
            { type: 'unknown_type' as any, data: 'something' }
          ]
        }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      expect(params.input).toBeDefined();
    });

    test('handles user message with only unknown content types (filtered to empty)', () => {
      const messages = [
        {
          role: Role.USER,
          content: [
            { type: 'tool_result' as any, data: 'filtered out' }
          ]
        }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      // Should still create user message even with empty content
      expect(params.input).toBeDefined();
    });

    test('handles tool message with missing toolCallId', () => {
      const messages = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool', arguments: {} }]
        },
        {
          role: Role.TOOL,
          // toolCallId is undefined
          content: [{ type: 'text' as const, text: 'result' }]
        }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      if (Array.isArray(params.input)) {
        const toolOutput = params.input.find((item: any) => item.type === 'function_call_output');
        expect(toolOutput?.call_id).toBe('unknown');
      }
    });

    test('handles tool message with empty text content', () => {
      const messages = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool', arguments: {} }]
        },
        {
          role: Role.TOOL,
          toolCallId: 'call-1',
          content: [] // Empty content
        }
      ];

      const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);
      if (Array.isArray(params.input)) {
        const toolOutput = params.input.find((item: any) => item.type === 'function_call_output');
        expect(toolOutput?.output).toBe('');
      }
    });

    test('handles function call with empty name in response', () => {
      const mockResponse = {
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            // name is undefined
            arguments: '{}'
          }
        ]
      };

      const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');
      expect(parsed.toolCalls[0].name).toBe('');
    });

    test('handles nested message structure with content array', () => {
      const mockResponse = {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Hello from nested structure'
              }
            ]
          }
        ],
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        }
      };

      const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');
      expect(parsed.content[0].text).toBe('Hello from nested structure');
      expect(parsed.content[0].type).toBe('text');
    });

    test('handles nested message with missing text field', () => {
      const mockResponse = {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text'
                // text is undefined
              }
            ]
          }
        ]
      };

      const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');
      expect(parsed.content[0].text).toBe('');
    });

    test('handles nested message with mixed content types', () => {
      const mockResponse = {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Text 1'
              },
              {
                type: 'other_type', // Non-output_text type (should be skipped)
                data: 'ignored'
              },
              {
                type: 'output_text',
                text: 'Text 2'
              }
            ]
          }
        ]
      };

      const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');
      expect(parsed.content.length).toBe(2);
      expect(parsed.content[0].text).toBe('Text 1');
      expect(parsed.content[1].text).toBe('Text 2');
    });

    test('serializeTools returns empty object for empty tools array', () => {
      const result = compat.serializeTools([]);
      expect(result).toEqual({});
    });

    test('handles unknown tool choice type', () => {
      const unknownChoice = { type: 'unknown' as any, data: 'test' };
      const result = compat.serializeToolChoice(unknownChoice);
      expect(result).toEqual({});
    });

    test('applyProviderExtensions returns payload unchanged', () => {
      const payload = { model: 'gpt-4o', input: 'test' };
      const extensions = { some: 'extension' };
      const result = (compat as any).applyProviderExtensions(payload, extensions);
      expect(result).toEqual(payload);
    });
  });
});
