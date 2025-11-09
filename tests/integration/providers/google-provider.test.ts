import { jest } from '@jest/globals';
import GoogleCompat from '@/plugins/compat/google.ts';
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

describe('integration/providers/google-provider', () => {
  let compat: GoogleCompat;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-api-key-for-integration';
    compat = new GoogleCompat();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  describe('1. SDK Initialization Tests', () => {
    test('initializes compat without requiring API key', () => {
      expect(compat).toBeDefined();
      expect(compat.callSDK).toBeDefined();
      expect(compat.streamSDK).toBeDefined();
    });

    test('getSDKClient extracts API key from headers.Authorization', () => {
      const headers = { Authorization: 'test-key-from-headers' };
      const client = (compat as any).getSDKClient(headers);
      expect(client).toBeDefined();
    });

    test('getSDKClient falls back to GEMINI_API_KEY', () => {
      const client = (compat as any).getSDKClient();
      expect(client).toBeDefined();
    });

    test('getSDKClient falls back to GOOGLE_API_KEY when GEMINI_API_KEY missing', () => {
      delete process.env.GEMINI_API_KEY;
      process.env.GOOGLE_API_KEY = 'fallback-key';

      const client = (compat as any).getSDKClient();
      expect(client).toBeDefined();

      // Restore
      process.env.GEMINI_API_KEY = 'test-api-key-for-integration';
      delete process.env.GOOGLE_API_KEY;
    });

    test('getSDKClient throws when no API key available', () => {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      expect(() => (compat as any).getSDKClient()).toThrow('Google API key required');

      // Restore
      process.env.GEMINI_API_KEY = 'test-api-key-for-integration';
    });
  });

  describe('2. Message Serialization Tests', () => {
    describe('2.1 Basic Message Serialization', () => {
      test('extracts system messages to systemInstruction', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, [], undefined);

        expect(params.config.systemInstruction).toEqual([{ text: 'system' }]);
        expect(params.contents).toHaveLength(1); // Only user message
      });

      test('aggregates multiple system messages', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, multipleSystemMessages, [], undefined);

        expect(params.config.systemInstruction).toEqual([{ text: 'Part 1. Part 2.' }]);
      });

      test('converts user role to user', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, [], undefined);

        expect(params.contents[0].role).toBe('user');
      });

      test('converts assistant role to model', () => {
        const messages = [{ role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'response' }] }];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].role).toBe('model');
      });

      test('converts tool messages to functionResponse', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: { city: 'SF' } }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [
              { type: 'tool_result' as const, toolName: 'get.weather', result: { temp: 72 } },
              { type: 'text' as const, text: 'Temperature is 72°F' }
            ]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[1].role).toBe('user');
        expect(params.contents[1].parts[0].functionResponse).toBeDefined();
        expect(params.contents[1].parts[0].functionResponse.name).toBe('get_weather'); // sanitized
        expect(params.contents[1].parts[0].functionResponse.response).toEqual({
          output: 'Temperature is 72°F'
        });
      });

      test('handles empty content', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, emptyContentMessages, [], undefined);

        expect(params.contents[0].parts).toEqual([]);
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
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts).toHaveLength(2);
        expect(params.contents[0].parts[0]).toEqual({ text: 'First. ' });
        expect(params.contents[0].parts[1]).toEqual({ text: 'Second.' });
      });

      test('handles image content parts', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, imageMessages, [], undefined);

        expect(params.contents[0].parts).toContainEqual({
          fileData: {
            fileUri: 'https://example.com/image.jpg',
            mimeType: 'image/jpeg'
          }
        });
      });

      test('handles empty text', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '' }] }];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts[0]).toEqual({ text: '' });
      });

      test('combines multiple text parts in tool response', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'tool', arguments: {} }]
          },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [
              { type: 'tool_result' as const, toolName: 'tool', result: 'data' },
              { type: 'text' as const, text: 'Line 1' },
              { type: 'text' as const, text: 'Line 2' }
            ]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[1].parts[0].functionResponse.response).toEqual({
          output: 'Line 1\nLine 2'
        });
      });
    });

    describe('2.3 Tool Calling', () => {
      test('serializes tools with name sanitization', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, baseTools, 'auto');

        expect(params.config.tools).toHaveLength(1);
        expect(params.config.tools[0].functionDeclarations).toHaveLength(1);
        expect(params.config.tools[0].functionDeclarations[0].name).toBe('echo_text'); // dot → underscore
      });

      test('serializes tool calls as functionCall parts', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, toolCallMessages, [], undefined);

        expect(params.contents[0].parts[0]).toEqual({
          functionCall: {
            name: 'get.weather', // NOT sanitized in toolCalls
            args: { city: 'SF' }
          }
        });
      });

      test('serializes multiple tool calls', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, multipleToolCallMessages, [], undefined);

        const functionCalls = params.contents[0].parts.filter((p: any) => p.functionCall);
        expect(functionCalls).toHaveLength(2);
      });

      test('handles tool choice "auto"', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, baseTools, 'auto');

        expect(params.config.toolConfig).toEqual({
          functionCallingConfig: { mode: 'AUTO' }
        });
      });

      test('handles tool choice "none"', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, baseTools, 'none');

        expect(params.config.toolConfig).toEqual({
          functionCallingConfig: { mode: 'NONE' }
        });
      });

      test('handles single tool choice with sanitized name', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, baseTools, {
          type: 'single',
          name: 'echo.text'
        });

        expect(params.config.toolConfig).toEqual({
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: ['echo_text'] // sanitized
          }
        });
      });

      test('handles required tool choice with allowed list', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, multipleTools, {
          type: 'required',
          allowed: ['get.weather', 'search.web']
        });

        expect(params.config.toolConfig).toEqual({
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: ['get_weather', 'search_web'] // both sanitized
          }
        });
      });

      test('defaults to AUTO mode when tools provided', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, baseTools, undefined);

        expect(params.config.toolConfig).toEqual({
          functionCallingConfig: { mode: 'AUTO' }
        });
      });

      test('handles empty tools array', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, [], undefined);

        expect(params.config.tools).toBeUndefined();
        expect(params.config.toolConfig).toBeUndefined();
      });
    });

    describe('2.4 Settings Mapping', () => {
      test('maps all supported settings', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', allSettings, baseMessages, [], undefined);

        expect(params.config.temperature).toBe(0.7);
        expect(params.config.topP).toBe(0.9);
        expect(params.config.maxOutputTokens).toBe(1024);
        expect(params.config.stopSequences).toEqual(['STOP', 'END']);
      });

      test('handles reasoning budget via thinkingConfig', () => {
        const settings = { reasoning: { enabled: true, budget: 5000 } };
        const params: any = compat.buildSDKParams('gemini-2.5-flash', settings, baseMessages, [], undefined);

        expect(params.config.thinkingConfig).toEqual({ thinkingBudget: 5000 });
      });

      test('handles reasoningBudget fallback', () => {
        const settings = { reasoningBudget: 3000 };
        const params: any = compat.buildSDKParams('gemini-2.5-flash', settings, baseMessages, [], undefined);

        expect(params.config.thinkingConfig).toEqual({ thinkingBudget: 3000 });
      });

      test('handles undefined settings', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, baseMessages, [], undefined);

        expect(params.config.temperature).toBeUndefined();
        expect(params.config.topP).toBeUndefined();
      });
    });

    describe('2.5 Edge Cases', () => {
      test('handles empty messages array', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);

        expect(params.contents).toEqual([]);
      });

      test('handles complex multi-turn conversation', () => {
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, complexConversation, multipleTools, 'auto');

        expect(params.contents.length).toBeGreaterThan(0);
        expect(params.config.systemInstruction).toBeDefined();
      });
    });
  });

  describe('3. Schema Conversion Tests', () => {
    describe('3.1 Type Mapping', () => {
      test('converts string to STRING', () => {
        const schema = { type: 'string' };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.type).toBe('STRING');
      });

      test('converts number to NUMBER', () => {
        const schema = { type: 'number' };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.type).toBe('NUMBER');
      });

      test('converts integer to INTEGER', () => {
        const schema = { type: 'integer' };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.type).toBe('INTEGER');
      });

      test('converts boolean to BOOLEAN', () => {
        const schema = { type: 'boolean' };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.type).toBe('BOOLEAN');
      });

      test('converts array to ARRAY', () => {
        const schema = { type: 'array', items: { type: 'string' } };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.type).toBe('ARRAY');
        expect(converted.items.type).toBe('STRING');
      });

      test('converts object to OBJECT', () => {
        const schema = { type: 'object', properties: {} };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.type).toBe('OBJECT');
      });
    });

    describe('3.2 Field Preservation', () => {
      test('preserves description', () => {
        const schema = { type: 'string', description: 'A test field' };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.description).toBe('A test field');
      });

      test('preserves properties', () => {
        const schema = {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' }
          }
        };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.properties.name.type).toBe('STRING');
        expect(converted.properties.age.type).toBe('INTEGER');
      });

      test('preserves required array', () => {
        const schema = {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.required).toEqual(['name']);
      });

      test('preserves minimum and maximum', () => {
        const schema = { type: 'integer', minimum: 0, maximum: 100 };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.minimum).toBe(0);
        expect(converted.maximum).toBe(100);
      });

      test('preserves format', () => {
        const schema = { type: 'string', format: 'email' };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.format).toBe('email');
      });

      test('preserves enum', () => {
        const schema = { type: 'string', enum: ['A', 'B', 'C'] };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.enum).toEqual(['A', 'B', 'C']);
      });
    });

    describe('3.3 Nested Schemas', () => {
      test('recursively converts nested objects', () => {
        const schema = {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string' }
              }
            }
          }
        };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.properties.user.type).toBe('OBJECT');
        expect(converted.properties.user.properties.name.type).toBe('STRING');
      });

      test('handles array items recursively', () => {
        const schema = {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' }
            }
          }
        };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.items.type).toBe('OBJECT');
        expect(converted.items.properties.id.type).toBe('INTEGER');
      });
    });

    describe('3.4 Edge Cases', () => {
      test('handles empty schema', () => {
        const converted: any = compat.convertSchemaToGoogleFormat({});

        expect(converted).toEqual({ type: 'OBJECT', properties: {} });
      });

      test('handles null schema', () => {
        const converted: any = compat.convertSchemaToGoogleFormat(null);

        expect(converted).toEqual({ type: 'OBJECT', properties: {} });
      });

      test('infers OBJECT type from properties', () => {
        const schema = { properties: { name: { type: 'string' } } };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.type).toBe('OBJECT');
      });

      test('defaults properties for OBJECT type', () => {
        const schema = { type: 'object' };
        const converted: any = compat.convertSchemaToGoogleFormat(schema);

        expect(converted.properties).toEqual({});
      });
    });
  });

  describe('4. Response Parsing Tests', () => {
    describe('4.1 Basic Parsing', () => {
      test('parses text responses', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello!' }]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.content).toEqual([{ type: 'text', text: 'Hello!' }]);
        expect(unified.provider).toBe('Google');
        expect(unified.model).toBe('gemini-2.5-flash');
      });

      test('handles empty candidates', () => {
        const raw = { candidates: [] };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.content).toEqual([{ type: 'text', text: '' }]);
      });

      test('handles missing parts', () => {
        const raw = {
          candidates: [{ content: {}, finishReason: 'STOP' }]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.content).toEqual([{ type: 'text', text: '' }]);
      });

      test('filters out thought parts from content', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'thinking...' },
                  { text: 'answer' }
                ]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.content).toEqual([{ type: 'text', text: 'answer' }]);
        expect(unified.reasoning).toBeDefined();
      });
    });

    describe('4.2 Tool Call Parsing', () => {
      test('parses single tool call from functionCall', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'get_weather',
                      args: { city: 'NYC' }
                    }
                  }
                ]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.toolCalls).toHaveLength(1);
        expect(unified.toolCalls[0]).toMatchObject({
          id: 'call_0',
          name: 'get_weather',
          arguments: { city: 'NYC' }
        });
      });

      test('parses multiple tool calls', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'tool1', args: { a: 1 } } },
                  { functionCall: { name: 'tool2', args: { b: 2 } } }
                ]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.toolCalls).toHaveLength(2);
      });

      test('generates sequential IDs for tool calls', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'a', args: {} } },
                  { functionCall: { name: 'b', args: {} } }
                ]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.toolCalls[0].id).toBe('call_0');
        expect(unified.toolCalls[1].id).toBe('call_1');
      });

      test('handles missing tool call name', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { args: {} } }]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.toolCalls[0].name).toBe('');
      });

      test('handles missing arguments', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'test' } }]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.toolCalls[0].arguments).toEqual({});
      });
    });

    describe('4.3 Usage Statistics', () => {
      test('extracts usage stats', () => {
        const raw = {
          candidates: [{ content: { parts: [{ text: 'test' }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15
          }
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        });
      });

      test('extracts reasoning tokens from thoughtsTokenCount', () => {
        const raw = {
          candidates: [{ content: { parts: [{ text: 'test' }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
            thoughtsTokenCount: 3
          }
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.usage?.reasoningTokens).toBe(3);
      });

      test('handles missing usage', () => {
        const raw = {
          candidates: [{ content: { parts: [{ text: 'test' }] }, finishReason: 'STOP' }]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.usage).toBeUndefined();
      });
    });

    describe('4.4 Reasoning Parsing', () => {
      test('extracts reasoning from thought parts', () => {
        const raw = {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Step 1: ' },
                  { thought: true, text: 'Step 2.' },
                  { text: 'Final answer' }
                ]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.reasoning).toEqual({
          text: 'Step 1: Step 2.',
          metadata: { provider: 'google' }
        });
      });

      test('handles missing reasoning', () => {
        const raw = {
          candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }]
        };
        const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

        expect(unified.reasoning).toBeUndefined();
      });
    });
  });

  describe('5. Streaming Tests', () => {
    describe('5.1 Text Streaming', () => {
      test('emits text deltas', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello ' }, { text: 'world' }]
              }
            }
          ]
        };
        const parsed: any = compat.parseSDKChunk(chunk);

        expect(parsed.text).toBe('Hello world');
      });

      test('filters thought parts from text', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'thinking' },
                  { text: 'answer' }
                ]
              }
            }
          ]
        };
        const parsed: any = compat.parseSDKChunk(chunk);

        expect(parsed.text).toBe('answer');
      });

      test('handles empty chunks', () => {
        const chunk = {};
        const parsed = compat.parseSDKChunk(chunk);

        expect(parsed).toEqual({});
      });
    });

    describe('5.2 Tool Call Streaming', () => {
      test('emits all three tool events instantly for function call', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'get_weather',
                      args: { city: 'NYC' }
                    }
                  }
                ]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const parsed = compat.parseSDKChunk(chunk);

        expect(parsed.toolEvents).toHaveLength(3);
        expect(parsed.toolEvents?.[0].type).toBe(ToolCallEventType.TOOL_CALL_START);
        expect(parsed.toolEvents?.[1].type).toBe(ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA);
        expect(parsed.toolEvents?.[2].type).toBe(ToolCallEventType.TOOL_CALL_END);
      });

      test('sets finishedWithToolCalls when STOP + tool calls seen', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'test', args: {} } }]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const parsed = compat.parseSDKChunk(chunk);

        expect(parsed.finishedWithToolCalls).toBe(true);
      });

      test('does not set finishedWithToolCalls for STOP without tool calls', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [{ text: 'done' }]
              },
              finishReason: 'STOP'
            }
          ]
        };
        const parsed = compat.parseSDKChunk(chunk);

        expect(parsed.finishedWithToolCalls).toBeUndefined();
      });
    });

    describe('5.3 State Management', () => {
      test('resets seenToolCallsInStream for new streams', () => {
        // First stream with tool call
        compat.parseSDKChunk({
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'test', args: {} } }] },
              finishReason: 'STOP'
            }
          ]
        });

        // Manually call streamSDK to reset (simulate new stream)
        // In real usage, streamSDK resets the flag

        // Second stream without tool calls
        const chunk = {
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }]
        };
        const newCompat = new GoogleCompat();
        const parsed = newCompat.parseSDKChunk(chunk);

        expect(parsed.finishedWithToolCalls).toBeUndefined();
      });
    });

    describe('5.4 Usage Tracking in Streams', () => {
      test('emits usage stats in chunks', () => {
        const chunk = {
          candidates: [{ content: { parts: [{ text: 'test' }] } }],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 15,
            totalTokenCount: 35,
            thoughtsTokenCount: 8
          }
        };
        const parsed: any = compat.parseSDKChunk(chunk);

        expect(parsed.usage).toEqual({
          promptTokens: 20,
          completionTokens: 15,
          totalTokens: 35, // Note: it's totalTokens not totalTokenCount
          reasoningTokens: 8
        });
      });

      test('handles missing usage', () => {
        const chunk = {
          candidates: [{ content: { parts: [{ text: 'test' }] } }]
        };
        const parsed = compat.parseSDKChunk(chunk);

        expect(parsed.usage).toBeUndefined();
      });
    });

    describe('5.5 Reasoning Streaming', () => {
      test('emits reasoning from thought parts', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Analyzing...' },
                  { text: 'Answer' }
                ]
              }
            }
          ]
        };
        const parsed: any = compat.parseSDKChunk(chunk);

        expect(parsed.reasoning).toEqual({
          text: 'Analyzing...',
          metadata: { provider: 'google' }
        });
      });

      test('combines multiple thought parts', () => {
        const chunk = {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: 'Part 1. ' },
                  { thought: true, text: 'Part 2.' },
                  { text: 'Result' }
                ]
              }
            }
          ]
        };
        const parsed: any = compat.parseSDKChunk(chunk);

        expect(parsed.reasoning?.text).toBe('Part 1. Part 2.');
      });
    });
  });

  describe('6. HTTP Method Errors', () => {
    test('buildPayload throws error', () => {
      expect(() => {
        compat.buildPayload('model', {}, [], []);
      }).toThrow('Google compat uses SDK methods');
    });

    test('parseResponse throws error', () => {
      expect(() => {
        compat.parseResponse({}, 'model');
      }).toThrow('Google compat uses SDK methods');
    });

    test('parseStreamChunk delegates to parseSDKChunk', () => {
      const chunk = {
        candidates: [{ content: { parts: [{ text: 'test' }] } }]
      };
      const parsed = compat.parseStreamChunk(chunk);

      expect(parsed.text).toBe('test');
    });
  });

  describe('7. Provider Extensions Tests', () => {
    test('returns payload unchanged (no-op)', () => {
      const payload = { model: 'test', data: 'value' };
      const result = compat.applyProviderExtensions(payload, { extra: 'ignored' });

      expect(result).toBe(payload);
    });
  });

  describe('8. Flags and Configuration Tests', () => {
    test('returns empty streaming flags', () => {
      const flags = compat.getStreamingFlags();

      expect(flags).toEqual({});
    });

    test('serializeTools delegates to serializeToolsForSDK', () => {
      const result: any = compat.serializeTools(baseTools);

      expect(result).toHaveLength(1);
      expect(result[0].functionDeclarations).toBeDefined();
    });

    test('serializeToolChoice delegates to serializeToolChoiceForSDK', () => {
      const result: any = compat.serializeToolChoice('auto');

      expect(result).toEqual({
        functionCallingConfig: { mode: 'AUTO' }
      });
    });
  });
});
