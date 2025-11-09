import { jest } from '@jest/globals';
import GoogleCompat from '@/plugins/compat/google.ts';
import { ToolCallEventType, Role } from '@/core/types.ts';

/**
 * Extended comprehensive tests for Google provider
 * Covers all permutations from PROVIDER_INTEGRATION_TEST_SPECIFICATION.md
 */
describe('integration/providers/google-provider-extended', () => {
  let compat: GoogleCompat;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-api-key-for-extended';
    compat = new GoogleCompat();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  describe('2.1 Message Serialization - All Permutations', () => {
    describe('System messages', () => {
      test('handles system message with empty content array', () => {
        const messages = [
          { role: Role.SYSTEM, content: [] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.config?.systemInstruction).toBeUndefined();
      });

      test('handles system message with non-text content (filtered)', () => {
        const messages = [
          { role: Role.SYSTEM, content: [{ type: 'image' as any, imageUrl: 'url' }] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.config?.systemInstruction).toBeUndefined();
      });

      test('handles system message with whitespace-only text', () => {
        const messages = [
          { role: Role.SYSTEM, content: [{ type: 'text' as const, text: '   ' }] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.config?.systemInstruction).toEqual([{ text: '   ' }]);
      });

      test('aggregates multiple system messages into single instruction', () => {
        const messages = [
          { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'First. ' }] },
          { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'Second.' }] },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.config?.systemInstruction).toEqual([{ text: 'First. Second.' }]);
      });

      test('handles system message with multiple text parts', () => {
        const messages = [
          {
            role: Role.SYSTEM,
            content: [
              { type: 'text' as const, text: 'Part 1. ' },
              { type: 'text' as const, text: 'Part 2.' }
            ]
          },
          { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.config?.systemInstruction).toEqual([{ text: 'Part 1. Part 2.' }]);
      });
    });

    describe('User messages', () => {
      test('handles user message with empty content array', () => {
        const messages = [{ role: Role.USER, content: [] }];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts).toEqual([]);
      });

      test('handles user message with empty string text', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '' }] }];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts[0]).toEqual({ text: '' });
      });

      test('handles user message with whitespace-only text', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '   ' }] }];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts[0]).toEqual({ text: '   ' });
      });

      test('handles user message with multiple text parts', () => {
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

      test('handles user message with mixed content (text + image)', () => {
        const messages = [
          {
            role: Role.USER,
            content: [
              { type: 'text' as const, text: 'Describe this: ' },
              { type: 'image' as any, imageUrl: 'https://example.com/img.jpg', mimeType: 'image/jpeg' }
            ]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts).toHaveLength(2);
        expect(params.contents[0].parts[0]).toEqual({ text: 'Describe this: ' });
        expect(params.contents[0].parts[1]).toEqual({
          fileData: { fileUri: 'https://example.com/img.jpg', mimeType: 'image/jpeg' }
        });
      });
    });

    describe('Assistant (model) messages', () => {
      test('handles assistant message with empty content array', () => {
        const messages = [{ role: Role.ASSISTANT, content: [] }];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts).toEqual([]);
        expect(params.contents[0].role).toBe('model');
      });

      test('handles consecutive assistant messages', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'First' }] },
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'Second' }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents).toHaveLength(2);
        expect(params.contents[0].role).toBe('model');
        expect(params.contents[1].role).toBe('model');
      });

      test('handles assistant message with empty string text', () => {
        const messages = [{ role: Role.ASSISTANT, content: [{ type: 'text' as const, text: '' }] }];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts[0]).toEqual({ text: '' });
      });

      test('handles assistant message with tool calls', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text' as const, text: 'Calling tool' }],
            toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: { city: 'NYC' } }]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts).toHaveLength(2);
        expect(params.contents[0].parts[0]).toEqual({ text: 'Calling tool' });
        expect(params.contents[0].parts[1]).toEqual({
          functionCall: { name: 'get.weather', args: { city: 'NYC' } }
        });
      });

      test('handles assistant message with multiple tool calls', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [
              { id: 'call-1', name: 'tool1', arguments: { a: 1 } },
              { id: 'call-2', name: 'tool2', arguments: { b: 2 } }
            ]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts).toHaveLength(2);
        expect(params.contents[0].parts[0].functionCall.name).toBe('tool1');
        expect(params.contents[0].parts[1].functionCall.name).toBe('tool2');
      });

      test('does NOT sanitize tool call names in functionCall', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [],
            toolCalls: [{ id: 'call-1', name: 'get.weather.forecast', arguments: {} }]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        expect(params.contents[0].parts[0].functionCall.name).toBe('get.weather.forecast');
      });
    });

    describe('Tool messages', () => {
      test('handles tool message with only tool_result (no text)', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }] },
          { role: Role.TOOL, toolCallId: 'call-1', content: [{ type: 'tool_result' as const, toolName: 'test', result: { data: 123 } }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        const toolMsg = params.contents.find((c: any) => c.parts.some((p: any) => p.functionResponse));
        expect(toolMsg.parts[0].functionResponse.response).toEqual({ data: 123 });
      });

      test('sanitizes tool name in functionResponse', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: {} }] },
          { role: Role.TOOL, toolCallId: 'call-1', content: [{ type: 'tool_result' as const, toolName: 'get.weather', result: 'sunny' }] }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        const toolMsg = params.contents.find((c: any) => c.parts.some((p: any) => p.functionResponse));
        expect(toolMsg.parts[0].functionResponse.name).toBe('get_weather');
      });

      test('combines tool_result with text parts', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }] },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [
              { type: 'tool_result' as const, toolName: 'test', result: { temp: 72 } },
              { type: 'text' as const, text: 'Temperature is 72°F' }
            ]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        const toolMsg = params.contents.find((c: any) => c.parts.some((p: any) => p.functionResponse));
        expect(toolMsg.parts[0].functionResponse.response).toEqual({ output: 'Temperature is 72°F' });
      });

      test('combines multiple text parts in tool response', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }] },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [
              { type: 'tool_result' as const, toolName: 'test', result: 'data' },
              { type: 'text' as const, text: 'Line 1' },
              { type: 'text' as const, text: 'Line 2' }
            ]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        const toolMsg = params.contents.find((c: any) => c.parts.some((p: any) => p.functionResponse));
        expect(toolMsg.parts[0].functionResponse.response).toEqual({ output: 'Line 1\nLine 2' });
      });

      test('handles tool message with empty text parts', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [], toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }] },
          {
            role: Role.TOOL,
            toolCallId: 'call-1',
            content: [
              { type: 'tool_result' as const, toolName: 'test', result: { value: 42 } },
              { type: 'text' as const, text: '' }
            ]
          }
        ];
        const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

        const toolMsg = params.contents.find((c: any) => c.parts.some((p: any) => p.functionResponse));
        expect(toolMsg.parts[0].functionResponse.response).toEqual({ output: '' });
      });
    });
  });

  describe('2.4 Settings - Individual Parameter Tests', () => {
    test('temperature: defined', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { temperature: 0.5 }, [], [], undefined);
      expect(params.config?.temperature).toBe(0.5);
    });

    test('temperature: undefined', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);
      expect(params.config?.temperature).toBeUndefined();
    });

    test('temperature: zero', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { temperature: 0 }, [], [], undefined);
      expect(params.config?.temperature).toBe(0);
    });

    test('temperature: 1.0 (maximum)', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { temperature: 1.0 }, [], [], undefined);
      expect(params.config?.temperature).toBe(1.0);
    });

    test('topP: defined', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { topP: 0.9 }, [], [], undefined);
      expect(params.config?.topP).toBe(0.9);
    });

    test('topP: undefined', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);
      expect(params.config?.topP).toBeUndefined();
    });

    test('topP: 1.0', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { topP: 1.0 }, [], [], undefined);
      expect(params.config?.topP).toBe(1.0);
    });

    test('topP: 0 (minimum)', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { topP: 0 }, [], [], undefined);
      expect(params.config?.topP).toBe(0);
    });

    test('maxTokens: defined (renamed to maxOutputTokens)', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { maxTokens: 100 }, [], [], undefined);
      expect(params.config?.maxOutputTokens).toBe(100);
    });

    test('maxTokens: undefined', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);
      expect(params.config?.maxOutputTokens).toBeUndefined();
    });

    test('maxTokens: 1 (minimum)', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { maxTokens: 1 }, [], [], undefined);
      expect(params.config?.maxOutputTokens).toBe(1);
    });

    test('maxTokens: large value', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { maxTokens: 8192 }, [], [], undefined);
      expect(params.config?.maxOutputTokens).toBe(8192);
    });

    test('stop: single sequence (renamed to stopSequences)', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { stop: ['STOP'] }, [], [], undefined);
      expect(params.config?.stopSequences).toEqual(['STOP']);
    });

    test('stop: multiple sequences', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { stop: ['STOP', 'END', '###'] }, [], [], undefined);
      expect(params.config?.stopSequences).toEqual(['STOP', 'END', '###']);
    });

    test('stop: empty array', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { stop: [] }, [], [], undefined);
      expect(params.config?.stopSequences).toBeUndefined();
    });

    test('stop: undefined', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);
      expect(params.config?.stopSequences).toBeUndefined();
    });

    test('reasoning.budget', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { reasoning: { enabled: true, budget: 5000 } }, [], [], undefined);
      expect(params.config?.thinkingConfig).toEqual({ thinkingBudget: 5000 });
    });

    test('reasoningBudget fallback', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { reasoningBudget: 3000 }, [], [], undefined);
      expect(params.config?.thinkingConfig).toEqual({ thinkingBudget: 3000 });
    });

    test('reasoning: undefined (no thinkingConfig)', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);
      expect(params.config?.thinkingConfig).toBeUndefined();
    });

    test('reasoning.budget takes precedence over reasoningBudget', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { reasoning: { enabled: true, budget: 5000 }, reasoningBudget: 3000 }, [], [], undefined);
      expect(params.config?.thinkingConfig).toEqual({ thinkingBudget: 5000 });
    });

    test('all settings combined', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        stop: ['STOP', 'END'],
        reasoningBudget: 4000
      }, [], [], undefined);

      expect(params.config?.temperature).toBe(0.7);
      expect(params.config?.topP).toBe(0.9);
      expect(params.config?.maxOutputTokens).toBe(1024);
      expect(params.config?.stopSequences).toEqual(['STOP', 'END']);
      expect(params.config?.thinkingConfig).toEqual({ thinkingBudget: 4000 });
    });
  });

  describe('2.3 Tool Calling - Comprehensive', () => {
    test('serializes tools with name sanitization', () => {
      const tools = [
        {
          name: 'get.weather',
          description: 'Get weather',
          parameters: { type: 'object' as const, properties: {} }
        }
      ];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, 'auto');

      expect(params.config?.tools).toHaveLength(1);
      expect(params.config?.tools[0].functionDeclarations[0].name).toBe('get_weather');
    });

    test('handles tool choice "auto"', () => {
      const tools = [{ name: 'test', description: 'Test', parameters: { type: 'object' as const, properties: {} } }];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, 'auto');

      expect(params.config?.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    });

    test('handles tool choice "none"', () => {
      const tools = [{ name: 'test', description: 'Test', parameters: { type: 'object' as const, properties: {} } }];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, 'none');

      expect(params.config?.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    });

    test('handles single tool choice with sanitized name', () => {
      const tools = [{ name: 'get.weather', description: 'Test', parameters: { type: 'object' as const, properties: {} } }];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, {
        type: 'single',
        name: 'get.weather'
      });

      expect(params.config?.toolConfig).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['get_weather']
        }
      });
    });

    test('handles required tool choice with allowed list', () => {
      const tools = [
        { name: 'get.weather', description: 'Weather', parameters: { type: 'object' as const, properties: {} } },
        { name: 'search.web', description: 'Search', parameters: { type: 'object' as const, properties: {} } }
      ];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, {
        type: 'required',
        allowed: ['get.weather', 'search.web']
      });

      expect(params.config?.toolConfig).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['get_weather', 'search_web']
        }
      });
    });

    test('defaults to AUTO mode when tools provided without toolChoice', () => {
      const tools = [{ name: 'test', description: 'Test', parameters: { type: 'object' as const, properties: {} } }];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, undefined);

      expect(params.config?.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    });

    test('handles empty tools array', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);

      expect(params.config?.tools).toBeUndefined();
      expect(params.config?.toolConfig).toBeUndefined();
    });

    test('handles multiple tools', () => {
      const tools = [
        { name: 'tool1', description: 'First', parameters: { type: 'object' as const, properties: {} } },
        { name: 'tool2', description: 'Second', parameters: { type: 'object' as const, properties: {} } }
      ];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, 'auto');

      expect(params.config?.tools).toHaveLength(1);
      expect(params.config?.tools[0].functionDeclarations).toHaveLength(2);
    });
  });

  describe('3. Schema Conversion - All Type Permutations', () => {
    test('converts null schema to default OBJECT', () => {
      const converted: any = compat.convertSchemaToGoogleFormat(null);
      expect(converted).toEqual({ type: 'OBJECT', properties: {} });
    });

    test('converts undefined schema to default OBJECT', () => {
      const converted: any = compat.convertSchemaToGoogleFormat(undefined as any);
      expect(converted).toEqual({ type: 'OBJECT', properties: {} });
    });

    test('converts empty object to default OBJECT', () => {
      const converted: any = compat.convertSchemaToGoogleFormat({});
      expect(converted).toEqual({ type: 'OBJECT', properties: {} });
    });

    test('converts schema with properties but no type (infers OBJECT)', () => {
      const schema = { properties: { name: { type: 'string' } } };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);
      expect(converted.type).toBe('OBJECT');
      expect(converted.properties.name.type).toBe('STRING');
    });

    test('converts schema with required but no type (infers OBJECT)', () => {
      const schema = { required: ['name'] };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);
      expect(converted.type).toBe('OBJECT');
      expect(converted.required).toEqual(['name']);
    });

    test('preserves description at all levels', () => {
      const schema = {
        type: 'object',
        description: 'Root description',
        properties: {
          nested: {
            type: 'object',
            description: 'Nested description',
            properties: {
              deep: { type: 'string', description: 'Deep description' }
            }
          }
        }
      };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.description).toBe('Root description');
      expect(converted.properties.nested.description).toBe('Nested description');
      expect(converted.properties.nested.properties.deep.description).toBe('Deep description');
    });

    test('handles array with complex items schema', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['id']
        }
      };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.type).toBe('ARRAY');
      expect(converted.items.type).toBe('OBJECT');
      expect(converted.items.properties.id.type).toBe('INTEGER');
      expect(converted.items.properties.tags.type).toBe('ARRAY');
      expect(converted.items.properties.tags.items.type).toBe('STRING');
      expect(converted.items.required).toEqual(['id']);
    });

    test('handles enum with all value types', () => {
      const schema = {
        type: 'string',
        enum: ['option1', 'option2', 'option3']
      };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.enum).toEqual(['option1', 'option2', 'option3']);
    });

    test('handles minimum without maximum', () => {
      const schema = { type: 'integer', minimum: 0 };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.minimum).toBe(0);
      expect(converted.maximum).toBeUndefined();
    });

    test('handles maximum without minimum', () => {
      const schema = { type: 'integer', maximum: 100 };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.maximum).toBe(100);
      expect(converted.minimum).toBeUndefined();
    });

    test('handles negative minimum and maximum', () => {
      const schema = { type: 'number', minimum: -100, maximum: -1 };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.minimum).toBe(-100);
      expect(converted.maximum).toBe(-1);
    });

    test('handles format field', () => {
      const schema = { type: 'string', format: 'email' };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.format).toBe('email');
    });

    test('handles deeply nested schemas (3+ levels)', () => {
      const schema = {
        type: 'object',
        properties: {
          level1: {
            type: 'object',
            properties: {
              level2: {
                type: 'object',
                properties: {
                  level3: {
                    type: 'string'
                  }
                }
              }
            }
          }
        }
      };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.properties.level1.properties.level2.properties.level3.type).toBe('STRING');
    });

    test('handles empty required array', () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } }, required: [] };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.required).toEqual([]);
    });

    test('handles required with all properties', () => {
      const schema = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
          c: { type: 'boolean' }
        },
        required: ['a', 'b', 'c']
      };
      const converted: any = compat.convertSchemaToGoogleFormat(schema);

      expect(converted.required).toEqual(['a', 'b', 'c']);
    });

    test('converts all basic types', () => {
      const schemas = [
        { input: { type: 'string' }, expected: 'STRING' },
        { input: { type: 'number' }, expected: 'NUMBER' },
        { input: { type: 'integer' }, expected: 'INTEGER' },
        { input: { type: 'boolean' }, expected: 'BOOLEAN' },
        { input: { type: 'array', items: { type: 'string' } }, expected: 'ARRAY' },
        { input: { type: 'object', properties: {} }, expected: 'OBJECT' }
      ];

      for (const { input, expected } of schemas) {
        const converted: any = compat.convertSchemaToGoogleFormat(input);
        expect(converted.type).toBe(expected);
      }
    });
  });

  describe('4. Response Parsing - Edge Cases', () => {
    test('parses response with null candidates', () => {
      const raw = { candidates: null };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parses response with undefined candidates', () => {
      const raw = {};
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('parses response with empty candidates array', () => {
      const raw = { candidates: [] };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('handles candidate with undefined parts', () => {
      const raw = {
        candidates: [{ content: { parts: undefined }, finishReason: 'STOP' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('handles candidate with empty parts array', () => {
      const raw = {
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('handles parts with empty text', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.content).toEqual([{ type: 'text', text: '' }]);
    });

    test('handles functionCall with empty name', () => {
      const raw = {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: '', args: {} } }] },
            finishReason: 'STOP'
          }
        ]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.toolCalls?.[0].name).toBe('');
    });

    test('handles functionCall with empty args', () => {
      const raw = {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'test', args: {} } }] },
            finishReason: 'STOP'
          }
        ]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.toolCalls?.[0].arguments).toEqual({});
    });

    test('filters thought parts from content', () => {
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
      expect(unified.reasoning?.text).toBe('thinking...');
    });

    test('extracts multiple thought parts', () => {
      const raw = {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'Step 1. ' },
                { thought: true, text: 'Step 2.' },
                { text: 'Final answer' }
              ]
            },
            finishReason: 'STOP'
          }
        ]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.reasoning?.text).toBe('Step 1. Step 2.');
    });

    test('handles usage with all fields', () => {
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

      expect(unified.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        reasoningTokens: 3
      });
    });

    test('handles usage without reasoning tokens', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'test' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15
        }
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.usage?.reasoningTokens).toBeUndefined();
    });

    test('handles missing usage', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'test' }] }, finishReason: 'STOP' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.usage).toBeUndefined();
    });
  });

  describe('5. Finish Reason - All Google Variants', () => {
    test('preserves STOP finish reason', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBe('STOP');
    });

    test('preserves MAX_TOKENS finish reason', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'cut off' }] }, finishReason: 'MAX_TOKENS' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBe('MAX_TOKENS');
    });

    test('preserves SAFETY finish reason', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'blocked' }] }, finishReason: 'SAFETY' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBe('SAFETY');
    });

    test('preserves RECITATION finish reason', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'blocked' }] }, finishReason: 'RECITATION' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBe('RECITATION');
    });

    test('preserves OTHER finish reason', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'unknown' }] }, finishReason: 'OTHER' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBe('OTHER');
    });

    test('handles null finishReason', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'text' }] }, finishReason: null }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBeNull();
    });

    test('handles undefined finishReason', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'text' }] } }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBeUndefined();
    });

    test('handles unknown finish reason (passed through)', () => {
      const raw = {
        candidates: [{ content: { parts: [{ text: 'text' }] }, finishReason: 'UNKNOWN_REASON' }]
      };
      const unified: any = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

      expect(unified.finishReason).toBe('UNKNOWN_REASON');
    });
  });

  describe('6. Streaming - Edge Cases', () => {
    test('handles chunk with null candidates', () => {
      const chunk = { candidates: null };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed).toEqual({});
    });

    test('handles chunk with undefined candidates', () => {
      const chunk = {};
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed).toEqual({});
    });

    test('handles chunk with empty candidates array', () => {
      const chunk = { candidates: [] };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed).toEqual({});
    });

    test('handles candidate with empty parts', () => {
      const chunk = { candidates: [{ content: { parts: [] } }] };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed.text).toBeUndefined();
    });

    test('filters multiple thought parts correctly', () => {
      const chunk = {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'Thought 1' },
                { text: 'Regular 1' },
                { thought: true, text: 'Thought 2' },
                { text: 'Regular 2' }
              ]
            }
          }
        ]
      };
      const parsed: any = compat.parseSDKChunk(chunk);

      expect(parsed.text).toBe('Regular 1Regular 2');
      expect(parsed.reasoning?.text).toBe('Thought 1Thought 2');
    });

    test('handles reasoning with empty text', () => {
      const chunk = {
        candidates: [{ content: { parts: [{ thought: true, text: '' }] } }]
      };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed.reasoning).toBeUndefined();
    });

    test('handles tool call with empty args object', () => {
      const chunk = {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'test', args: {} } }] },
            finishReason: 'STOP'
          }
        ]
      };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed.toolEvents).toHaveLength(3);
      expect(parsed.toolEvents?.[1].argumentsDelta).toBe('{}');
    });

    test('emits all three tool events for function call', () => {
      const chunk = {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }] },
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

    test('handles multiple tool calls in single chunk (only first is processed in streaming)', () => {
      const chunk = {
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
      const parsed = compat.parseSDKChunk(chunk);

      // Google streaming only processes first tool call (uses parts.find())
      expect(parsed.toolEvents).toHaveLength(3);
      expect(parsed.toolEvents?.[0].name).toBe('tool1');
    });

    test('sets finishedWithToolCalls when STOP + tool calls seen', () => {
      const chunk = {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'test', args: {} } }] },
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
            content: { parts: [{ text: 'done' }] },
            finishReason: 'STOP'
          }
        ]
      };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed.finishedWithToolCalls).toBeUndefined();
    });

    test('handles usage metadata with all fields', () => {
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
        totalTokens: 35,
        reasoningTokens: 8
      });
    });

    test('handles usage metadata with partial fields', () => {
      const chunk = {
        candidates: [{ content: { parts: [{ text: 'test' }] } }],
        usageMetadata: {
          promptTokenCount: 10
        }
      };
      const parsed: any = compat.parseSDKChunk(chunk);

      expect(parsed.usage?.promptTokens).toBe(10);
      expect(parsed.usage?.completionTokens).toBeUndefined();
    });

    test('handles missing usage', () => {
      const chunk = {
        candidates: [{ content: { parts: [{ text: 'test' }] } }]
      };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed.usage).toBeUndefined();
    });

    test('handles text delta with empty string (not set when empty)', () => {
      const chunk = {
        candidates: [{ content: { parts: [{ text: '' }] } }]
      };
      const parsed = compat.parseSDKChunk(chunk);

      // Empty string is falsy, so text is not set
      expect(parsed.text).toBeUndefined();
    });

    test('combines multiple text parts in chunk', () => {
      const chunk = {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Hello ' },
                { text: 'world' }
              ]
            }
          }
        ]
      };
      const parsed = compat.parseSDKChunk(chunk);

      expect(parsed.text).toBe('Hello world');
    });
  });

  describe('7. Multi-Turn Conversations', () => {
    test('handles user → assistant → user flow', () => {
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: 'Hello' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'Hi there!' }] },
        { role: Role.USER, content: [{ type: 'text' as const, text: 'How are you?' }] }
      ];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

      expect(params.contents).toHaveLength(3);
      expect(params.contents[0].role).toBe('user');
      expect(params.contents[1].role).toBe('model');
      expect(params.contents[2].role).toBe('user');
    });

    test('handles tool call → tool result → assistant flow', () => {
      const messages = [
        { role: Role.USER, content: [{ type: 'text' as const, text: 'What is the weather?' }] },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'get.weather', arguments: { city: 'NYC' } }]
        },
        {
          role: Role.TOOL,
          toolCallId: 'call-1',
          content: [
            { type: 'tool_result' as const, toolName: 'get.weather', result: { temp: 72 } },
            { type: 'text' as const, text: 'Temperature is 72°F' }
          ]
        },
        { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'It is 72°F in NYC.' }] }
      ];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

      expect(params.contents).toHaveLength(4);
      expect(params.contents[1].parts[0].functionCall).toBeDefined();
      expect(params.contents[2].parts[0].functionResponse).toBeDefined();
    });

    test('handles multiple consecutive tool results', () => {
      const messages = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [
            { id: 'call-1', name: 'tool1', arguments: {} },
            { id: 'call-2', name: 'tool2', arguments: {} }
          ]
        },
        { role: Role.TOOL, toolCallId: 'call-1', content: [{ type: 'tool_result' as const, toolName: 'tool1', result: 'result1' }] },
        { role: Role.TOOL, toolCallId: 'call-2', content: [{ type: 'tool_result' as const, toolName: 'tool2', result: 'result2' }] }
      ];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

      expect(params.contents).toHaveLength(3);
    });
  });

  describe('8. Edge Cases and Special Behaviors', () => {
    test('handles empty messages array', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], [], undefined);

      expect(params.contents).toEqual([]);
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

      expect(unified.toolCalls?.[0].id).toBe('call_0');
      expect(unified.toolCalls?.[1].id).toBe('call_1');
    });

    test('config is undefined when no settings, tools, or system messages', () => {
      const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

      expect(params.config).toBeUndefined();
    });

    test('config is defined when system message present', () => {
      const messages = [
        { role: Role.SYSTEM, content: [{ type: 'text' as const, text: 'system' }] },
        { role: Role.USER, content: [{ type: 'text' as const, text: 'hi' }] }
      ];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, messages, [], undefined);

      expect(params.config).toBeDefined();
      expect(params.config?.systemInstruction).toBeDefined();
    });

    test('config is defined when settings present', () => {
      const params: any = compat.buildSDKParams('gemini-2.5-flash', { temperature: 0.5 }, [], [], undefined);

      expect(params.config).toBeDefined();
      expect(params.config?.temperature).toBe(0.5);
    });

    test('config is defined when tools present', () => {
      const tools = [{ name: 'test', description: 'Test', parameters: { type: 'object' as const, properties: {} } }];
      const params: any = compat.buildSDKParams('gemini-2.5-flash', {}, [], tools, 'auto');

      expect(params.config).toBeDefined();
      expect(params.config?.tools).toBeDefined();
    });
  });
});
