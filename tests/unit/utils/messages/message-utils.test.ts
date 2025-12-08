import { describe, expect, test } from '@jest/globals';
import { Role } from '@/core/types.ts';
import {
  aggregateSystemMessages,
  appendAssistantToolCalls,
  appendToolResult,
  prepareMessages
} from '@/utils/messages/message-utils.ts';

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
});
