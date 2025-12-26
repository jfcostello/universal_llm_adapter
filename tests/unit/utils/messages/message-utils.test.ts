import { describe, expect, test } from '@jest/globals';
import { Role } from '@/kernel/index.ts';
import {
  aggregateSystemMessages,
  appendAssistantToolCalls,
  appendToolResult,
  extractToolResultFromMessage,
  prepareMessages
} from '@/modules/messages/index.ts';

describe('utils/messages/message-utils', () => {
  test('prepareMessages prepends system prompt when present', () => {
    const spec = {
      systemPrompt: 'You are a test system.',
      messages: [
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'hello' }]
        }
      ]
    } as any;

    const prepared = prepareMessages(spec);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toEqual({
      role: Role.SYSTEM,
      content: [{ type: 'text', text: 'You are a test system.' }]
    });
    expect(prepared[1]).toBe(spec.messages[0]);
  });

  test('prepareMessages returns original messages when system prompt missing', () => {
    const spec = {
      messages: [
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'no system prompt' }]
        }
      ]
    } as any;

    const prepared = prepareMessages(spec);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toBe(spec.messages[0]);
  });

  test('aggregateSystemMessages returns original array when zero or one system message', () => {
    const noSystem = [
      { role: Role.USER, content: [{ type: 'text', text: 'hello' }] }
    ];
    const singleSystem = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'only' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'hi' }] }
    ];

    expect(aggregateSystemMessages(noSystem)).toBe(noSystem);
    expect(aggregateSystemMessages(singleSystem)).toBe(singleSystem);
  });

  test('aggregateSystemMessages merges multiple system messages and preserves other order', () => {
    const messages = [
      { role: Role.USER, content: [{ type: 'text', text: 'before' }] },
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'first' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'between' }] },
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'second' }] },
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'third' }] }
    ];

    const aggregated = aggregateSystemMessages(messages);

    expect(aggregated).not.toBe(messages);
    expect(aggregated).toHaveLength(3);
    expect(aggregated[0]).toBe(messages[0]);
    expect(aggregated[2]).toBe(messages[2]);

    const systemMessage = aggregated[1];
    expect(systemMessage.role).toBe(Role.SYSTEM);
    expect(systemMessage.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'second' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'third' }
    ]);
  });

  test('aggregateSystemMessages carries forward system metadata', () => {
    const messages = [
      {
        role: Role.SYSTEM,
        name: 'policy',
        reasoning: { text: 'meta', metadata: { origin: 'test' } },
        content: [{ type: 'text', text: 'first' }]
      },
      {
        role: Role.SYSTEM,
        content: [{ type: 'text', text: 'second' }]
      },
      {
        role: Role.USER,
        content: [{ type: 'text', text: 'user' }]
      }
    ];

    const aggregated = aggregateSystemMessages(messages);

    expect(aggregated[0].role).toBe(Role.SYSTEM);
    expect(aggregated[0].name).toBe('policy');
    expect(aggregated[0].reasoning).toEqual({ text: 'meta', metadata: { origin: 'test' } });
    expect(aggregated[1]).toBe(messages[2]);
  });

  test('aggregateSystemMessages skips separators for empty system content', () => {
    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'first' }] },
      { role: Role.SYSTEM, content: [] },
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'third' }] }
    ];

    const aggregated = aggregateSystemMessages(messages);
    const systemMessage = aggregated[0];

    expect(systemMessage.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'third' }
    ]);
  });

  test('aggregateSystemMessages handles undefined system content', () => {
    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'kept' }] },
      { role: Role.SYSTEM, content: undefined },
      { role: Role.USER, content: [{ type: 'text', text: 'user' }] }
    ];

    const aggregated = aggregateSystemMessages(messages as any);
    expect(aggregated[0].content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(aggregated[1]).toBe(messages[2]);
  });

  test('appendAssistantToolCalls sanitizes names by default and preserves content', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-1',
          name: 'my tool!',
          arguments: { value: 1 }
        }
      ],
      {
        content: [{ type: 'text', text: 'Running tools…' }]
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: 'Running tools…' }],
      toolCalls: [
        {
          id: 'call-1',
          name: 'my_tool_',
          arguments: { value: 1 }
        }
      ]
    });
  });

  test('appendAssistantToolCalls uses custom sanitizer when provided', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-2',
          name: 'MixedCase',
          arguments: {}
        }
      ],
      {
        sanitizeName: name => name.toLowerCase()
      }
    );

    expect(messages[0].toolCalls[0].name).toBe('mixedcase');
  });

  test('appendAssistantToolCalls removes empty text content parts', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-3',
          name: 'echo',
          arguments: {}
        }
      ],
      {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '  ' },
          { type: 'text', text: '\n\n' },
          { type: 'text', text: 'valid' }
        ]
      }
    );

    expect(messages[0].content).toEqual([{ type: 'text', text: 'valid' }]);
  });

  test('appendAssistantToolCalls preserves non-text content', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-4',
          name: 'echo',
          arguments: {}
        }
      ],
      {
        content: [
          { type: 'image', imageUrl: 'https://example.com/image.png' }
        ] as any
      }
    );

    expect(messages[0].content).toEqual([
      { type: 'image', imageUrl: 'https://example.com/image.png' }
    ]);
  });

  test('appendAssistantToolCalls handles missing text values gracefully', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-5',
          name: 'echo',
          arguments: {}
        }
      ],
      {
        content: [
          { type: 'text', text: undefined },
          { type: 'text', text: 'kept' }
        ] as any
      }
    );

    expect(messages[0].content).toEqual([{ type: 'text', text: 'kept' }]);
  });

  test('appendAssistantToolCalls skips append when no tool calls provided', () => {
    const messages: any[] = [{ role: Role.USER, content: [] }];

    appendAssistantToolCalls(messages, []);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe(Role.USER);
  });

  test('appendToolResult appends tool messages with countdown text when provided', () => {
    const messages: any[] = [];

    appendToolResult(
      messages,
      {
        toolName: 'search',
        callId: 'call-42',
        result: { answer: '42' }
      },
      { countdownText: 'Tool calls used 1 of 3 - 2 remaining.' }
    );

    expect(messages).toHaveLength(1);
    const toolMessage = messages[0];
    expect(toolMessage).toMatchObject({
      role: Role.TOOL,
      toolCallId: 'call-42'
    });

    const [textPart, resultPart, countdownPart] = toolMessage.content;
    expect(textPart).toEqual({ type: 'text', text: '{"answer":"42"}' });
    expect(resultPart).toEqual({
      type: 'tool_result',
      toolName: 'search',
      result: { answer: '42' }
    });
    expect(countdownPart).toEqual({
      type: 'text',
      text: 'Tool calls used 1 of 3 - 2 remaining.'
    });
  });

  test('appendToolResult handles string results without countdown', () => {
    const messages: any[] = [];

    appendToolResult(messages, {
      toolName: 'echo',
      callId: 'call-7',
      result: 'plain-text'
    });

    expect(messages).toHaveLength(1);
    const toolMessage = messages[0];
    expect(toolMessage.content).toEqual([
      { type: 'text', text: 'plain-text' },
      { type: 'tool_result', toolName: 'echo', result: 'plain-text' }
    ]);
  });

  test('appendToolResult handles circular and undefined results safely', () => {
    const messages: any[] = [];

    const circular: any = {};
    circular.self = circular;

    expect(() =>
      appendToolResult(messages, {
        toolName: 'circular',
        callId: 'call-circ',
        result: circular
      })
    ).not.toThrow();

    expect(messages[0].content[0]).toEqual({ type: 'text', text: '[object Object]' });

    const messages2: any[] = [];
    expect(() =>
      appendToolResult(messages2, {
        toolName: 'undef',
        callId: 'call-undef',
        result: undefined
      } as any)
    ).not.toThrow();

    expect(messages2[0].content[0]).toEqual({ type: 'text', text: '' });
  });

  test('extractToolResultFromMessage returns null for non-tool messages', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.USER,
      content: [{ type: 'text', text: 'hi' }]
    } as any);

    expect(extracted).toBeNull();
  });

  test('extractToolResultFromMessage extracts from text-only tool messages', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'hello' }]
    } as any);

    expect(extracted).toEqual({
      toolCallId: 'call-1',
      toolName: null,
      toolNames: [],
      result: null,
      results: [],
      text: 'hello'
    });
  });

  test('extractToolResultFromMessage extracts from tool_result-only messages', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-2',
      content: [{ type: 'tool_result', toolName: 'echo', result: 'ok' }]
    } as any);

    expect(extracted).toEqual({
      toolCallId: 'call-2',
      toolName: 'echo',
      toolNames: ['echo'],
      result: 'ok',
      results: ['ok'],
      text: 'ok'
    });
  });

  test('extractToolResultFromMessage joins multi-part tool_result output', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-3',
      content: [
        {
          type: 'tool_result',
          toolName: 'multi',
          result: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
            { type: 'image', imageUrl: 'ignored' }
          ]
        }
      ]
    } as any);

    expect(extracted?.text).toBe('ab');
    expect(extracted?.result).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'image', imageUrl: 'ignored' }
    ]);
  });

  test('extractToolResultFromMessage stringifies non-text tool_result payloads', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-4',
      content: [{ type: 'tool_result', toolName: 'obj', result: { a: 1 } }]
    } as any);

    expect(extracted?.text).toBe('{"a":1}');
  });

  test('extractToolResultFromMessage prefers message text parts when present (e.g., truncation/annotations)', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-5',
      content: [
        { type: 'text', text: 'short' },
        { type: 'tool_result', toolName: 'big', result: { a: 'very long' } },
        { type: 'text', text: ' [truncated]' }
      ]
    } as any);

    expect(extracted?.text).toBe('short [truncated]');
    expect(extracted?.toolName).toBe('big');
  });

  test('extractToolResultFromMessage returns an array result for multiple tool_result parts', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-6',
      content: [
        { type: 'tool_result', toolName: 'multi', result: 'a' },
        { type: 'tool_result', toolName: 'multi', result: 'b' }
      ]
    } as any);

    expect(extracted?.result).toEqual(['a', 'b']);
    expect(extracted?.text).toBe('a\nb');
  });

  test('extractToolResultFromMessage handles undefined and non-serializable payloads safely', () => {
    const extractedUndefined = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-7',
      content: [{ type: 'tool_result', toolName: 'u', result: undefined }]
    } as any);

    expect(extractedUndefined?.text).toBe('');
    expect(extractedUndefined?.results[0]).toBeUndefined();

    const circular: any = {};
    circular.self = circular;
    const extractedCircular = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-8',
      content: [{ type: 'tool_result', toolName: 'c', result: circular }]
    } as any);

    expect(extractedCircular?.text).toBe('[object Object]');
  });

  test('extractToolResultFromMessage stringifies array tool results without text parts', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-9',
      content: [
        {
          type: 'tool_result',
          toolName: 'arr',
          result: [{ type: 'image', imageUrl: 'x' }]
        }
      ]
    } as any);

    expect(extracted?.text).toBe('[{\"type\":\"image\",\"imageUrl\":\"x\"}]');
  });

  test('extractToolResultFromMessage handles missing content and toolCallId', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      content: undefined
    } as any);

    expect(extracted).toEqual({
      toolCallId: null,
      toolName: null,
      toolNames: [],
      result: null,
      results: [],
      text: ''
    });
  });

  test('extractToolResultFromMessage handles text parts with missing text fields', () => {
    const extracted = extractToolResultFromMessage({
      role: Role.TOOL,
      toolCallId: 'call-10',
      content: [{ type: 'text', text: undefined }]
    } as any);

    expect(extracted?.text).toBe('');
    expect(extracted?.toolCallId).toBe('call-10');
  });

  test('appendAssistantToolCalls stores reasoning on new message when provided', () => {
    const messages: any[] = [];
    const reasoning = { text: 'I need to call this tool because...', metadata: { provider: 'openrouter' } };

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-reason-1',
          name: 'search_tool',
          arguments: { query: 'test' }
        }
      ],
      {
        content: [{ type: 'text', text: 'Searching...' }],
        reasoning
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toEqual(reasoning);
    expect(messages[0].role).toBe(Role.ASSISTANT);
    expect(messages[0].toolCalls).toHaveLength(1);
  });

  test('appendAssistantToolCalls does not add reasoning field when undefined', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-no-reason',
          name: 'simple_tool',
          arguments: {}
        }
      ],
      {
        content: []
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty('reasoning');
  });

  test('appendAssistantToolCalls updates reasoning on existing duplicate message', () => {
    const existingReasoning = { text: 'original reasoning' };
    const messages: any[] = [
      {
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-dup',
            name: 'dup_tool',
            arguments: { x: 1 }
          }
        ],
        reasoning: existingReasoning
      }
    ];

    const newReasoning = { text: 'updated reasoning', metadata: { updated: true } };

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-dup',
          name: 'dup_tool',
          arguments: { x: 1 }
        }
      ],
      {
        content: [{ type: 'text', text: 'new content' }],
        reasoning: newReasoning
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toEqual(newReasoning);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'new content' }]);
  });

  test('appendAssistantToolCalls preserves existing reasoning when new reasoning is undefined', () => {
    const existingReasoning = { text: 'should be preserved' };
    const messages: any[] = [
      {
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [
          {
            id: 'call-preserve',
            name: 'preserve_tool',
            arguments: {}
          }
        ],
        reasoning: existingReasoning
      }
    ];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-preserve',
          name: 'preserve_tool',
          arguments: {}
        }
      ],
      {
        content: [{ type: 'text', text: 'updated content' }]
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toEqual(existingReasoning);
  });

  test('appendAssistantToolCalls handles reasoning with redacted flag', () => {
    const messages: any[] = [];
    const reasoning = { text: '[redacted]', redacted: true };

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-redact',
          name: 'redact_tool',
          arguments: {}
        }
      ],
      {
        reasoning
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toEqual(reasoning);
    expect(messages[0].reasoning.redacted).toBe(true);
  });

  // Issue #78: Tool call metadata preservation (for thoughtSignature)
  test('appendAssistantToolCalls preserves metadata on tool calls', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-with-metadata',
          name: 'tool_with_signature',
          arguments: { param: 'value' },
          metadata: { thoughtSignature: 'EpwCCpkCAXLI2nwMdJvMR...' }
        }
      ],
      {
        content: []
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls[0].metadata).toBeDefined();
    expect(messages[0].toolCalls[0].metadata.thoughtSignature).toBe('EpwCCpkCAXLI2nwMdJvMR...');
  });

  test('appendAssistantToolCalls preserves metadata on multiple tool calls', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-1',
          name: 'tool1',
          arguments: { a: 1 },
          metadata: { thoughtSignature: 'signature_1...' }
        },
        {
          id: 'call-2',
          name: 'tool2',
          arguments: { b: 2 },
          metadata: { thoughtSignature: 'signature_2...' }
        }
      ],
      {
        content: []
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls).toHaveLength(2);
    expect(messages[0].toolCalls[0].metadata.thoughtSignature).toBe('signature_1...');
    expect(messages[0].toolCalls[1].metadata.thoughtSignature).toBe('signature_2...');
  });

  test('appendAssistantToolCalls handles tool calls without metadata', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-no-metadata',
          name: 'simple_tool',
          arguments: {}
        }
      ],
      {
        content: []
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls[0].metadata).toBeUndefined();
  });

  test('appendAssistantToolCalls preserves metadata alongside reasoning', () => {
    const messages: any[] = [];
    const reasoning = {
      text: 'My reasoning...',
      metadata: { rawDetails: [{ type: 'reasoning.encrypted', data: 'encrypted...' }] }
    };

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-both',
          name: 'tool_both',
          arguments: { x: 1 },
          metadata: { thoughtSignature: 'tool_signature...' }
        }
      ],
      {
        content: [],
        reasoning
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toEqual(reasoning);
    expect(messages[0].toolCalls[0].metadata.thoughtSignature).toBe('tool_signature...');
  });
});
