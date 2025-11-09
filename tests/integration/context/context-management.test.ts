import { pruneToolResults, pruneReasoning } from '@/utils/context/context-manager.ts';
import { Message, Role } from '@/core/types.ts';
import { estimateMessageTokens, calculateConversationTokens, trimConversationToBudget } from '@/utils/context/context-manager.ts';

describe('integration/context/context-management', () => {
  function buildToolCycle(id: number, reasoning?: string): Message[] {
    const assistant: Message = {
      role: Role.ASSISTANT,
      content: [{ type: 'text', text: `tool call ${id}` }],
      toolCalls: [
        {
          id: `call-${id}`,
          name: `tool${id}`,
          arguments: {}
        }
      ],
      reasoning: reasoning ? { text: reasoning } : undefined
    };

    const tool: Message = {
      role: Role.TOOL,
      content: [{ type: 'text', text: `result-${id}` }],
      toolCallId: `call-${id}`
    };

    return [assistant, tool];
  }

  test('pruneToolResults keeps only the most recent cycles', () => {
    const messages: Message[] = [
      { role: Role.USER, content: [{ type: 'text', text: 'start' }] },
      ...buildToolCycle(1),
      ...buildToolCycle(2),
      ...buildToolCycle(3)
    ];

    pruneToolResults(messages, 1);

    const toolMessages = messages.filter(msg => msg.role === Role.TOOL);
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages.map(msg => msg.toolCallId)).toEqual(['call-1', 'call-2', 'call-3']);

    const redacted = toolMessages.slice(0, 2);
    const preserved = toolMessages[2];

    redacted.forEach(msg => {
      expect(msg.content[0]).toEqual({
        type: 'text',
        text: expect.stringContaining('placeholder')
      });
    });
    expect(preserved.content[0].text).toBe('result-3');
  });

  test('pruneReasoning redacts older reasoning while preserving latest blocks', () => {
    const messages: Message[] = [
      { role: Role.USER, content: [{ type: 'text', text: 'question' }] },
      ...buildToolCycle(1, 'first reasoning'),
      ...buildToolCycle(2, 'second reasoning'),
      ...buildToolCycle(3, 'third reasoning')
    ];

    pruneReasoning(messages, 1);

    const assistantMessages = messages.filter(msg => msg.role === Role.ASSISTANT);
    const redacted = assistantMessages.slice(0, -1);
    const preserved = assistantMessages.at(-1)!;

    redacted.forEach(msg => {
      expect(msg.reasoning?.redacted).toBe(true);
    });
    expect(preserved.reasoning?.text).toBe('third reasoning');
    expect(preserved.reasoning?.redacted).toBeUndefined();
  });

  test('estimateMessageTokens counts text, reasoning, and tool calls', () => {
    const message: Message = {
      role: Role.ASSISTANT,
      content: [
        { type: 'text', text: 'Hello world!' },
        { type: 'tool_result', toolName: 'calc', result: { value: 42 } }
      ],
      toolCalls: [
        { id: 'tool-1', name: 'calc', arguments: { value: 42 } }
      ],
      reasoning: { text: 'Thinking through the problem.' }
    };

    const tokens = estimateMessageTokens(message);
    expect(tokens).toBeGreaterThan(0);
  });

  test('calculateConversationTokens sums individual message estimates', () => {
    const messages: Message[] = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'User question' }] }
    ];

    const total = calculateConversationTokens(messages);
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(estimateMessageTokens(messages[0]) + estimateMessageTokens(messages[1]));
  });

  test('trimConversationToBudget removes lowest priority messages first', () => {
    const messages: Message[] = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'High priority' }], metadata: { priority: -1 } },
      { role: Role.ASSISTANT, content: [{ type: 'text', text: 'Verbose explanation'.repeat(50) }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Follow-up question'.repeat(40) }] }
    ];

    const trimmed = trimConversationToBudget(messages, 200);
    expect(trimmed.some(msg => msg.role === Role.SYSTEM)).toBe(true);
    expect(trimmed.some(msg => msg.metadata?.priority === -1)).toBe(true);
    expect(trimmed.length).toBeLessThan(messages.length);
  });

  test('trimConversationToBudget accounts for image token sizing', () => {
    const messages: Message[] = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      {
        role: Role.USER,
        content: [
          { type: 'image', imageUrl: 'https://example.com/image.png' },
          { type: 'text', text: 'Describe this image' }
        ]
      },
      { role: Role.ASSISTANT, content: [{ type: 'text', text: 'Lengthy answer'.repeat(100) }] }
    ];

    const trimmed = trimConversationToBudget(messages, 500, { preserveRoles: [Role.USER] });
    expect(trimmed.some(msg => msg.role === Role.USER)).toBe(true);
    expect(trimmed.some(msg => msg.role === Role.ASSISTANT)).toBe(false);
  });

  test('trimConversationToBudget leaves history unchanged when within budget', () => {
    const messages: Message[] = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Short question' }] }
    ];

    const trimmed = trimConversationToBudget(messages, 1000);
    expect(trimmed).toHaveLength(messages.length);
    expect(trimmed[0].content[0]).toEqual({ type: 'text', text: 'System' });
  });

  test('trimConversationToBudget removes tool messages before assistant content', () => {
    const messages: Message[] = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      {
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'Assistant response'.repeat(80) }]
      },
      {
        role: Role.TOOL,
        content: [{ type: 'text', text: 'Tool output'.repeat(40) }],
        toolCallId: 'call-1'
      }
    ];

    const trimmed = trimConversationToBudget(messages, 400, { preserveSystem: false });
    expect(trimmed.some(msg => msg.role === Role.TOOL)).toBe(false);
    expect(trimmed.some(msg => msg.role === Role.ASSISTANT)).toBe(true);
  });

  test('trimConversationToBudget assigns default priority to unknown roles', () => {
    const messages: Message[] = [
      { role: Role.SYSTEM, content: [{ type: 'text', text: 'System' }] },
      { role: 'custom-role' as Role, content: [{ type: 'text', text: 'Custom content'.repeat(60) }] },
      { role: Role.USER, content: [{ type: 'text', text: 'Question' }] }
    ];

    const trimmed = trimConversationToBudget(messages, 200, { preserveSystem: false });
    expect(trimmed.some(msg => msg.role === ('custom-role' as Role))).toBe(false);
    expect(trimmed.some(msg => msg.role === Role.USER)).toBe(true);
  });

  test('estimateMessageTokens handles missing text and tool result payloads', () => {
    const message: Message = {
      role: Role.ASSISTANT,
      content: [
        { type: 'text' },
        { type: 'tool_result', toolName: 'test-tool' }
      ],
      toolCalls: [{ id: 't', name: 'test-tool', arguments: undefined }]
    } as any;

    expect(() => estimateMessageTokens(message)).not.toThrow();
  });

  test('estimateMessageTokens falls back when content is undefined', () => {
    const message: Message = {
      role: Role.ASSISTANT,
      toolCalls: []
    } as any;

    expect(estimateMessageTokens(message)).toBeGreaterThanOrEqual(0);
  });
});
