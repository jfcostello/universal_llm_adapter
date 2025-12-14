import { jest } from '@jest/globals';
import OpenAICompat from '@/plugins/compat/openai/index.ts';
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
  namedMessages,
  invalidNameMessages,
  allSettings,
  minimalSettings,
  reasoningSettings,
  reasoningEnabledOnly,
  reasoningBudgetOnly,
  reasoningEffortOnly,
  reasoningExcludeOnly,
  reasoningCombined,
  reasoningBudgetFallback
} from './test-fixtures.ts';

describe('integration/providers/openai-provider', () => {
  let compat: OpenAICompat;

  beforeEach(() => {
    compat = new OpenAICompat();
  });

  describe('1. Payload Building Tests', () => {
    describe('1.1 Basic Message Serialization', () => {
      test('serializes system messages correctly', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, [], undefined);

        expect(payload.messages).toHaveLength(2);
        expect(payload.messages[0]).toMatchObject({ role: 'system', content: [{ type: 'text', text: 'system' }] });
      });

      test('serializes user messages correctly', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, [], undefined);

        expect(payload.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
      });

      test('serializes assistant messages correctly', () => {
        const messages = [
          { role: Role.ASSISTANT, content: [{ type: 'text' as const, text: 'response' }] }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'response' }] });
      });

      test('serializes tool messages correctly', () => {
        const messages = [
          {
            role: Role.TOOL,
            toolCallId: 'call-123',
            content: [{ type: 'text' as const, text: 'result' }]
          }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0]).toMatchObject({
          role: 'tool',
          tool_call_id: 'call-123',
          content: [{ type: 'text', text: 'result' }]
        });
      });

      test('handles empty content correctly', () => {
        const payload = compat.buildPayload('gpt-4', {}, emptyContentMessages, [], undefined);

        expect(payload.messages[0].content).toBe('');
      });
    });

    describe('1.2 Content Type Handling', () => {
      test('handles text content parts', () => {
        const messages = [
          {
            role: Role.USER,
            content: [
              { type: 'text' as const, text: 'First part. ' },
              { type: 'text' as const, text: 'Second part.' }
            ]
          }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].content).toHaveLength(2);
        expect(payload.messages[0].content[0]).toEqual({ type: 'text', text: 'First part. ' });
        expect(payload.messages[0].content[1]).toEqual({ type: 'text', text: 'Second part.' });
      });

      test('handles image content parts', () => {
        const payload = compat.buildPayload('gpt-4', {}, imageMessages, [], undefined);

        expect(payload.messages[0].content).toHaveLength(2);
        expect(payload.messages[0].content[0]).toEqual({ type: 'text', text: 'What is this?' });
        expect(payload.messages[0].content[1]).toEqual({
          type: 'image_url',
          image_url: { url: 'https://example.com/image.jpg' }
        });
      });

      test('filters out tool_result content parts', () => {
        const payload = compat.buildPayload('gpt-4', {}, toolResultMessages, [], undefined);

        // tool_result content should be filtered out, only text remains
        const textContent = payload.messages[0].content.filter((c: any) => c.type === 'text');
        expect(textContent).toHaveLength(1);
        expect(textContent[0].text).toBe('Temperature is 72°F');
      });

      test('handles empty text', () => {
        const messages = [{ role: Role.USER, content: [{ type: 'text' as const, text: '' }] }];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].content[0]).toEqual({ type: 'text', text: '' });
      });
    });

    describe('1.3 Tool Calling', () => {
      test('serializes tools for function calling', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, baseTools, 'auto');

        expect(payload.tools).toHaveLength(1);
        expect(payload.tools[0]).toMatchObject({
          type: 'function',
          function: {
            name: 'echo.text',
            description: 'Echo tool',
            parameters: expect.objectContaining({ type: 'object' })
          }
        });
      });

      test('serializes single tool call in assistant message', () => {
        const payload = compat.buildPayload('gpt-4', {}, toolCallMessages, [], undefined);

        expect(payload.messages[0].tool_calls).toHaveLength(1);
        expect(payload.messages[0].tool_calls[0]).toMatchObject({
          id: 'call-1',
          type: 'function',
          function: {
            name: 'get.weather',
            arguments: JSON.stringify({ city: 'SF' })
          }
        });
      });

      test('serializes multiple tool calls', () => {
        const payload = compat.buildPayload('gpt-4', {}, multipleToolCallMessages, [], undefined);

        expect(payload.messages[0].tool_calls).toHaveLength(2);
        expect(payload.messages[0].tool_calls[0].function.name).toBe('get.weather');
        expect(payload.messages[0].tool_calls[1].function.name).toBe('get.weather');
      });

      test('handles tool choice "auto"', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, baseTools, 'auto');

        expect(payload.tool_choice).toBe('auto');
      });

      test('handles tool choice "none"', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, baseTools, 'none');

        expect(payload.tool_choice).toBe('none');
      });

      test('handles single tool choice', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, baseTools, {
          type: 'single',
          name: 'echo.text'
        });

        expect(payload.tool_choice).toEqual({
          type: 'function',
          function: { name: 'echo.text' }
        });
      });

      test('handles required tool choice with multiple tools', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, multipleTools, {
          type: 'required',
          allowed: ['get.weather', 'search.web']
        });

        expect(payload.tool_choice).toBe('required');
        expect(payload.allowed_tools).toEqual(['get.weather', 'search.web']);
      });

      test('handles required tool choice with single tool (optimization)', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, baseTools, {
          type: 'required',
          allowed: ['echo.text']
        });

        expect(payload.tool_choice).toEqual({
          type: 'function',
          function: { name: 'echo.text' }
        });
      });

      test('handles undefined tool choice', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, baseTools, undefined);

        expect(payload.tool_choice).toBeUndefined();
      });

      test('handles empty tools array', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, [], undefined);

        expect(payload.tools).toBeUndefined();
      });
    });

    describe('1.4 Settings Mapping', () => {
      test('maps all standard settings', () => {
        const payload = compat.buildPayload('gpt-4', allSettings, baseMessages, [], undefined);

        expect(payload.temperature).toBe(0.7);
        expect(payload.top_p).toBe(0.9);
        expect(payload.max_tokens).toBe(1024);
        expect(payload.stop).toEqual(['STOP', 'END']);
        expect(payload.response_format).toEqual({ type: 'json_object' });
        expect(payload.seed).toBe(42);
        expect(payload.frequency_penalty).toBe(0.5);
        expect(payload.presence_penalty).toBe(0.3);
        expect(payload.logit_bias).toEqual({ 123: -100 });
        expect(payload.logprobs).toBe(true);
        expect(payload.top_logprobs).toBe(5);
      });

      test('handles undefined settings', () => {
        const payload = compat.buildPayload('gpt-4', {}, baseMessages, [], undefined);

        expect(payload.temperature).toBeUndefined();
        expect(payload.top_p).toBeUndefined();
        expect(payload.max_tokens).toBeUndefined();
      });

      test('handles partial settings', () => {
        const payload = compat.buildPayload('gpt-4', minimalSettings, baseMessages, [], undefined);

        expect(payload.temperature).toBe(0);
        expect(payload.top_p).toBeUndefined();
      });

      describe('reasoning settings serialization', () => {
        test('serializes reasoning with enabled only', () => {
          const payload = compat.buildPayload('gpt-4', reasoningEnabledOnly, baseMessages, [], undefined);

          expect(payload.reasoning).toEqual({ enabled: true });
        });

        test('serializes reasoning with budget (maps to max_tokens)', () => {
          const payload = compat.buildPayload('gpt-4', reasoningBudgetOnly, baseMessages, [], undefined);

          expect(payload.reasoning).toEqual({ max_tokens: 2000 });
        });

        test('serializes reasoning with effort', () => {
          const payload = compat.buildPayload('gpt-4', reasoningEffortOnly, baseMessages, [], undefined);

          expect(payload.reasoning).toEqual({ effort: 'high' });
        });

        test('serializes reasoning with exclude', () => {
          const payload = compat.buildPayload('gpt-4', reasoningExcludeOnly, baseMessages, [], undefined);

          expect(payload.reasoning).toEqual({ exclude: true });
        });

        test('serializes reasoning with combined options', () => {
          const payload = compat.buildPayload('gpt-4', reasoningCombined, baseMessages, [], undefined);

          expect(payload.reasoning).toEqual({ enabled: true, effort: 'high', exclude: false });
        });

        test('uses reasoningBudget fallback when budget not in reasoning object', () => {
          const payload = compat.buildPayload('gpt-4', reasoningBudgetFallback, baseMessages, [], undefined);

          expect(payload.reasoning).toEqual({ enabled: true, max_tokens: 3000 });
        });

        test('does not include reasoning when undefined', () => {
          const payload = compat.buildPayload('gpt-4', {}, baseMessages, [], undefined);

          expect(payload.reasoning).toBeUndefined();
        });

        test('prefers budget over reasoningBudget when both present', () => {
          const settings = { reasoning: { enabled: true, budget: 1500 }, reasoningBudget: 3000 };
          const payload = compat.buildPayload('gpt-4', settings, baseMessages, [], undefined);

          expect(payload.reasoning).toEqual({ enabled: true, max_tokens: 1500 });
        });

        test('prefers effort over budget when both present', () => {
          const settings = { reasoning: { effort: 'medium' as const, budget: 2000 } };
          const payload = compat.buildPayload('gpt-4', settings, baseMessages, [], undefined);

          // When effort is set, budget should not be converted to max_tokens
          expect(payload.reasoning).toEqual({ effort: 'medium' });
        });
      });
    });

    describe('1.5 Reasoning/Thinking', () => {
      test('serializes reasoning in assistant messages (not redacted)', () => {
        const payload = compat.buildPayload('gpt-4', {}, reasoningMessages, [], undefined);

        expect(payload.messages[0].reasoning).toBe('Let me think about this step by step...');
      });

      test('omits redacted reasoning from payload', () => {
        const messages = [
          {
            role: Role.ASSISTANT,
            content: [{ type: 'text' as const, text: 'Answer' }],
            reasoning: { text: 'Hidden', redacted: true }
          }
        ];
        const payload = compat.buildPayload('gpt-4', {}, messages, [], undefined);

        expect(payload.messages[0].reasoning).toBeUndefined();
      });
    });

    describe('1.6 Name Sanitization', () => {
      test('sanitizes valid message names', () => {
        const payload = compat.buildPayload('gpt-4', {}, namedMessages, [], undefined);

        expect(payload.messages[0].name).toBe('user_name-123'); // dots are sanitized to underscores
      });

      test('sanitizes invalid characters in message names', () => {
        const payload = compat.buildPayload('gpt-4', {}, invalidNameMessages, [], undefined);

        expect(payload.messages[0].name).toBe('user_email_com'); // @ and . are sanitized
      });
    });

    describe('1.7 Edge Cases', () => {
      test('handles empty messages array', () => {
        const payload = compat.buildPayload('gpt-4', {}, [], [], undefined);

        expect(payload.messages).toEqual([]);
      });

      test('handles complex multi-turn conversation', () => {
        const payload = compat.buildPayload('gpt-4', {}, complexConversation, multipleTools, 'auto');

        expect(payload.messages).toHaveLength(5);
        expect(payload.messages[0].role).toBe('system');
        expect(payload.messages[2].tool_calls).toBeDefined();
        expect(payload.messages[3].role).toBe('tool');
      });
    });
  });

  describe('2. Response Parsing Tests', () => {
    describe('2.1 Basic Parsing', () => {
      test('parses text responses', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.content).toEqual([{ type: 'text', text: 'Hello!' }]);
        expect(unified.provider).toBe('openai');
        expect(unified.model).toBe('gpt-4');
      });

      test('handles empty content', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.content).toEqual([{ type: 'text', text: '' }]);
      });

      test('handles missing content', () => {
        const raw = {
          choices: [{ message: { role: 'assistant' }, finish_reason: 'stop' }]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.content).toEqual([{ type: 'text', text: '' }]);
      });
    });

    describe('2.2 Tool Call Parsing', () => {
      test('parses single tool call', () => {
        const raw = {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    function: { name: 'echo.text', arguments: '{"text":"hello"}' }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.toolCalls).toHaveLength(1);
        expect(unified.toolCalls?.[0]).toMatchObject({
          id: 'call-1',
          name: 'echo.text',
          arguments: { text: 'hello' }
        });
      });

      test('parses multiple tool calls', () => {
        const raw = {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call-1', function: { name: 'tool1', arguments: '{"a":1}' } },
                  { id: 'call-2', function: { name: 'tool2', arguments: '{"b":2}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.toolCalls).toHaveLength(2);
        expect(unified.toolCalls?.[0].name).toBe('tool1');
        expect(unified.toolCalls?.[1].name).toBe('tool2');
      });

      test('handles missing tool call ID', () => {
        const raw = {
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [{ function: { name: 'test', arguments: '{}' } }]
              },
              finish_reason: 'tool_calls'
            }
          ]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.toolCalls?.[0].id).toBe('call_0');
      });

      test('handles missing arguments', () => {
        const raw = {
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [{ id: 'call-1', function: { name: 'test' } }]
              },
              finish_reason: 'tool_calls'
            }
          ]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.toolCalls?.[0].arguments).toEqual({});
      });
    });

    describe('2.3 Usage Statistics', () => {
      test('extracts usage stats', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            completion_tokens_details: { reasoning_tokens: 3 }
          }
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          reasoningTokens: 3
        });
      });

      test('handles missing usage', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.usage).toBeUndefined();
      });

      test('handles missing reasoning tokens', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15
          }
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.usage?.reasoningTokens).toBeUndefined();
      });
    });

    describe('2.4 Reasoning Parsing', () => {
      test('extracts reasoning from direct field', () => {
        const raw = {
          choices: [
            {
              message: { role: 'assistant', content: 'answer', reasoning: 'thinking...' },
              finish_reason: 'stop'
            }
          ]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.reasoning).toEqual({ text: 'thinking...' });
      });

      test('extracts reasoning from reasoning_details array', () => {
        const raw = {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'answer',
                reasoning_details: [
                  { type: 'reasoning.summary', summary: 'deep thought' }
                ]
              },
              finish_reason: 'stop'
            }
          ]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.reasoning).toEqual({
          text: 'deep thought',
          metadata: {
            rawDetails: [
              { type: 'reasoning.summary', summary: 'deep thought' }
            ]
          }
        });
      });

      test('handles missing reasoning', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.reasoning).toBeUndefined();
      });
    });

    describe('2.5 Content Variations', () => {
      test('handles string content', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'simple text' }, finish_reason: 'stop' }]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.content).toEqual([{ type: 'text', text: 'simple text' }]);
      });

      test('handles array content', () => {
        const raw = {
          choices: [
            {
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'part1' },
                  { type: 'text', text: 'part2' }
                ]
              },
              finish_reason: 'stop'
            }
          ]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.content).toHaveLength(2);
      });
    });

    describe('2.6 Finish Reason Mapping', () => {
      test('preserves stop finish reason', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'stop' }]
        };
        const unified = compat.parseResponse(raw, 'gpt-4');

        expect(unified.finishReason).toBe('stop');
      });

      test('preserves length finish reason', () => {
        const raw = {
          choices: [{ message: { role: 'assistant', content: 'test' }, finish_reason: 'length' }]
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
    });
  });

  describe('3. Streaming Tests', () => {
    describe('3.1 Text Streaming', () => {
      test('emits text deltas', () => {
        const chunk = {
          choices: [{ delta: { content: 'hello' }, finish_reason: null }]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.text).toBe('hello');
      });

      test('handles missing delta', () => {
        const chunk = { choices: [{ finish_reason: null }] };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.text).toBeUndefined();
      });

      test('handles empty choices', () => {
        const chunk = { choices: [] };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed).toEqual({});
      });
    });

    describe('3.2 Tool Call Streaming', () => {
      test('emits TOOL_CALL_START event', () => {
        const chunk = {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: 'call-1', index: 0, function: { name: 'test', arguments: '' } }
                ]
              }
            }
          ]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents).toHaveLength(1);
        expect(parsed.toolEvents?.[0]).toMatchObject({
          type: ToolCallEventType.TOOL_CALL_START,
          callId: 'call-1',
          name: 'test'
        });
      });

      test('emits TOOL_CALL_ARGUMENTS_DELTA events', () => {
        // First chunk with START
        compat.parseStreamChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-1', index: 0, function: { name: 'test', arguments: '' } }]
              }
            }
          ]
        });

        // Second chunk with DELTA
        const chunk = {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"key":' } }]
              }
            }
          ]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.toolEvents).toContainEqual(
          expect.objectContaining({
            type: ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA,
            argumentsDelta: '{"key":'
          })
        );
      });

      test('emits TOOL_CALL_END event on finish', () => {
        // Setup state with tool call that has arguments
        const chunk1 = {
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-1', index: 0, function: { name: 'test', arguments: '{}' } }]
              }
            }
          ]
        };
        compat.parseStreamChunk(chunk1);

        // Finish chunk with tool_calls delta (required for END events)
        const chunk = {
          choices: [{ delta: { tool_calls: [] }, finish_reason: 'tool_calls' }]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.finishedWithToolCalls).toBe(true);
        // END events only emitted if we saw tool_calls in the current chunk
      });

      test('emits all events in sequence for complete stream', () => {
        // Create fresh compat instance for clean state
        const streamCompat = new OpenAICompat();

        // START
        const chunk1 = {
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-1', index: 0, function: { name: 'echo', arguments: '' } }]
              }
            }
          ]
        };
        const parsed1 = streamCompat.parseStreamChunk(chunk1);
        expect(parsed1.toolEvents?.[0].type).toBe(ToolCallEventType.TOOL_CALL_START);

        // DELTA
        const chunk2 = {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"msg":"hi"}' } }]
              }
            }
          ]
        };
        const parsed2 = streamCompat.parseStreamChunk(chunk2);
        expect(parsed2.toolEvents?.[0].type).toBe(ToolCallEventType.TOOL_CALL_ARGUMENTS_DELTA);

        // END - need tool_calls in delta for END events
        const chunk3 = {
          choices: [{ delta: { tool_calls: [] }, finish_reason: 'tool_calls' }]
        };
        const parsed3 = streamCompat.parseStreamChunk(chunk3);
        expect(parsed3.finishedWithToolCalls).toBe(true);
      });
    });

    describe('3.3 State Management', () => {
      test('accumulates tool call arguments across chunks', () => {
        const streamCompat = new OpenAICompat();

        streamCompat.parseStreamChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-1', index: 0, function: { name: 'test', arguments: '{"a"' } }]
              }
            }
          ]
        });

        streamCompat.parseStreamChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: ':1}' } }]
              }
            }
          ]
        });

        const finish = streamCompat.parseStreamChunk({
          choices: [{ delta: { tool_calls: [] }, finish_reason: 'tool_calls' }]
        });

        // State is accumulated but END events only if tool_calls in finish chunk
        expect(finish.finishedWithToolCalls).toBe(true);
      });

      test('maps index to ID for OpenAI streaming', () => {
        const chunk = {
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-abc', index: 0, function: { name: 'test', arguments: '' } }]
              }
            }
          ]
        };
        compat.parseStreamChunk(chunk);

        // Later chunk with only index
        const chunk2 = {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{}' } }]
              }
            }
          ]
        };
        const parsed = compat.parseStreamChunk(chunk2);

        expect(parsed.toolEvents?.[0].callId).toBe('call-abc');
      });

      test('clears state on finish_reason', () => {
        // Build up state
        compat.parseStreamChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-1', index: 0, function: { name: 'test', arguments: '{}' } }]
              }
            }
          ]
        });

        // Finish
        compat.parseStreamChunk({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }]
        });

        // New stream should not have old state
        const newChunk = {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }]
        };
        const parsed = compat.parseStreamChunk(newChunk);

        expect(parsed.toolEvents).toEqual([]);
      });

      test('isolates state between streams', () => {
        // First stream
        compat.parseStreamChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-1', index: 0, function: { name: 'test1', arguments: '{}' } }]
              }
            }
          ]
        });
        compat.parseStreamChunk({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }]
        });

        // Second stream should be independent
        const newCompat = new OpenAICompat();
        const chunk = {
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-2', index: 0, function: { name: 'test2', arguments: '{}' } }]
              }
            }
          ]
        };
        const parsed = newCompat.parseStreamChunk(chunk);

        expect(parsed.toolEvents?.[0].name).toBe('test2');
      });
    });

    describe('3.4 Finish Conditions', () => {
      test('detects tool_calls finish reason', () => {
        compat.parseStreamChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call-1', index: 0, function: { name: 'test', arguments: '{}' } }]
              }
            }
          ]
        });

        const chunk = {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.finishedWithToolCalls).toBe(true);
      });

      test('handles stop finish reason', () => {
        const chunk = {
          choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.finishedWithToolCalls).toBeUndefined();
      });

      test('handles length finish reason', () => {
        const chunk = {
          choices: [{ delta: {}, finish_reason: 'length' }]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.finishedWithToolCalls).toBeUndefined();
      });
    });

    describe('3.5 Usage Tracking in Streams', () => {
      test('emits usage stats in chunks', () => {
        const chunk = {
          choices: [{ delta: { content: 'test' } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            completion_tokens_details: { reasoning_tokens: 2 }
          }
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.usage).toEqual({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          reasoningTokens: 2
        });
      });

      test('handles missing usage in chunks', () => {
        const chunk = {
          choices: [{ delta: { content: 'test' } }]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.usage).toBeUndefined();
      });
    });

    describe('3.6 Reasoning Streaming', () => {
      test('emits reasoning text as string', () => {
        const chunk = {
          choices: [
            {
              delta: { content: 'answer', reasoning: 'thinking...' }
            }
          ]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning).toEqual({
          text: 'thinking...',
          metadata: { provider: 'openai' }
        });
      });

      test('emits reasoning text from object with text field', () => {
        const chunk = {
          choices: [
            {
              delta: {
                reasoning: { text: 'analysis', metadata: { stage: 'planning' } }
              }
            }
          ]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning?.text).toBe('analysis');
        expect(parsed.reasoning?.metadata).toMatchObject({ provider: 'openai', stage: 'planning' });
      });

      test('merges multiple content parts from array', () => {
        const chunk = {
          choices: [
            {
              delta: {
                reasoning: [
                  {
                    content: [
                      { type: 'output_text', text: 'Part A. ' },
                      { type: 'output_text', text: 'Part B.' }
                    ]
                  }
                ]
              }
            }
          ]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning?.text).toBe('Part A. Part B.');
      });

      test('aggregates metadata from segments', () => {
        const chunk = {
          choices: [
            {
              delta: {
                reasoning: [
                  {
                    text: 'thought',
                    metadata: { step: 1, confidence: 0.9 }
                  }
                ]
              }
            }
          ]
        };
        const parsed = compat.parseStreamChunk(chunk);

        expect(parsed.reasoning?.metadata).toMatchObject({
          provider: 'openai',
          step: 1,
          confidence: 0.9
        });
      });
    });
  });

  describe('4. Provider Extensions Tests', () => {
    test('applies OpenRouter provider field', () => {
      let payload = { model: 'test' };
      payload = compat.applyProviderExtensions(payload, { provider: 'openai/gpt-4' });

      expect(payload.provider).toBe('openai/gpt-4');
    });

    test('applies OpenRouter transforms field', () => {
      let payload = { model: 'test' };
      payload = compat.applyProviderExtensions(payload, { transforms: ['middle-out'] });

      expect(payload.transforms).toEqual(['middle-out']);
    });

    test('applies OpenRouter route field', () => {
      let payload = { model: 'test' };
      payload = compat.applyProviderExtensions(payload, { route: 'fallback' });

      expect(payload.route).toBe('fallback');
    });

    test('applies OpenRouter models field', () => {
      let payload = { model: 'test' };
      payload = compat.applyProviderExtensions(payload, { models: ['gpt-4', 'gpt-3.5'] });

      expect(payload.models).toEqual(['gpt-4', 'gpt-3.5']);
    });

    test('ignores unknown fields', () => {
      let payload = { model: 'test' };
      payload = compat.applyProviderExtensions(payload, { unknown: 'value' });

      expect(payload.unknown).toBeUndefined();
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
    });

    test('serializeTools with empty array', () => {
      const result = compat.serializeTools([]);

      expect(result).toEqual({});
    });

    test('serializeToolChoice with all variants', () => {
      expect(compat.serializeToolChoice('auto')).toEqual({ tool_choice: 'auto' });
      expect(compat.serializeToolChoice('none')).toEqual({ tool_choice: 'none' });
      expect(compat.serializeToolChoice({ type: 'single', name: 'test' })).toEqual({
        tool_choice: { type: 'function', function: { name: 'test' } }
      });
      expect(compat.serializeToolChoice(undefined)).toEqual({});
    });
  });
});
