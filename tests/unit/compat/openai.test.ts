import { jest } from '@jest/globals';
import OpenAICompat from '@/plugins/compat/openai.ts';
import {
  Role,
  ToolCallEventType
} from '@/core/types.ts';

describe('compat/openai', () => {
  const compat = new OpenAICompat();

  test('buildPayload serialises messages, tools, and choices', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      {
        temperature: 0.5,
        topP: 0.9,
        maxTokens: 100,
        stop: ['END'],
        responseFormat: 'json'
      },
      [
        {
          role: Role.SYSTEM,
          content: [{ type: 'text', text: 'system' }]
        },
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'hello' }]
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [
            {
              id: 'call-1',
              name: 'echo.text',
              arguments: { text: 'hello' }
            }
          ]
        }
      ],
      [
        {
          name: 'echo.text',
          description: 'Echo tool',
          parametersJsonSchema: { type: 'object' }
        }
      ],
      { type: 'single', name: 'echo.text' }
    );

    expect(payload.model).toBe('gpt-4o');
    expect(payload.messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'system' }] });
    expect(payload.messages[2].tool_calls?.[0]).toEqual({
      id: 'call-1',
      type: 'function',
      function: {
        name: 'echo.text',
        arguments: JSON.stringify({ text: 'hello' })
      }
    });
    expect(payload.messages[2].content).toBe('');
    expect(payload.temperature).toBe(0.5);
    expect(payload.response_format).toEqual({ type: 'json' });
    expect(payload.tools?.[0].function.name).toBe('echo.text');
    expect(payload.tool_choice).toEqual({
      type: 'function',
      function: { name: 'echo.text' }
    });
  });

  test('serializeContent drops unsupported parts', () => {
    const compatAny = compat as any;
    const result = compatAny.serializeContent([
      { type: 'text', text: 'hello' },
      { type: 'image', imageUrl: 'http://image' },
      { type: 'audio', url: 'ignore' } as any
    ]);

    expect(result).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'http://image' } }
    ]);
  });

  test('buildPayload handles names, tool ids, images, tool results, and choice variants', () => {
    const payload = compat.buildPayload(
      'gpt-4',
      {
        temperature: undefined,
        responseFormat: undefined
      },
      [
        {
          role: Role.USER,
          name: 'caller',
          content: [
            { type: 'text', text: 'prompt' },
            { type: 'image', imageUrl: 'http://image' },
            { type: 'tool_result', toolName: 'unused', result: { ok: true } }
          ]
        },
        {
          role: Role.ASSISTANT,
          toolCallId: 'tc-1',
          content: []
        }
      ],
      [],
      { type: 'required', allowed: ['a.tool', 'b.tool'] }
    );

    expect(payload.messages[0].name).toBe('caller');
    expect(payload.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'http://image' }
    });
    expect(payload.messages[0].content).toHaveLength(2);
    expect(payload.messages[1].tool_call_id).toBe('tc-1');
    expect(payload.messages[1].content).toBe('');
    expect(payload.tool_choice).toBe('required');
    expect(payload.allowed_tools).toEqual(['a.tool', 'b.tool']);

    const autoChoice = compat.buildPayload(
      'gpt-3.5-turbo',
      { temperature: 0 },
      [],
      [],
      'auto'
    );
    expect(autoChoice.tool_choice).toBe('auto');

    const requiredSingle = compat.buildPayload(
      'gpt-4',
      { temperature: 0 },
      [],
      [],
      { type: 'required', allowed: ['only.this'] }
    );
    expect(requiredSingle.tool_choice).toEqual({
      type: 'function',
      function: { name: 'only.this' }
    });

    const unsupportedChoice = compat.buildPayload(
      'gpt-4',
      { temperature: 0 },
      [],
      [],
      { type: 'unsupported' } as unknown as any
    );
    expect(unsupportedChoice.tool_choice).toBeUndefined();
  });

  test('buildPayload supplies default tool parameters when schema missing', () => {
    const payload = compat.buildPayload(
      'gpt-4',
      { temperature: 0 },
      [],
      [
        {
          name: 'no.schema',
          description: 'Fallback schema'
        } as any
      ]
    );

    expect(payload.tools?.[0].function.parameters).toEqual({
      type: 'object',
      properties: {}
    });
  });

  test('parseResponse converts content, tool calls, and usage', () => {
    const raw = {
      provider: 'test',
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'done' }
            ],
            tool_calls: [
              {
                id: 'call-1',
                function: {
                  name: 'echo.text',
                  arguments: JSON.stringify({ text: 'hi' })
                }
              }
            ]
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    };

    const parsed = compat.parseResponse(raw, 'gpt-test');
    expect(parsed.provider).toBe('test');
    expect(parsed.model).toBe('gpt-test');
    expect(parsed.content[0]).toEqual({ type: 'text', text: 'done' });
    expect(parsed.toolCalls?.[0]).toEqual({
      id: 'call-1',
      name: 'echo.text',
      arguments: { text: 'hi' }
    });
    expect(parsed.finishReason).toBe('stop');
    expect(parsed.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  test('parseResponse omits reasoning when details lack summary', () => {
    const raw = {
      choices: [
        {
          message: {
            reasoning: undefined,
            reasoning_details: [{ type: 'reasoning.steps', steps: ['a'] }]
          },
          finish_reason: 'stop'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'model');
    expect(parsed.reasoning).toBeUndefined();
  });

  test('parseResponse normalises string content and missing tool calls', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'plain text'
          },
          finish_reason: 'length'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'gpt');
    expect(parsed.content).toEqual([{ type: 'text', text: 'plain text' }]);
    expect(parsed.toolCalls).toBeUndefined();
    expect(parsed.finishReason).toBe('length');
  });

  test('parseResponse falls back to empty content for unsupported payloads', () => {
    const raw = {
      choices: [
        {
          message: {
            content: { unsupported: true }
          },
          finish_reason: 'content_filter'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'gpt');
    expect(parsed.content).toEqual([{ type: 'text', text: '' }]);
    expect(parsed.finishReason).toBe('content_filter');
  });

  test('parseResponse defaults to empty text when content missing', () => {
    const raw = {
      choices: [
        {
          message: {},
          finish_reason: 'stop'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'gpt');
    expect(parsed.content).toEqual([{ type: 'text', text: '' }]);
    expect(parsed.finishReason).toBe('stop');
  });

  test('parseResponse normalises missing provider and absent text values', () => {
    const raw = {
      choices: [
        {
          message: {
            content: [
              { type: 'text' }
            ]
          },
          finish_reason: 'stop'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'model-x');
    expect(parsed.provider).toBe('openai');
    expect(parsed.content).toEqual([{ type: 'text', text: '' }]);
  });

  test('buildPayload maps tool_choice none and preserves response format', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      {
        temperature: 0,
        responseFormat: 'json_schema'
      },
      [],
      [],
      'none'
    );

    expect(payload.tool_choice).toBe('none');
    expect(payload.response_format).toEqual({ type: 'json_schema' });
  });

  test('buildPayload supports required tool choice with multiple options', () => {
    const payload = compat.buildPayload(
      'gpt-4',
      { temperature: 0 },
      [],
      [],
      { type: 'required', allowed: ['a.tool', 'b.tool'] }
    );
    expect(payload.tool_choice).toBe('required');
    expect(payload.allowed_tools).toEqual(['a.tool', 'b.tool']);
  });

  test('parseToolCalls handles missing ids and returns undefined when input invalid', () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: 'do.something',
                  arguments: JSON.stringify({ value: 1 })
                }
              }
            ]
          }
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'model');
    expect(parsed.toolCalls?.[0].id).toBe('call_0');

    const noCalls = compat.parseResponse({ choices: [{}] }, 'model');
    expect(noCalls.toolCalls).toBeUndefined();
  });

  test('parseResponse filters non-text parts and defaults tool call ids', () => {
    const raw = {
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'keep-me' },
              { type: 'image', image_url: { url: 'ignore' } }
            ],
            tool_calls: [
              {
                function: {
                  arguments: '{}'
                }
              }
            ]
          },
          finish_reason: 'stop'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'model');
    expect(parsed.content).toEqual([{ type: 'text', text: 'keep-me' }]);
    expect(parsed.toolCalls?.[0]).toMatchObject({
      id: 'call_0',
      name: ''
    });
  });

  test('buildPayload preserves empty user content arrays and omits tool section when absent', () => {
    const payload = compat.buildPayload(
      'gpt-4',
      { temperature: 0 },
      [
        {
          role: Role.USER,
          content: []
        }
      ],
      [],
      undefined
    );

    expect(payload.messages[0].content).toEqual([]);
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  test('parseToolCalls defaults missing arguments to empty objects', () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: 'no-args'
                }
              }
            ]
          }
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'model');
    expect(parsed.toolCalls?.[0].arguments).toEqual({});
  });

  test('parseResponse tolerates missing choices array', () => {
    const parsed = compat.parseResponse({}, 'model');
    expect(parsed.content).toEqual([{ type: 'text', text: '' }]);
    expect(parsed.toolCalls).toBeUndefined();
  });

  test('parseStreamChunk falls back to index when call id missing', () => {
    const chunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: '3',
                function: {
                  name: 'indexed',
                  arguments: '{"value":1}'
                }
              }
            ]
          }
        }
      ]
    };

    const result = compat.parseStreamChunk(chunk);
    expect(result.toolEvents?.[0]).toEqual({
      type: ToolCallEventType.TOOL_CALL_START,
      callId: '3',
      name: 'indexed'
    });
  });

  test('serializeToolChoice handles required variants directly', () => {
    const direct = (compat as any).serializeToolChoice({ type: 'required', allowed: ['a', 'b'] });
    expect(direct).toEqual({ tool_choice: 'required', allowed_tools: ['a', 'b'] });
  });

  test('parseStreamChunk emits text deltas and tool events', () => {
    const chunk = {
      choices: [
        {
          delta: {
            content: 'he',
            tool_calls: [
              {
                id: 'call-1',
                function: {
                  name: 'echo.text',
                  arguments: '{"text":"partial"}'
                }
              }
            ]
          }
        }
      ]
    };

    const result = compat.parseStreamChunk(chunk);
    expect(result.text).toBe('he');
    expect(result.toolEvents?.[0]).toEqual({
      type: ToolCallEventType.TOOL_CALL_START,
      callId: 'call-1',
      name: 'echo.text'
    });
    expect(result.toolEvents?.[1]).toEqual({
      type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
      callId: 'call-1',
      argumentsDelta: '{"text":"partial"}'
    });
  });

  test('parseStreamChunk tolerates finish flag with no tool calls', () => {
    const chunk = {
      choices: [
        {
          delta: {},
          finish_reason: 'tool_calls'
        }
      ]
    };

    expect(compat.parseStreamChunk(chunk)).toEqual({ finishedWithToolCalls: true, toolEvents: [] });
  });

  test('parseStreamChunk clears state on stop finish reason', () => {
    // First, add some state by parsing a tool call chunk
    compat.parseStreamChunk({
      choices: [{
        delta: {
          tool_calls: [{
            id: 'call-1',
            function: { name: 'test', arguments: '{}' }
          }]
        }
      }]
    });

    // Then send a chunk with finish_reason: 'stop' to trigger cleanup
    const result = compat.parseStreamChunk({
      choices: [{
        delta: { content: 'done' },
        finish_reason: 'stop'
      }]
    });

    expect(result.text).toBe('done');
    expect(result.toolEvents).toBeUndefined();

    // Verify state was cleared by sending another finish with tool_calls
    // If state wasn't cleared, this would emit END events from previous call
    const nextResult = compat.parseStreamChunk({
      choices: [{
        delta: {},
        finish_reason: 'tool_calls'
      }]
    });
    expect(nextResult.toolEvents).toEqual([]);
  });

  test('parseStreamChunk handles choices without delta', () => {
    const result = compat.parseStreamChunk({ choices: [{}] });
    expect(result).toEqual({});
  });

  test('parseStreamChunk returns empty result when choices missing', () => {
    expect(compat.parseStreamChunk({})).toEqual({});
  });

  test('applyProviderExtensions adds OpenRouter fields', () => {
    const payload = { existing: true };
    const extended = compat.applyProviderExtensions(payload, {
      provider: 'openrouter',
      route: 'fast',
      models: ['gpt'],
      transforms: ['step'],
      unused: 'ignore'
    });

    expect(extended).toMatchObject({
      existing: true,
      provider: 'openrouter',
      route: 'fast',
      models: ['gpt'],
      transforms: ['step']
    });
  });

  test('applyProviderExtensions adds plugins configuration', () => {
    const payload = { existing: true };
    const extensions = {
      plugins: [
        {
          id: 'file-parser',
          pdf: { engine: 'pdf-text' }
        }
      ]
    };

    const extended = compat.applyProviderExtensions(payload, extensions);

    expect(extended).toMatchObject({
      existing: true,
      plugins: [
        {
          id: 'file-parser',
          pdf: { engine: 'pdf-text' }
        }
      ]
    });
    expect(extensions.plugins).toBeUndefined(); // Should be deleted
  });

  test('getStreamingFlags exposes stream flag', () => {
    expect(compat.getStreamingFlags()).toEqual({ stream: true });
  });

  test('buildPayload includes standard OpenAI sampling parameters', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      {
        temperature: 0.7,
        seed: 42,
        frequencyPenalty: 0.5,
        presencePenalty: 0.3,
        logitBias: { 123: -100, 456: 50 },
        logprobs: true,
        topLogprobs: 5
      },
      [],
      []
    );

    expect(payload.model).toBe('gpt-4o');
    expect(payload.temperature).toBe(0.7);
    expect(payload.seed).toBe(42);
    expect(payload.frequency_penalty).toBe(0.5);
    expect(payload.presence_penalty).toBe(0.3);
    expect(payload.logit_bias).toEqual({ 123: -100, 456: 50 });
    expect(payload.logprobs).toBe(true);
    expect(payload.top_logprobs).toBe(5);
  });

  test('buildPayload logs debug info when LLM_LIVE=1', () => {
    const originalEnv = process.env.LLM_LIVE;
    process.env.LLM_LIVE = '1';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = compat.buildPayload(
        'gpt-4o',
        { temperature: 0 },
        [
          {
            role: Role.USER,
            name: 'test.user',
            content: [{ type: 'text', text: 'hello' }]
          }
        ],
        []
      );

      // Should log sanitized name debug message (line 61)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Sanitizing message name/));
      // Should log serialized messages (line 83)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Serialized messages/));
      // Verify payload was still built correctly
      expect(result.messages[0].name).toBe('test_user');
    } finally {
      errorSpy.mockRestore();
      if (originalEnv !== undefined) {
        process.env.LLM_LIVE = originalEnv;
      } else {
        delete process.env.LLM_LIVE;
      }
    }
  });

  test('buildPayload skips debug logging when LLM_LIVE is not set', () => {
    const originalEnv = process.env.LLM_LIVE;
    delete process.env.LLM_LIVE;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      compat.buildPayload(
        'gpt-4o',
        { temperature: 0 },
        [
          {
            role: Role.USER,
            name: 'test.user',
            content: [{ type: 'text', text: 'hello' }]
          }
        ],
        []
      );

      // Should not log anything
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      if (originalEnv !== undefined) {
        process.env.LLM_LIVE = originalEnv;
      }
    }
  });

  test('parseResponse extracts reasoning tokens from completion_tokens_details', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'response with reasoning'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: {
          reasoning_tokens: 25
        }
      }
    };

    const parsed = compat.parseResponse(raw, 'gpt-4o');
    expect(parsed.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: 25
    });
  });

  test('parseResponse handles missing reasoning tokens gracefully', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'response without reasoning'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150
      }
    };

    const parsed = compat.parseResponse(raw, 'gpt-4o');
    expect(parsed.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: undefined
    });
  });

  test('parseResponse extracts reasoning from message.reasoning field', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'response with reasoning',
            reasoning: 'This is my thought process...'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'gpt-4o');
    expect(parsed.reasoning).toEqual({
      text: 'This is my thought process...'
    });
  });

  test('parseResponse extracts reasoning from reasoning_details array', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'response with reasoning details',
            reasoning_details: [
              {
                type: 'reasoning.summary',
                summary: 'Detailed reasoning from array...'
              }
            ]
          },
          finish_reason: 'stop'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'gpt-4o');
    expect(parsed.reasoning).toEqual({
      text: 'Detailed reasoning from array...'
    });
  });

  test('parseResponse returns undefined reasoning when not present', () => {
    const raw = {
      choices: [
        {
          message: {
            content: 'no reasoning here'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const parsed = compat.parseResponse(raw, 'gpt-4o');
    expect(parsed.reasoning).toBeUndefined();
  });

  test('buildPayload serializes reasoning into message', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      { temperature: 0 },
      [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'response' }],
          reasoning: {
            text: 'My reasoning process...'
          }
        }
      ],
      []
    );

    expect(payload.messages[0].reasoning).toBe('My reasoning process...');
  });

  test('buildPayload omits reasoning field when redacted', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      { temperature: 0 },
      [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'response' }],
          reasoning: {
            text: 'My reasoning process...',
            redacted: true
          }
        }
      ],
      []
    );

    expect(payload.messages[0].reasoning).toBeUndefined();
  });

  test('buildPayload omits reasoning when not present', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      { temperature: 0 },
      [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'response' }]
        }
      ],
      []
    );

    expect(payload.messages[0].reasoning).toBeUndefined();
  });

  test('buildPayload automatically adds plugins for PDF documents', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      { temperature: 0 },
      [
        {
          role: Role.USER,
          content: [
            { type: 'text', text: 'What is in this PDF?' },
            {
              type: 'document',
              source: { type: 'base64', data: 'dGVzdA==' },
              mimeType: 'application/pdf',
              filename: 'test.pdf'
            }
          ]
        }
      ],
      []
    );

    expect(payload.plugins).toEqual([
      {
        id: 'file-parser',
        pdf: {
          engine: 'pdf-text'
        }
      }
    ]);
  });

  test('buildPayload does not add plugins when no PDF documents present', () => {
    const payload = compat.buildPayload(
      'gpt-4o',
      { temperature: 0 },
      [
        {
          role: Role.USER,
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'image', imageUrl: 'data:image/png;base64,test' }
          ]
        }
      ],
      []
    );

    expect(payload.plugins).toBeUndefined();
  });

  test('extractReasoningFromDelta aggregates string and object segments', () => {
    const result = (compat as any).extractReasoningFromDelta({
      reasoning: [
        'first',
        { text: ' second', metadata: { alpha: true } },
        {
          content: [
            { type: 'output_text', text: ' third' },
            { type: 'ignored', text: '!' }
          ],
          metadata: { beta: 1 }
        }
      ]
    });

    expect(result).toEqual({
      text: 'first second third',
      metadata: {
        provider: 'openai',
        alpha: true,
        beta: 1
      }
    });
  });

  test('extractReasoningFromDelta returns undefined when no text generated', () => {
    const result = (compat as any).extractReasoningFromDelta({ reasoning: [{}] });
    expect(result).toBeUndefined();
  });

  test('normalizeUsageStats falls back to camelCase fields', () => {
    const stats = (compat as any).normalizeUsageStats({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      reasoning_tokens: 4
    });

    expect(stats).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      reasoningTokens: 4
    });
  });

  test('normalizeUsageStats prefers completion token detail reasoning', () => {
    const stats = (compat as any).normalizeUsageStats({
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 2 }
    });

    expect(stats.reasoningTokens).toBe(2);
  });

  test('extractReasoningFromDelta handles single object with output_text parts', () => {
    const result = (compat as any).extractReasoningFromDelta({
      reasoning: {
        content: [{ type: 'output_text', text: 'chunk' }, { type: 'ignored', text: '!' }]
      }
    });

    expect(result).toEqual({
      text: 'chunk',
      metadata: { provider: 'openai' }
    });
  });

  test('extractReasoningFromDelta skips falsy segments', () => {
    const result = (compat as any).extractReasoningFromDelta({
      reasoning: [null, 'kept']
    });

    expect(result).toEqual({
      text: 'kept',
      metadata: { provider: 'openai' }
    });
  });

  // Extended usage stats tests for OpenRouter caching support
  describe('extended usage stats (OpenRouter caching)', () => {
    test('parseResponse extracts cost from usage', () => {
      const raw = {
        choices: [
          {
            message: { content: 'response' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          cost: 0.00125
        }
      };

      const parsed = compat.parseResponse(raw, 'gpt-4o');
      expect(parsed.usage?.cost).toBe(0.00125);
    });

    test('parseResponse extracts cached_tokens from prompt_tokens_details', () => {
      const raw = {
        choices: [
          {
            message: { content: 'response' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: {
            cached_tokens: 75,
            audio_tokens: 10
          }
        }
      };

      const parsed = compat.parseResponse(raw, 'gpt-4o');
      expect(parsed.usage?.cachedTokens).toBe(75);
      expect(parsed.usage?.audioTokens).toBe(10);
    });

    test('parseResponse handles all extended usage fields together', () => {
      const raw = {
        choices: [
          {
            message: { content: 'response' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          cost: 0.00125,
          prompt_tokens_details: {
            cached_tokens: 75,
            audio_tokens: 10
          },
          completion_tokens_details: {
            reasoning_tokens: 25
          }
        }
      };

      const parsed = compat.parseResponse(raw, 'gpt-4o');
      expect(parsed.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        reasoningTokens: 25,
        cost: 0.00125,
        cachedTokens: 75,
        audioTokens: 10
      });
    });

    test('parseResponse handles missing extended usage fields gracefully', () => {
      const raw = {
        choices: [
          {
            message: { content: 'response' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150
        }
      };

      const parsed = compat.parseResponse(raw, 'gpt-4o');
      expect(parsed.usage?.cost).toBeUndefined();
      expect(parsed.usage?.cachedTokens).toBeUndefined();
      expect(parsed.usage?.audioTokens).toBeUndefined();
    });

    test('normalizeUsageStats handles extended fields in streaming', () => {
      const stats = (compat as any).normalizeUsageStats({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cost: 0.001,
        prompt_tokens_details: {
          cached_tokens: 25,
          audio_tokens: 5
        }
      });

      expect(stats).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        reasoningTokens: undefined,
        cost: 0.001,
        cachedTokens: 25,
        audioTokens: 5
      });
    });

    test('normalizeUsageStats handles camelCase fallbacks for extended fields', () => {
      const stats = (compat as any).normalizeUsageStats({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cost: 0.002,
        cachedTokens: 30,
        audioTokens: 8
      });

      expect(stats.cost).toBe(0.002);
      expect(stats.cachedTokens).toBe(30);
      expect(stats.audioTokens).toBe(8);
    });
  });
});
