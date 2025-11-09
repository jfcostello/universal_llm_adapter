import { prepareMessages, appendAssistantToolCalls, appendToolResult } from '@/utils/messages/message-utils.ts';
import { Role } from '@/core/types.ts';
import { trimConversationToBudget } from '@/utils/context/context-manager.ts';

describe('integration/messages/message-processing', () => {
  test('prepareMessages normalizes system prompt and preserves existing history', () => {
    const spec: any = {
      systemPrompt: 'You are system.',
      messages: [
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'Hello' }]
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Hi there' }]
        }
      ]
    };

    const prepared = prepareMessages(spec);
    expect(prepared[0]).toEqual({
      role: Role.SYSTEM,
      content: [{ type: 'text', text: 'You are system.' }]
    });
    expect(prepared[1].role).toBe(Role.USER);
    expect(prepared[2].role).toBe(Role.ASSISTANT);
  });

  test('appendAssistantToolCalls merges tool metadata and trims empty content', () => {
    const messages: any[] = [];
    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'call-1',
          name: 'dirty/name',
          arguments: { foo: 'bar' }
        }
      ],
      {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '  ' },
          { type: 'text', text: 'Ready to invoke' }
        ]
      }
    );

    expect(messages).toHaveLength(1);
    const assistantMsg = messages[0];
    expect(assistantMsg.role).toBe(Role.ASSISTANT);
    expect(assistantMsg.content).toEqual([{ type: 'text', text: 'Ready to invoke' }]);
    expect(assistantMsg.toolCalls[0]).toMatchObject({
      id: 'call-1',
      name: 'dirty_name'
    });
  });

  test('appendAssistantToolCalls deduplicates identical tool calls', () => {
    const messages: any[] = [];

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'dup-1',
          name: 'dup.tool',
          arguments: { payload: 'v1' }
        }
      ]
    );

    appendAssistantToolCalls(
      messages,
      [
        {
          id: 'dup-1',
          name: 'dup.tool',
          arguments: { payload: 'v1' }
        }
      ],
      {
        content: [{ type: 'text', text: 'Updated content' }]
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].content[0]).toEqual({ type: 'text', text: 'Updated content' });
  });

  test('appendToolResult appends structured payload with countdown text', () => {
    const messages: any[] = [];

    appendToolResult(
      messages,
      {
        toolName: 'demo.tool',
        callId: 'call-42',
        result: { answer: 42 }
      },
      {
        countdownText: '2 tool calls remaining'
      }
    );

    expect(messages).toHaveLength(1);
    const toolMessage = messages[0];
    expect(toolMessage.role).toBe(Role.TOOL);
    expect(toolMessage.toolCallId).toBe('call-42');
    expect(toolMessage.content[0]).toEqual({ type: 'text', text: '{"answer":42}' });
    expect(toolMessage.content[1]).toMatchObject({
      type: 'tool_result',
      toolName: 'demo.tool',
      result: { answer: 42 }
    });
    expect(toolMessage.content[2]).toEqual({
      type: 'text',
      text: '2 tool calls remaining'
    });
  });

  test('appendToolResult truncates long text payloads when maxLength provided', () => {
    const messages: any[] = [];

    appendToolResult(
      messages,
      {
        toolName: 'large.tool',
        callId: 'call-large',
        result: { data: 'A'.repeat(40) }
      },
      {
        maxLength: 10
      }
    );

    const toolMessage = messages[0];
    const textEntries = toolMessage.content.filter((part: any) => part.type === 'text');
    expect(textEntries.some((part: any) => part.text.endsWith('…'))).toBe(true);
    expect(textEntries.some((part: any) => /truncated/i.test(part.text))).toBe(true);
  });

  test('appendToolResult leaves string payload unmodified when no maxLength', () => {
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

  test('prepareMessages keeps image content intact', () => {
    const spec: any = {
      systemPrompt: 'System',
      messages: [
        {
          role: Role.USER,
          content: [
            { type: 'image', imageUrl: 'https://example.com/cat.png' },
            { type: 'text', text: 'describe the cat' }
          ]
        }
      ]
    };

    const prepared = prepareMessages(spec);
    const userMessage = prepared.find(msg => msg.role === Role.USER)!;
    expect(userMessage.content[0]).toEqual({ type: 'image', imageUrl: 'https://example.com/cat.png' });
  });

  test('message history truncation respects priority hints', () => {
    const messages = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'sys' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'high priority' }], metadata: { priority: -5 } },
      { role: Role.ASSISTANT, content: [{ type: 'text', text: 'very long answer'.repeat(200) }] },
      { role: Role.USER, content: [{ type: 'text', text: 'follow-up'.repeat(150) }] }
    ] as any;

    const trimmed = trimConversationToBudget(messages, 400, { preserveRoles: [Role.USER] });
    expect(trimmed.some(msg => msg.role === Role.SYSTEM)).toBe(true);
    expect(trimmed.some(msg => msg.role === Role.ASSISTANT)).toBe(false);
  });
});
