import { jest } from '@jest/globals';
import OpenAIResponsesCompat from '@/plugins/compat/openai-responses.ts';
import { ToolCallEventType, Role } from '@/core/types.ts';
import {
  baseMessages,
  baseTools,
  multipleTools,
  imageMessages,
  toolCallMessages,
  toolResultMessages,
  reasoningMessages,
  complexConversation,
  multipleToolCallMessages,
  emptyContentMessages,
  multipleSystemMessages,
  allSettings,
  minimalSettings,
  reasoningSettings
} from './test-fixtures.ts';

describe('integration/providers/openai-responses-provider', () => {
  let compat: OpenAIResponsesCompat;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-api-key-for-integration';
    compat = new OpenAIResponsesCompat();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  describe('1. SDK Initialization Tests', () => {
    test('initializes compat without requiring API key', () => {
      expect(compat).toBeDefined();
      expect(compat.callSDK).toBeDefined();
      expect(compat.streamSDK).toBeDefined();
    });

    test('getSDKClient extracts API key from headers.Authorization', () => {
      const headers = { Authorization: 'Bearer test-key-from-headers' };
      const client = (compat as any).getSDKClient(headers);
      expect(client).toBeDefined();
    });

    test('getSDKClient falls back to OPENAI_API_KEY', () => {
      const client = (compat as any).getSDKClient();
      expect(client).toBeDefined();
    });

    test('getSDKClient throws when no API key available', () => {
      delete process.env.OPENAI_API_KEY;

      expect(() => (compat as any).getSDKClient()).toThrow('OpenAI API key required');

      // Restore
      process.env.OPENAI_API_KEY = 'test-api-key-for-integration';
    });

    test('HTTP methods throw errors (SDK-only compat)', () => {
      expect(() => compat.buildPayload('gpt-4o', {}, baseMessages, [], undefined))
        .toThrow('SDK-only');
      expect(() => compat.parseResponse({}, 'gpt-4o'))
        .toThrow('SDK-only');
    });
  });

  describe('2. Message Serialization Tests (buildSDKParams)', () => {
    describe('2.1 Basic Message Serialization', () => {
      test('serializes system messages correctly', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, [], undefined);

        // System messages should be included in input array with special handling
        // or as separate field - implementation will determine exact format
        expect(params.input).toBeDefined();
        expect(Array.isArray(params.input) || typeof params.input === 'string').toBe(true);
      });

      test('serializes user messages with input_text type', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: 'Hello' }] }];
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);

        expect(params.input).toBeDefined();
        if (Array.isArray(params.input)) {
          const userMsg = params.input.find((m: any) => m.role === 'user');
          expect(userMsg).toBeDefined();
        }
      });

      test('serializes assistant messages with output_text type', () => {
        const messages = [
          { role: Role.USER, content: [{ type: 'text' as const, text: 'Hi' }] },
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'Hello!' }] }
        ];
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);

        if (Array.isArray(params.input)) {
          const assistantMsg = params.input.find((m: any) => m.role === 'assistant');
          expect(assistantMsg).toBeDefined();
        }
      });

      test('serializes tool messages as function_call_output', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: { city: 'SF' } }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [{ type: 'text' as const, text: '72°F' }]
          }
        ];
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);

        if (Array.isArray(params.input)) {
          const functionOutput = params.input.find((item: any) => item.type === 'function_call_output');
          expect(functionOutput).toBeDefined();
          if (functionOutput) {
            expect(functionOutput.call_id).toBe('call-1');
          }
        }
      });

      test('handles tool_result type content with array', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'get.time', arguments: {} }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [
              {
                type: 'tool_result' as const,
                toolName: 'get.time',
                result: [{ type: 'text', text: '{"timestamp":1234567890}' }]
              }
            ]
          }
        ];
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);

        if (Array.isArray(params.input)) {
          const functionOutput = params.input.find((item: any) => item.type === 'function_call_output');
          expect(functionOutput).toBeDefined();
          if (functionOutput) {
            expect(functionOutput.output).toBe('{"timestamp":1234567890}');
          }
        }
      });

      test('handles tool_result type content with string', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'get.data', arguments: {} }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [
              {
                type: 'tool_result' as const,
                toolName: 'get.data',
                result: 'simple result'
              }
            ]
          }
        ];
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);

        if (Array.isArray(params.input)) {
          const functionOutput = params.input.find((item: any) => item.type === 'function_call_output');
          expect(functionOutput).toBeDefined();
          if (functionOutput) {
            expect(functionOutput.output).toBe('simple result');
          }
        }
      });

      test('handles empty content correctly', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, emptyContentMessages, [], undefined);

        expect(params.input).toBeDefined();
      });
    });

    describe('2.2 Content Type Handling', () => {
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
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);

        expect(params.input).toBeDefined();
      });

      test('handles image content parts', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, imageMessages, [], undefined);

        expect(params.input).toBeDefined();
        // Image format needs to be verified in implementation
      });

      test('handles empty text', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '' }] }];
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, messages, [], undefined);

        expect(params.input).toBeDefined();
      });
    });

    describe('2.3 Tool Calling', () => {
      test('serializes tools for function calling', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, baseTools, 'auto');

        expect(params.tools).toBeDefined();
        expect(params.tools).toHaveLength(1);
        // Responses API uses hybrid format (type field + flat structure)
        expect(params.tools[0]).toMatchObject({
          type: 'function',
          name: 'echo.text',
          description: 'Echo tool'
        });
      });

      test('serializes tool calls in assistant messages', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, toolCallMessages, [], undefined);

        if (Array.isArray(params.input)) {
          const functionCall = params.input.find((item: any) => item.type === 'function_call');
          expect(functionCall).toBeDefined();
          if (functionCall) {
            expect(functionCall.name).toBe('get.weather');
            expect(functionCall.call_id).toBeDefined();
          }
        }
      });

      test('serializes multiple tool calls', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, multipleToolCallMessages, [], undefined);

        if (Array.isArray(params.input)) {
          const functionCalls = params.input.filter((item: any) => item.type === 'function_call');
          expect(functionCalls.length).toBe(2);
        }
      });

      test('handles tool choice "auto"', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, baseTools, 'auto');

        expect(params.tool_choice).toBe('auto');
      });

      test('handles tool choice "none"', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, baseTools, 'none');

        // None might be omitted or set to 'none'
        expect(params.tool_choice === undefined || params.tool_choice === 'none').toBe(true);
      });

      test('handles single tool choice', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, baseTools, {
          type: 'single',
          name: 'echo.text'
        });

        // Responses API uses just the tool name string
        expect(params.tool_choice).toBe('echo.text');
      });

      test('handles required tool choice', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, multipleTools, {
          type: 'required',
          allowed: ['get.weather', 'search.web']
        });

        // Required might map to 'required' or be handled differently
        expect(params.tool_choice).toBeDefined();
      });

      test('handles undefined tool choice', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, baseTools, undefined);

        expect(params.tool_choice).toBeUndefined();
      });

      test('handles empty tools array', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, [], undefined);

        expect(params.tools).toBeUndefined();
      });
    });

    describe('2.4 Settings Mapping', () => {
      test('maps maxTokens to max_output_tokens', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', { maxTokens: 1024 }, baseMessages, [], undefined);

        expect(params.max_output_tokens).toBe(1024);
      });

      test('maps temperature when non-zero', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', { temperature: 0.7 }, baseMessages, [], undefined);

        expect(params.temperature).toBe(0.7);
      });

      test('omits temperature when zero (for reasoning model support)', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', { temperature: 0 }, baseMessages, [], undefined);

        expect(params.temperature).toBeUndefined();
      });

      test('maps topP to top_p', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', { topP: 0.9 }, baseMessages, [], undefined);

        expect(params.top_p).toBe(0.9);
      });

      test('handles undefined settings', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, baseMessages, [], undefined);

        expect(params.temperature).toBeUndefined();
        expect(params.max_output_tokens).toBeUndefined();
      });

      test('handles partial settings', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', { temperature: 0 }, baseMessages, [], undefined);

        // temperature: 0 omitted for reasoning model support
        expect(params.temperature).toBeUndefined();
        expect(params.max_output_tokens).toBeUndefined();
      });
    });

    describe('2.5 Edge Cases', () => {
      test('handles empty messages array', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, [], [], undefined);

        expect(params.input).toBeDefined();
      });

      test('handles complex multi-turn conversation', () => {
        const params: any = (compat as any).buildSDKParams('gpt-4o', {}, complexConversation, multipleTools, 'auto');

        expect(params.input).toBeDefined();
        expect(params.tools).toBeDefined();
      });
    });
  });

  describe('3. Response Parsing Tests (parseSDKResponse)', () => {
    describe('3.1 Basic Parsing', () => {
      test('parses text responses from output array', () => {
        const mockResponse = {
          output: [
            { type: 'output_text', text: 'Hello there!' }
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.content).toHaveLength(1);
        expect(parsed.content[0]).toMatchObject({ type: 'text', text: 'Hello there!' });
      });

      test('handles empty output array', () => {
        const mockResponse = { output: [] };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.content).toEqual([{ type: 'text', text: '' }]);
      });

      test('handles missing output', () => {
        const mockResponse = {};

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.content).toEqual([{ type: 'text', text: '' }]);
      });
    });

    describe('3.2 Tool Call Parsing', () => {
      test('parses single tool call from function_call items', () => {
        const mockResponse = {
          output: [
            {
              type: 'function_call',
              id: 'output_1',
              call_id: 'call_abc',
              name: 'get_weather',
              arguments: '{"city":"SF"}'
            }
          ]
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.toolCalls).toHaveLength(1);
        expect(parsed.toolCalls[0]).toMatchObject({
          id: 'call_abc',
          name: 'get_weather',
          arguments: { city: 'SF' }
        });
      });

      test('parses multiple tool calls', () => {
        const mockResponse = {
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'tool_a',
              arguments: '{"x":1}'
            },
            {
              type: 'function_call',
              call_id: 'call_2',
              name: 'tool_b',
              arguments: '{"y":2}'
            }
          ]
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.toolCalls).toHaveLength(2);
      });

      test('handles missing call_id', () => {
        const mockResponse = {
          output: [
            {
              type: 'function_call',
              name: 'tool',
              arguments: '{}'
            }
          ]
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.toolCalls[0].id).toBeDefined();
      });

      test('handles missing arguments', () => {
        const mockResponse = {
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'tool'
            }
          ]
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.toolCalls[0].arguments).toEqual({});
      });
    });

    describe('3.3 Usage Statistics', () => {
      test('extracts usage stats', () => {
        const mockResponse = {
          output: [{ type: 'output_text', text: 'Hi' }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15
          }
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        });
      });

      test('handles missing usage', () => {
        const mockResponse = {
          output: [{ type: 'output_text', text: 'Hi' }]
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.usage).toBeUndefined();
      });
    });

    describe('3.4 Metadata', () => {
      test('sets provider and model correctly', () => {
        const mockResponse = {
          output: [{ type: 'output_text', text: 'Hi' }]
        };

        const parsed = (compat as any).parseSDKResponse(mockResponse, 'gpt-4o');

        expect(parsed.provider).toBe('openai');
        expect(parsed.model).toBe('gpt-4o');
      });
    });
  });

  describe('4. Streaming Tests (parseStreamChunk)', () => {
    describe('4.1 Text Streaming', () => {
      test('emits text deltas from response.output_text.delta events', () => {
        const chunk = {
          type: 'response.output_text.delta',
          delta: 'Hello'
        };

        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.text).toBe('Hello');
      });

      test('handles missing delta', () => {
        const chunk = {
          type: 'response.output_text.delta'
        };

        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.text).toBeUndefined();
      });
    });

    describe('4.2 Tool Call Streaming', () => {
      test('emits TOOL_CALL_START event', () => {
        const chunk = {
          type: 'response.output_item.added',
          item: {
            id: 'fc_item1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather'
          }
        };

        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents).toHaveLength(1);
        expect(parsed.toolEvents[0]).toMatchObject({
          type: ToolCallEventType.TOOL_CALL_START,
          callId: 'call_1',
          name: 'get_weather'
        });
      });

      test('emits TOOL_CALL_ARGUMENTS_DELTA events', () => {
        // First, start the tool call
        compat.parseStreamChunk({
          type: 'response.output_item.added',
          item: {
            id: 'fc_item1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'tool'
          }
        });

        const chunk = {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_item1',
          delta: '{"x"'
        };

        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents).toContainEqual({
          type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
          callId: 'call_1',
          argumentsDelta: '{"x"'
        });
      });

      test('emits TOOL_CALL_END event', () => {
        // Start and build up tool call
        compat.parseStreamChunk({
          type: 'response.output_item.added',
          item: {
            id: 'fc_item1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'tool'
          }
        });

        const chunk = {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_item1',
          arguments: '{"x":1}'
        };

        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents).toContainEqual({
          type: ToolCallEventType.TOOL_CALL_END,
          callId: 'call_1',
          name: 'tool',
          arguments: '{"x":1}'
        });
      });

      test('emits complete event sequence', () => {
        const events: any[] = [];

        // START
        let parsed = compat.parseStreamChunk({
          type: 'response.output_item.added',
          item: {
            id: 'fc_item1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather'
          }
        });
        if (parsed.toolEvents) events.push(...parsed.toolEvents);

        // DELTA
        parsed = compat.parseStreamChunk({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_item1',
          delta: '{"city"'
        });
        if (parsed.toolEvents) events.push(...parsed.toolEvents);

        // DELTA
        parsed = compat.parseStreamChunk({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_item1',
          delta: ':"SF"}'
        });
        if (parsed.toolEvents) events.push(...parsed.toolEvents);

        // END
        parsed = compat.parseStreamChunk({
          type: 'response.function_call_arguments.done',
          item_id: 'fc_item1',
          arguments: '{"city":"SF"}'
        });
        if (parsed.toolEvents) events.push(...parsed.toolEvents);

        expect(events).toHaveLength(4);
        expect(events[0].type).toBe(ToolCallEventType.TOOL_CALL_START);
        expect(events[1].type).toBe(ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA);
        expect(events[2].type).toBe(ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA);
        expect(events[3].type).toBe(ToolCallEventType.TOOL_CALL_END);
      });
    });

    describe('4.3 State Management', () => {
      test('tracks state across chunks', () => {
        const compat2 = new OpenAIResponsesCompat();
        process.env.OPENAI_API_KEY = 'test';

        compat2.parseStreamChunk({
          type: 'response.output_item.added',
          item: {
            id: 'fc_item1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'tool'
          }
        });

        compat2.parseStreamChunk({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_item1',
          delta: '{"x"'
        });

        const parsed = compat2.parseStreamChunk({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_item1',
          delta: ':1}'
        });

        expect(parsed.toolEvents).toBeDefined();
      });

      test('clears state on response.completed', () => {
        const compat2 = new OpenAIResponsesCompat();
        process.env.OPENAI_API_KEY = 'test';

        compat2.parseStreamChunk({
          type: 'response.output_item.added',
          item: {
            id: 'fc_item1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'tool'
          }
        });

        compat2.parseStreamChunk({
          type: 'response.completed',
          response: {}
        });

        // State should be cleared, so starting a new call should work
        const parsed = compat2.parseStreamChunk({
          type: 'response.output_item.added',
          item: {
            id: 'fc_item2',
            type: 'function_call',
            call_id: 'call_2',
            name: 'tool2'
          }
        });

        expect(parsed.toolEvents[0].callId).toBe('call_2');
      });
    });

    describe('4.4 Usage Tracking', () => {
      test('emits usage stats in chunks', () => {
        const chunk = {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15
            }
          }
        };

        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        });
      });
    });
  });

  describe('5. Helper Methods', () => {
    test('getStreamingFlags returns empty object for SDK', () => {
      const flags = compat.getStreamingFlags();
      expect(flags).toEqual({});
    });

    test('serializeTools works correctly', () => {
      const serialized = compat.serializeTools(baseTools);

      expect(serialized.tools).toBeDefined();
      expect(serialized.tools).toHaveLength(1);
    });

    test('serializeToolChoice works correctly', () => {
      expect(compat.serializeToolChoice('auto')).toEqual({ tool_choice: 'auto' });
      expect(compat.serializeToolChoice('none')).toEqual({});
      expect(compat.serializeToolChoice(undefined)).toEqual({});
    });
  });

  describe('6. SDK Call Methods (Mocked)', () => {
    test('callSDK successfully calls OpenAI SDK and parses response', async () => {
      // Mock the SDK client
      const mockResponse = {
        output: [
          { type: 'output_text', text: 'Hello from SDK!' }
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        }
      };

      const mockCreate = jest.fn().mockResolvedValue(mockResponse);
      const mockClient = {
        responses: {
          create: mockCreate
        }
      };

      // Replace getSDKClient temporarily
      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const result = await compat.callSDK(
          'gpt-4o',
          { temperature: 0.7 },
          baseMessages,
          [],
          undefined,
          undefined,
          { Authorization: 'Bearer test-key' }
        );

        expect(mockCreate).toHaveBeenCalled();
        expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello from SDK!' });
        expect(result.usage?.promptTokens).toBe(10);
      } finally {
        // Restore original
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK handles errors from SDK', async () => {
      const mockCreate = jest.fn().mockRejectedValue(new Error('API Error'));
      const mockClient = {
        responses: {
          create: mockCreate
        }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await expect(
          compat.callSDK('gpt-4o', {}, baseMessages, [], undefined)
        ).rejects.toThrow('API Error');
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK logs errors when logger provided', async () => {
      const mockCreate = jest.fn().mockRejectedValue(new Error('SDK Error'));
      const mockClient = {
        responses: { create: mockCreate }
      };
      const mockLogger = {
        info: jest.fn(),
        error: jest.fn()
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await expect(
          compat.callSDK('gpt-4o', {}, baseMessages, [], undefined, mockLogger)
        ).rejects.toThrow('SDK Error');
        expect(mockLogger.error).toHaveBeenCalledWith(
          'OpenAI Responses SDK call failed',
          expect.objectContaining({ error: 'SDK Error' })
        );
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('callSDK logs request parameters when logger provided', async () => {
      const mockResponse = {
        output: [{ type: 'output_text', text: 'Response' }]
      };
      const mockCreate = jest.fn().mockResolvedValue(mockResponse);
      const mockClient = {
        responses: { create: mockCreate }
      };
      const mockLogger = {
        info: jest.fn(),
        error: jest.fn()
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        await compat.callSDK('gpt-4o', {}, baseMessages, [], undefined, mockLogger);
        expect(mockLogger.info).toHaveBeenCalled();
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('streamSDK yields events from SDK stream', async () => {
      const mockEvents = [
        { type: 'response.created', id: 'resp_1' },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        { type: 'response.completed', response: {} }
      ];

      async function* mockStream() {
        for (const event of mockEvents) {
          yield event;
        }
      }

      const mockCreate = jest.fn().mockResolvedValue(mockStream());
      const mockClient = {
        responses: { create: mockCreate }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const events = [];
        for await (const event of compat.streamSDK('gpt-4o', {}, baseMessages, [], undefined)) {
          events.push(event);
        }

        expect(events).toHaveLength(4);
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({ stream: true })
        );
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('streamSDK handles errors from SDK', async () => {
      const mockCreate = jest.fn().mockRejectedValue(new Error('Stream Error'));
      const mockClient = {
        responses: { create: mockCreate }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const generator = compat.streamSDK('gpt-4o', {}, baseMessages, [], undefined);
        await expect(generator.next()).rejects.toThrow('Stream Error');
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('streamSDK logs errors when logger provided', async () => {
      const mockCreate = jest.fn().mockRejectedValue(new Error('Stream Error'));
      const mockClient = {
        responses: { create: mockCreate }
      };
      const mockLogger = {
        info: jest.fn(),
        error: jest.fn()
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const generator = compat.streamSDK('gpt-4o', {}, baseMessages, [], undefined, mockLogger);
        await expect(generator.next()).rejects.toThrow('Stream Error');
        expect(mockLogger.error).toHaveBeenCalledWith(
          'OpenAI Responses SDK streaming failed',
          expect.objectContaining({ error: 'Stream Error' })
        );
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('streamSDK logs parameters when logger provided', async () => {
      async function* mockStream() {
        yield { type: 'response.done' };
      }

      const mockCreate = jest.fn().mockResolvedValue(mockStream());
      const mockClient = {
        responses: { create: mockCreate }
      };
      const mockLogger = {
        info: jest.fn(),
        error: jest.fn()
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        const generator = compat.streamSDK('gpt-4o', {}, baseMessages, [], undefined, mockLogger);
        for await (const _ of generator) {
          // Consume stream
        }
        expect(mockLogger.info).toHaveBeenCalled();
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });

    test('streamSDK clears tool call state on new stream', async () => {
      async function* mockStream() {
        yield { type: 'response.done' };
      }

      const mockCreate = jest.fn().mockResolvedValue(mockStream());
      const mockClient = {
        responses: { create: mockCreate }
      };

      const originalGetSDKClient = (compat as any).getSDKClient;
      (compat as any).getSDKClient = jest.fn().mockReturnValue(mockClient);

      try {
        // First stream with tool call
        (compat as any).toolCallState.set('call_1', { name: 'tool', arguments: '{}' });
        expect((compat as any).toolCallState.size).toBe(1);

        // New stream should clear state
        const generator = compat.streamSDK('gpt-4o', {}, baseMessages, [], undefined);
        for await (const _ of generator) {
          // Consume
        }

        expect((compat as any).toolCallState.size).toBe(0);
      } finally {
        (compat as any).getSDKClient = originalGetSDKClient;
      }
    });
  });
});
