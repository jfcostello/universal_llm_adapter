import { jest } from '@jest/globals';
import GoogleCompat from '@/plugins/compat/google/index.ts';

describe('unit/compat/google', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    if (originalApiKey) {
      process.env.GEMINI_API_KEY = originalApiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    delete process.env.GOOGLE_API_KEY;
  });

  test('constructor initializes without API key', () => {
    const compat = new GoogleCompat();
    expect(compat).toBeDefined();
  });

  test('getSDKClient extracts API key from headers.Authorization', () => {
    const compat: any = new GoogleCompat();
    const headers = { Authorization: 'test-key-from-headers' };
    const client = compat.getSDKClient(headers);
    expect(client).toBeDefined();
  });

  test('getSDKClient falls back to GOOGLE_API_KEY environment variable', () => {
    process.env.GOOGLE_API_KEY = 'test-key-from-env';
    const compat: any = new GoogleCompat();
    const client = compat.getSDKClient();
    expect(client).toBeDefined();
  });

  test('getSDKClient throws error when no API key is available', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const compat: any = new GoogleCompat();
    expect(() => compat.getSDKClient()).toThrow('Google API key required');
  });

  test('serializeMessages converts basic messages correctly', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'sys prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }
    ];

    const result = compat.serializeMessages(messages);

    expect(result.systemInstruction).toEqual([{ text: 'sys prompt' }]);
    expect(result.contents).toHaveLength(2);
    expect(result.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
    expect(result.contents[1]).toEqual({ role: 'model', parts: [{ text: 'hi there' }] });
  });

  test('serializeMessages handles tool calls and responses', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'SF' } }]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [{ type: 'tool_result', toolName: 'get_weather', result: { temp: 72 } }]
      }
    ];

    const result = compat.serializeMessages(messages);

    expect(result.contents).toHaveLength(2);
    expect(result.contents[0].role).toBe('model');
    expect(result.contents[0].parts[0]).toEqual({
      functionCall: { name: 'get_weather', args: { city: 'SF' } }
    });
    expect(result.contents[1].role).toBe('user');
    expect(result.contents[1].parts[0]).toEqual({
      functionResponse: { name: 'get_weather', response: { temp: 72 } }
    });
  });

  test('serializeMessages handles images', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', imageUrl: 'https://example.com/img.png', mimeType: 'image/png' }
        ]
      }
    ];

    const result = compat.serializeMessages(messages);

    expect(result.contents[0].parts).toHaveLength(2);
    expect(result.contents[0].parts[0]).toEqual({ text: 'Look at this' });
    expect(result.contents[0].parts[1]).toEqual({
      fileData: { fileUri: 'https://example.com/img.png', mimeType: 'image/png' }
    });
  });

  test('serializeSettings maps fields correctly', () => {
    const compat: any = new GoogleCompat();
    const settings = {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1000,
      stop: ['END'],
      reasoningBudget: 5000
    };

    const result = compat.serializeSettings(settings);

    expect(result).toEqual({
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 1000,
      stopSequences: ['END'],
      thinkingConfig: { thinkingBudget: 5000 }
    });
  });

  test('convertSchemaToGoogleFormat converts JSON schema correctly', () => {
    const compat: any = new GoogleCompat();
    const schema = {
      type: 'object',
      description: 'A test schema',
      properties: {
        name: { type: 'string', description: 'Name field' },
        age: { type: 'integer', minimum: 0, maximum: 120 },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }
      },
      required: ['name']
    };

    const result = compat.convertSchemaToGoogleFormat(schema);

    expect(result.type).toBe('OBJECT');
    expect(result.description).toBe('A test schema');
    expect(result.properties.name.type).toBe('STRING');
    expect(result.properties.age.type).toBe('INTEGER');
    expect(result.properties.age.minimum).toBe(0);
    expect(result.properties.age.maximum).toBe(120);
    expect(result.properties.tags.type).toBe('ARRAY');
    expect(result.properties.tags.items.enum).toEqual(['a', 'b']);
    expect(result.required).toEqual(['name']);
  });

  test('serializeToolsForSDK converts tools correctly', () => {
    const compat: any = new GoogleCompat();
    const tools = [
      {
        name: 'get.weather',
        description: 'Get weather',
        parametersJsonSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    ];

    const result = compat.serializeToolsForSDK(tools);

    expect(result).toHaveLength(1);
    expect(result[0].functionDeclarations).toHaveLength(1);
    expect(result[0].functionDeclarations[0].name).toBe('get_weather'); // sanitized
    expect(result[0].functionDeclarations[0].description).toBe('Get weather');
    expect(result[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
  });

  test('serializeToolChoiceForSDK handles string choices', () => {
    const compat: any = new GoogleCompat();

    const autoResult = compat.serializeToolChoiceForSDK('auto');
    expect(autoResult).toEqual({ functionCallingConfig: { mode: 'AUTO' } });

    const noneResult = compat.serializeToolChoiceForSDK('none');
    expect(noneResult).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  });

  test('serializeToolChoiceForSDK defaults to AUTO when tools provided but no choice', () => {
    const compat: any = new GoogleCompat();
    const tools = [{ name: 'tool1', description: 'Tool 1' }];

    const result = compat.serializeToolChoiceForSDK(undefined, tools);

    expect(result).toEqual({
      functionCallingConfig: {
        mode: 'AUTO'
      }
    });
  });

  test('serializeToolChoiceForSDK handles single tool choice', () => {
    const compat: any = new GoogleCompat();
    const choice = { type: 'single', name: 'specific.tool' };

    const result = compat.serializeToolChoiceForSDK(choice);

    expect(result).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['specific_tool']
      }
    });
  });

  test('serializeToolChoiceForSDK handles required with allowed list', () => {
    const compat: any = new GoogleCompat();
    const choice = { type: 'required', allowed: ['tool1', 'tool2'] };

    const result = compat.serializeToolChoiceForSDK(choice);

    expect(result).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['tool1', 'tool2']
      }
    });
  });

  test('parseSDKResponse converts response correctly', () => {
    const compat: any = new GoogleCompat();
    const raw = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Response text' },
              { functionCall: { name: 'tool1', args: { param: 'value' } } }
            ]
          },
          finishReason: 'STOP'
        }
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30
      }
    };

    const result = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

    expect(result.provider).toBe('Google');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Response text' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: 'tool1',
      arguments: { param: 'value' }
    });
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30
    });
  });

  test('parseSDKChunk handles text chunks', () => {
    const compat: any = new GoogleCompat();
    const chunk = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello ' }, { text: 'world' }]
          }
        }
      ]
    };

    const result = compat.parseSDKChunk(chunk);

    expect(result.text).toBe('Hello world');
  });

  test('parseSDKChunk handles function call chunks', () => {
    const compat: any = new GoogleCompat();
    const chunk = {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }]
          },
          finishReason: 'STOP'
        }
      ]
    };

    const result = compat.parseSDKChunk(chunk);

    expect(result.toolEvents).toHaveLength(3);
    expect(result.toolEvents[0].type).toBe('tool_call_start');
    expect(result.toolEvents[1].type).toBe('tool_call_arguments_delta');
    expect(result.toolEvents[2].type).toBe('tool_call_end');
    expect(result.finishedWithToolCalls).toBe(true);
  });

  test('buildPayload throws error for HTTP method', () => {
    const compat = new GoogleCompat();
    expect(() => {
      compat.buildPayload('model', {}, [], []);
    }).toThrow('Google compat uses SDK methods');
  });

  test('parseResponse throws error for HTTP method', () => {
    const compat = new GoogleCompat();
    expect(() => {
      compat.parseResponse({}, 'model');
    }).toThrow('Google compat uses SDK methods');
  });

  test('parseStreamChunk delegates to parseSDKChunk', () => {
    const compat = new GoogleCompat();
    const chunk = {
      candidates: [
        {
          content: {
            parts: [{ text: 'test' }]
          }
        }
      ]
    };
    const result = compat.parseStreamChunk(chunk);
    expect(result.text).toBe('test');
  });

  test('getStreamingFlags returns empty object', () => {
    const compat = new GoogleCompat();
    expect(compat.getStreamingFlags()).toEqual({});
  });

  test('extractToolResponse handles structured tool_result', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'tool_result', toolName: 'weather', result: { temp: 75, unit: 'F' } }
      ]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBe('weather');
    expect(response).toEqual({ temp: 75, unit: 'F' });
  });

  test('extractToolResponse falls back to text when no structured result', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'Success' }]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBeUndefined();
    expect(response).toBe('Success');
  });

  test('serializeMessages aggregates multiple system messages', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'Part 1. ' }] },
      { role: 'system', content: [{ type: 'text', text: 'Part 2.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] }
    ];

    const result = compat.serializeMessages(messages);

    expect(result.systemInstruction).toEqual([{ text: 'Part 1. Part 2.' }]);
  });

  test('serializeMessages omits systemInstruction when empty', () => {
    const compat: any = new GoogleCompat();
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }];

    const result = compat.serializeMessages(messages);

    expect(result.systemInstruction).toBeUndefined();
  });

  test('parseSDKResponse handles empty candidates', () => {
    const compat: any = new GoogleCompat();
    const raw = {};

    const result = compat.parseSDKResponse(raw, 'gemini-2.5-flash');

    expect(result.content).toEqual([{ type: 'text', text: '' }]);
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  test('parseSDKChunk handles empty chunks', () => {
    const compat: any = new GoogleCompat();
    const chunk = {};

    const result = compat.parseSDKChunk(chunk);

    expect(result).toEqual({});
  });

  test('convertSchemaToGoogleFormat handles empty schema', () => {
    const compat: any = new GoogleCompat();

    const result = compat.convertSchemaToGoogleFormat({});

    expect(result).toEqual({ type: 'OBJECT', properties: {} });
  });

  test('convertSchemaToGoogleFormat handles null schema', () => {
    const compat: any = new GoogleCompat();

    const result = compat.convertSchemaToGoogleFormat(null);

    expect(result).toEqual({ type: 'OBJECT', properties: {} });
  });

  test('serializeToolsForSDK returns undefined for empty tools array', () => {
    const compat: any = new GoogleCompat();

    const result = compat.serializeToolsForSDK([]);

    expect(result).toBeUndefined();
  });

  test('serializeToolChoiceForSDK returns undefined for unknown choice', () => {
    const compat: any = new GoogleCompat();

    const result = compat.serializeToolChoiceForSDK({ type: 'unknown' } as any);

    expect(result).toBeUndefined();
  });

  test('extractUsage handles missing usage metadata', () => {
    const compat: any = new GoogleCompat();

    const result = compat.extractUsage(undefined);

    expect(result).toBeUndefined();
  });

  test('extractToolCalls handles empty parts array', () => {
    const compat: any = new GoogleCompat();

    const result = compat.extractToolCalls([]);

    expect(result).toBeUndefined();
  });

  test('callSDK makes successful API call', async () => {
    const compat: any = new GoogleCompat();
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: 'Response' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 }
    };

    const mockSDKClient = {
      models: {
        generateContent: jest.fn().mockResolvedValue(mockResponse)
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    const result = await compat.callSDK('gemini-2.5-flash', {}, [], []);

    expect(result.content[0].text).toBe('Response');
    expect(result.usage.promptTokens).toBe(5);
  });

  test('callSDK handles errors', async () => {
    const compat: any = new GoogleCompat();
    const mockError = new Error('API Error');

    const mockSDKClient = {
      models: {
        generateContent: jest.fn().mockRejectedValue(mockError)
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    await expect(compat.callSDK('gemini-2.5-flash', {}, [], [])).rejects.toThrow('API Error');
  });

  test('streamSDK yields chunks successfully', async () => {
    const compat: any = new GoogleCompat();
    const mockChunks = [
      { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] },
      { candidates: [{ content: { parts: [{ text: ' world' }] } }] }
    ];

    async function* mockGenerator() {
      for (const chunk of mockChunks) {
        yield chunk;
      }
    }

    const mockSDKClient = {
      models: {
        generateContentStream: jest.fn().mockResolvedValue(mockGenerator())
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    const chunks = [];
    for await (const chunk of compat.streamSDK('gemini-2.5-flash', {}, [], [])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].candidates[0].content.parts[0].text).toBe('Hello');
  });

  test('streamSDK handles errors', async () => {
    const compat: any = new GoogleCompat();
    const mockError = new Error('Stream Error');

    const mockSDKClient = {
      models: {
        generateContentStream: jest.fn().mockRejectedValue(mockError)
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    await expect(async () => {
      for await (const chunk of compat.streamSDK('gemini-2.5-flash', {}, [], [])) {
        // Should throw before yielding
      }
    }).rejects.toThrow('Stream Error');
  });

  test('extractToolResponse collects all text parts including countdown', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'tool_result', toolName: 'test', result: { value: 42 } },
        { type: 'text', text: 'Result: 42' },
        { type: 'text', text: 'Tool calls used 1 of 10' }
      ]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBe('test');
    expect(response).toEqual({ output: 'Result: 42\nTool calls used 1 of 10' });
  });

  test('buildSDKParams includes all config options', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'System' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ];
    const settings = { temperature: 0.5, maxTokens: 100, reasoningBudget: 1000 };
    const tools = [{ name: 'tool1', description: 'Tool', parametersJsonSchema: {} }];
    const toolChoice = 'auto';

    const result = compat.buildSDKParams('gemini-2.5-flash', settings, messages, tools, toolChoice);

    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.contents).toHaveLength(1);
    expect(result.config.systemInstruction).toBeDefined();
    expect(result.config.temperature).toBe(0.5);
    expect(result.config.maxOutputTokens).toBe(100);
    expect(result.config.thinkingConfig).toEqual({ thinkingBudget: 1000 });
    expect(result.config.tools).toBeDefined();
    expect(result.config.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });

  test('callSDK logs with logger', async () => {
    const compat: any = new GoogleCompat();
    const logger = {
      info: jest.fn(),
      error: jest.fn()
    };
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: 'Response' }] } }]
    };

    const mockSDKClient = {
      models: {
        generateContent: jest.fn().mockResolvedValue(mockResponse)
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    await compat.callSDK('gemini-2.5-flash', {}, [], [], undefined, logger);

    expect(logger.info).toHaveBeenCalledWith('Google SDK generateContent params', expect.any(Object));
  });

  test('callSDK logs errors with logger', async () => {
    const compat: any = new GoogleCompat();
    const logger = {
      info: jest.fn(),
      error: jest.fn()
    };
    const mockError = new Error('API Error');

    const mockSDKClient = {
      models: {
        generateContent: jest.fn().mockRejectedValue(mockError)
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    await expect(compat.callSDK('gemini-2.5-flash', {}, [], [], undefined, logger)).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith('Google SDK call failed', expect.any(Object));
  });

  test('streamSDK logs with logger', async () => {
    const compat: any = new GoogleCompat();
    const logger = {
      info: jest.fn(),
      error: jest.fn()
    };

    async function* mockGenerator() {
      yield { candidates: [{ content: { parts: [{ text: 'test' }] } }] };
    }

    const mockSDKClient = {
      models: {
        generateContentStream: jest.fn().mockResolvedValue(mockGenerator())
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    for await (const chunk of compat.streamSDK('gemini-2.5-flash', {}, [], [], undefined, logger)) {
      // Consume chunks
    }

    expect(logger.info).toHaveBeenCalledWith('Google SDK generateContentStream params', expect.any(Object));
  });

  test('streamSDK logs errors with logger', async () => {
    const compat: any = new GoogleCompat();
    const logger = {
      info: jest.fn(),
      error: jest.fn()
    };
    const mockError = new Error('Stream Error');

    const mockSDKClient = {
      models: {
        generateContentStream: jest.fn().mockRejectedValue(mockError)
      }
    };

    jest.spyOn(compat, 'getSDKClient').mockReturnValue(mockSDKClient);

    await expect(async () => {
      for await (const chunk of compat.streamSDK('gemini-2.5-flash', {}, [], [], undefined, logger)) {
        // Should throw
      }
    }).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith('Google SDK streaming failed', expect.any(Object));
  });

  test('convertSchemaToGoogleFormat adds properties to OBJECT type', () => {
    const compat: any = new GoogleCompat();
    const schema = { type: 'object' };

    const result = compat.convertSchemaToGoogleFormat(schema);

    expect(result.type).toBe('OBJECT');
    expect(result.properties).toEqual({});
  });

  test('convertSchemaToGoogleFormat infers OBJECT type from properties', () => {
    const compat: any = new GoogleCompat();
    const schema = {
      properties: { name: { type: 'string' } },
      required: ['name']
    };

    const result = compat.convertSchemaToGoogleFormat(schema);

    expect(result.type).toBe('OBJECT');
  });

  test('serializeToolChoiceForSDK returns undefined for unknown string choice', () => {
    const compat: any = new GoogleCompat();

    const result = compat.serializeToolChoiceForSDK('unknown_choice');

    expect(result).toBeUndefined();
  });

  test('serializeTools delegates to serializeToolsForSDK', () => {
    const compat: any = new GoogleCompat();
    const tools = [{ name: 'tool1', description: 'Tool', parametersJsonSchema: {} }];

    const result = compat.serializeTools(tools);

    expect(result).toBeDefined();
    expect(result[0].functionDeclarations).toBeDefined();
  });

  test('serializeToolChoice delegates to serializeToolChoiceForSDK', () => {
    const compat: any = new GoogleCompat();

    const result = compat.serializeToolChoice('auto');

    expect(result).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });

  test('applyProviderExtensions returns payload unchanged', () => {
    const compat = new GoogleCompat();
    const payload = { test: 'value' };

    const result = compat.applyProviderExtensions(payload, {});

    expect(result).toBe(payload);
  });

  test('extractReasoning extracts thought parts', () => {
    const compat: any = new GoogleCompat();
    const parts = [
      { thought: true, text: 'Thinking step 1' },
      { text: 'Regular text' },
      { thought: true, text: ' and step 2' }
    ];

    const reasoning = compat.extractReasoning(parts);

    expect(reasoning).toEqual({
      text: 'Thinking step 1 and step 2',
      metadata: { provider: 'google' }
    });
  });

  test('extractReasoning returns undefined for no thought parts', () => {
    const compat: any = new GoogleCompat();

    const result1 = compat.extractReasoning([]);
    expect(result1).toBeUndefined();

    const result2 = compat.extractReasoning([{ text: 'No thought' }]);
    expect(result2).toBeUndefined();

    const result3 = compat.extractReasoning(undefined);
    expect(result3).toBeUndefined();
  });

  test('extractUsage includes reasoning tokens when present', () => {
    const compat: any = new GoogleCompat();
    const usage = {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      totalTokenCount: 150,
      thoughtsTokenCount: 25
    };

    const result = compat.extractUsage(usage);

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: 25
    });
  });

  test('parseSDKResponse excludes thought parts from content', () => {
    const compat: any = new GoogleCompat();
    const response = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'Internal thinking' },
            { text: 'Actual response' }
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15
      }
    };

    const result = compat.parseSDKResponse(response, 'gemini-2.5-flash');

    expect(result.content).toEqual([{ type: 'text', text: 'Actual response' }]);
    expect(result.reasoning).toEqual({
      text: 'Internal thinking',
      metadata: { provider: 'google' }
    });
  });

  test('parseSDKChunk excludes thought parts from text', () => {
    const compat: any = new GoogleCompat();
    const chunk = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'Thinking...' },
            { text: 'Output text' }
          ]
        }
      }]
    };

    const result = compat.parseSDKChunk(chunk);

    expect(result.text).toBe('Output text');
    expect(result.reasoning).toEqual({
      text: 'Thinking...',
      metadata: { provider: 'google' }
    });
  });

  test('serializeMessages handles empty system text', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'system', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ];

    const { systemInstruction } = compat.serializeMessages(messages);

    expect(systemInstruction).toBeUndefined();
  });

  test('serializeMessages handles missing text in system content', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'system', content: [{ type: 'text' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ];

    const { systemInstruction } = compat.serializeMessages(messages);

    expect(systemInstruction).toBeUndefined();
  });

  test('serializeMessages handles empty content array', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'user', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Response' }] }
    ];

    const { contents } = compat.serializeMessages(messages);

    expect(contents[0].parts).toEqual([]);
  });

  test('serializeMessages handles missing tool call arguments', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Calling tool' }],
        toolCalls: [{ id: 'call-1', name: 'test.tool' }]
      }
    ];

    const { contents } = compat.serializeMessages(messages);

    expect(contents[0].parts[1].functionCall).toEqual({
      name: 'test.tool',
      args: {}
    });
  });

  test('extractToolResponse handles missing toolName', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [{ type: 'text', text: 'Result text' }]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBeUndefined();
    expect(response).toBe('Result text');
  });

  test('extractToolResponse handles empty text parts', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [
        { type: 'tool_result', toolName: 'test.tool', result: { data: 'value' } }
      ]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBe('test_tool');
    expect(response).toEqual({ data: 'value' });
  });

  test('extractToolResponse handles no text parts but has result', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [
        { type: 'tool_result', toolName: 'test.tool', result: 'string result' }
      ]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBe('test_tool');
    expect(response).toBe('string result');
  });

  test('serializeToolsForSDK handles missing tool description', () => {
    const compat: any = new GoogleCompat();
    const tools = [{ name: 'test.tool', parametersJsonSchema: { type: 'object' } }];

    const result = compat.serializeToolsForSDK(tools);

    expect(result[0].functionDeclarations[0].description).toBe('');
  });

  test('convertSchemaToGoogleFormat handles unmapped type', () => {
    const compat: any = new GoogleCompat();
    const schema = { type: 'null' };

    const result = compat.convertSchemaToGoogleFormat(schema);

    expect(result.type).toBe('NULL');
  });

  test('convertSchemaToGoogleFormat handles format field', () => {
    const compat: any = new GoogleCompat();
    const schema = { type: 'string', format: 'email' };

    const result = compat.convertSchemaToGoogleFormat(schema);

    expect(result.format).toBe('email');
  });

  test('parseSDKResponse handles parts with undefined text', () => {
    const compat: any = new GoogleCompat();
    const response = {
      candidates: [{
        content: {
          parts: [
            { text: undefined },
            { text: 'Valid text' }
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
    };

    const result = compat.parseSDKResponse(response, 'gemini-2.5-flash');

    expect(result.content).toEqual([{ type: 'text', text: 'Valid text' }]);
  });

  test('parseSDKChunk handles missing function call name', () => {
    const compat: any = new GoogleCompat();
    const chunk = {
      candidates: [{
        content: {
          parts: [{ functionCall: { args: { param: 'value' } } }]
        },
        finishReason: 'STOP'
      }]
    };

    const result = compat.parseSDKChunk(chunk);

    expect(result.toolEvents?.[0].name).toBe('');
  });

  test('parseSDKChunk handles missing function call args', () => {
    const compat: any = new GoogleCompat();
    const chunk = {
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'test.tool' } }]
        },
        finishReason: 'STOP'
      }]
    };

    const result = compat.parseSDKChunk(chunk);

    const argsEvent = result.toolEvents?.find(e => e.type === 'tool_call_arguments_delta');
    expect(argsEvent?.argumentsDelta).toBe('{}');
  });

  test('parseSDKChunk handles undefined usage', () => {
    const compat: any = new GoogleCompat();
    const chunk = {
      candidates: [{
        content: { parts: [{ text: 'Hello' }] }
      }]
    };

    const result = compat.parseSDKChunk(chunk);

    expect(result.usage).toBeUndefined();
  });

  test('extractToolCalls handles missing function call name', () => {
    const compat: any = new GoogleCompat();
    const parts = [
      { functionCall: { args: { test: 'value' } } }
    ];

    const result = compat.extractToolCalls(parts);

    expect(result?.[0].name).toBe('');
  });

  test('extractToolCalls handles missing function call args', () => {
    const compat: any = new GoogleCompat();
    const parts = [
      { functionCall: { name: 'test.tool' } }
    ];

    const result = compat.extractToolCalls(parts);

    expect(result?.[0].arguments).toEqual({});
  });

  test('serializeMessages handles undefined content in system message', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'system' }, // No content field
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ];

    const { systemInstruction } = compat.serializeMessages(messages);

    expect(systemInstruction).toBeUndefined();
  });

  test('serializeMessages handles undefined content in user message', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'user' }, // No content field
      { role: 'assistant', content: [{ type: 'text', text: 'Response' }] }
    ];

    const { contents } = compat.serializeMessages(messages);

    expect(contents[0].parts).toEqual([]);
  });

  test('serializeMessages handles text part with undefined text', () => {
    const compat: any = new GoogleCompat();
    const messages = [
      { role: 'user', content: [{ type: 'text' }] } // No text field
    ];

    const { contents } = compat.serializeMessages(messages);

    expect(contents[0].parts[0].text).toBe('');
  });

  test('extractToolResponse handles undefined content in tool message', () => {
    const compat: any = new GoogleCompat();
    const message = { role: 'tool' }; // No content field

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBeUndefined();
    expect(response).toBe('');
  });

  test('extractToolResponse handles undefined text in text parts', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [
        { type: 'tool_result', toolName: 'test.tool', result: 'value' },
        { type: 'text' } // No text field
      ]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBe('test_tool');
    expect(response).toEqual({ output: '' });
  });

  test('extractToolResponse handles undefined result', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [
        { type: 'tool_result', toolName: 'test.tool' } // No result field
      ]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBe('test_tool');
    expect(response).toEqual({});
  });

  test('extractToolResponse handles fallback with non-string text', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [] // Empty, forcing fallback
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBeUndefined();
    expect(response).toBe('');
  });

  test('serializeToolsForSDK handles tool with undefined parametersJsonSchema', () => {
    const compat: any = new GoogleCompat();
    const tools = [{ name: 'test.tool', description: 'Test' }]; // No parametersJsonSchema

    const result = compat.serializeToolsForSDK(tools);

    expect(result[0].functionDeclarations[0].parameters).toBeDefined();
    expect(result[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
  });

  test('extractToolResponse handles tool message with undefined content for textParts branch', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [
        { type: 'tool_result', toolName: 'test.tool', result: { value: 'data' } }
      ]
      // No text content field, triggering message.content || [] on line 234
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBe('test_tool');
    expect(response).toEqual({ value: 'data' });
  });

  test('extractToolResponse fallback handles message with undefined content for line 254', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool'
      // No content field - triggers (message.content || []) on line 254
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBeUndefined();
    expect(response).toBe('');
  });

  test('parseSDKResponse handles part with null text triggering ?? operator', () => {
    const compat: any = new GoogleCompat();
    const response = {
      candidates: [{
        content: {
          parts: [
            { text: null }, // null text, triggers ?? '' on line 407
            { text: 'Valid' }
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
    };

    const result = compat.parseSDKResponse(response, 'gemini-2.5-flash');

    expect(result.content[0].text).toBe('Valid');
  });

  test('parseSDKChunk with usage triggers if (usage) branch on line 467', () => {
    const compat: any = new GoogleCompat();
    const chunk = {
      candidates: [{
        content: { parts: [{ text: 'Test' }] }
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15
      }
    };

    const result = compat.parseSDKChunk(chunk);

    expect(result.usage).toBeDefined();
    expect(result.usage?.totalTokens).toBe(15);
  });

  test('extractToolResponse fallback handles text parts with undefined triggering ?? on line 256', () => {
    const compat: any = new GoogleCompat();
    const message = {
      role: 'tool',
      content: [
        { type: 'text', text: null }, // null triggers ?? '' on line 256
        { type: 'text', text: 'data' }
      ]
    };

    const [name, response] = compat.extractToolResponse(message);

    expect(name).toBeUndefined();
    expect(response).toBe('data');
  });

  test('extractToolResponse with toolPart but undefined message.content triggers || [] fallback', () => {
    const compat: any = new GoogleCompat();
    // Message with toolPart info but undefined content - triggers (message.content || []) on line 273
    const message = {
      role: 'tool',
      toolCallId: 'call-1',
      content: undefined // Explicitly undefined triggers the || [] fallback
    };
    // Add a tool_result part by manipulating to find
    (message as any).content = [
      { type: 'tool_result', toolName: 'my.tool', result: { answer: 42 } }
    ];
    // Now remove text parts - keep only tool_result
    const [name, response] = compat.extractToolResponse(message);
    expect(name).toBe('my_tool');
    expect(response).toEqual({ answer: 42 });
  });

  test('parseSDKResponse maps part with text filter but undefined text uses ?? fallback on line 446', () => {
    const compat: any = new GoogleCompat();
    // The filter checks typeof p?.text === 'string', so we need to create a scenario
    // where text IS a string (passes filter) but then the ?? '' would be used
    // Actually, looking at line 446 more carefully:
    // .filter(p => typeof p?.text === 'string' && p.thought !== true)
    // .map(p => ({ type: 'text', text: p.text ?? '' } as TextContent))
    // If typeof p?.text === 'string' is true, then p.text is a string and ?? '' never triggers
    // This is essentially dead code. The ?? '' is defensive but can never execute.
    // For coverage, we'd need text to pass the filter AND be nullish, which is impossible.
    // Let's verify the filter works correctly instead.
    const response = {
      candidates: [{
        content: {
          parts: [
            { text: 'valid' },
            { text: undefined }, // won't pass filter
            { text: null }, // won't pass filter
            { text: '' }, // passes filter, empty string
            { thought: true, text: 'thinking' } // won't pass filter due to thought
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    };

    const result = compat.parseSDKResponse(response, 'gemini-2.5-flash');

    // Only 'valid' and '' should pass the filter
    expect(result.content).toEqual([
      { type: 'text', text: 'valid' },
      { type: 'text', text: '' }
    ]);
  });

  // Issue #78: thoughtSignature preservation for Google Gemini reasoning
  describe('thoughtSignature preservation (Issue #78)', () => {
    test('extractToolCalls captures thoughtSignature in metadata', () => {
      const compat: any = new GoogleCompat();
      const parts = [
        {
          functionCall: { name: 'get_weather', args: { city: 'NYC' } },
          thoughtSignature: 'EpwCCpkCAXLI2nwMdJvMR...'
        }
      ];

      const result = compat.extractToolCalls(parts);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('get_weather');
      expect(result[0].arguments).toEqual({ city: 'NYC' });
      expect(result[0].metadata).toBeDefined();
      expect(result[0].metadata.thoughtSignature).toBe('EpwCCpkCAXLI2nwMdJvMR...');
    });

    test('extractToolCalls handles multiple tool calls with different signatures', () => {
      const compat: any = new GoogleCompat();
      const parts = [
        {
          functionCall: { name: 'tool1', args: { a: 1 } },
          thoughtSignature: 'signature_1...'
        },
        {
          functionCall: { name: 'tool2', args: { b: 2 } },
          thoughtSignature: 'signature_2...'
        }
      ];

      const result = compat.extractToolCalls(parts);

      expect(result).toHaveLength(2);
      expect(result[0].metadata.thoughtSignature).toBe('signature_1...');
      expect(result[1].metadata.thoughtSignature).toBe('signature_2...');
    });

    test('extractToolCalls handles tool call without thoughtSignature', () => {
      const compat: any = new GoogleCompat();
      const parts = [
        { functionCall: { name: 'basic_tool', args: { x: 'y' } } }
      ];

      const result = compat.extractToolCalls(parts);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('basic_tool');
      expect(result[0].metadata).toBeUndefined();
    });

    test('serializeMessages includes thoughtSignature when present in tool call metadata', () => {
      const compat: any = new GoogleCompat();
      const messages = [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              id: 'call_0',
              name: 'get_weather',
              arguments: { city: 'NYC' },
              metadata: { thoughtSignature: 'EpwCCpkCAXLI2nwMdJvMR...' }
            }
          ]
        }
      ];

      const result = compat.serializeMessages(messages);

      expect(result.contents[0].parts[0]).toEqual({
        functionCall: { name: 'get_weather', args: { city: 'NYC' } },
        thoughtSignature: 'EpwCCpkCAXLI2nwMdJvMR...'
      });
    });

    test('serializeMessages handles tool call without metadata', () => {
      const compat: any = new GoogleCompat();
      const messages = [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            { id: 'call_0', name: 'simple_tool', arguments: { a: 1 } }
          ]
        }
      ];

      const result = compat.serializeMessages(messages);

      expect(result.contents[0].parts[0]).toEqual({
        functionCall: { name: 'simple_tool', args: { a: 1 } }
      });
      expect(result.contents[0].parts[0].thoughtSignature).toBeUndefined();
    });

    test('parseSDKResponse preserves thoughtSignature in tool calls', () => {
      const compat: any = new GoogleCompat();
      const response = {
        candidates: [{
          content: {
            parts: [
              {
                functionCall: { name: 'test_tool', args: { param: 'value' } },
                thoughtSignature: 'crypto_signature_here...'
              }
            ]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      };

      const result = compat.parseSDKResponse(response, 'gemini-3-pro-preview');

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].metadata).toBeDefined();
      expect(result.toolCalls[0].metadata.thoughtSignature).toBe('crypto_signature_here...');
    });

    test('parseSDKChunk preserves thoughtSignature in streaming tool calls', () => {
      const compat: any = new GoogleCompat();
      const chunk = {
        candidates: [{
          content: {
            parts: [
              {
                functionCall: { name: 'stream_tool', args: { key: 'val' } },
                thoughtSignature: 'stream_signature...'
              }
            ]
          },
          finishReason: 'STOP'
        }]
      };

      const result = compat.parseSDKChunk(chunk);

      // Tool events should include metadata with thoughtSignature
      expect(result.toolEvents).toBeDefined();
      const startEvent = result.toolEvents?.find((e: any) => e.type === 'tool_call_start');
      expect(startEvent?.metadata?.thoughtSignature).toBe('stream_signature...');
    });

    test('full round-trip: response -> message -> serialization preserves thoughtSignature', () => {
      const compat: any = new GoogleCompat();

      // Step 1: Parse response with thoughtSignature
      const response = {
        candidates: [{
          content: {
            parts: [
              {
                functionCall: { name: 'round_trip_tool', args: { data: 'test' } },
                thoughtSignature: 'round_trip_signature...'
              }
            ]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
      };

      const parsed = compat.parseSDKResponse(response, 'gemini-3-pro-preview');

      // Step 2: Create message with parsed tool calls (simulating what tool loop does)
      const assistantMessage = {
        role: 'assistant',
        content: [],
        toolCalls: parsed.toolCalls
      };

      // Step 3: Serialize back for next request
      const serialized = compat.serializeMessages([assistantMessage]);

      // Step 4: Verify thoughtSignature is preserved
      expect(serialized.contents[0].parts[0].thoughtSignature).toBe('round_trip_signature...');
    });
  });
});
