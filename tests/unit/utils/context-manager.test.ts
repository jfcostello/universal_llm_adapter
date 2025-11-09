import {
  pruneToolResults,
  pruneReasoning,
  TOOL_REDACTION_PLACEHOLDER,
  TOOL_REDACTION_REASON
} from '@/utils/context/context-manager.ts';
import { Message, Role, TextContent, ToolResultContent } from '@/core/types.ts';

const isRedactedToolMessage = (message: Message): boolean => {
  if (message.role !== Role.TOOL) {
    return false;
  }

  return message.content.some(
    part =>
      part.type === 'tool_result' &&
      typeof part.result === 'object' &&
      part.result !== null &&
      'redacted' in part.result &&
      (part.result as any).redacted === true &&
      (part.result as any).reason === TOOL_REDACTION_REASON
  );
};

describe('pruneToolResults', () => {
  describe('preserve all behavior', () => {
    test('preserves all tool results when set to "all"', () => {
      const messages: Message[] = [
        { role: Role.USER, content: [{ type: 'text', text: 'request' }] },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-2', name: 'tool2', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2' }],
          toolCallId: 'call-2'
        }
      ];

      const originalLength = messages.length;
      pruneToolResults(messages, 'all');

      expect(messages).toHaveLength(originalLength);
      expect(messages.filter(m => m.role === Role.TOOL)).toHaveLength(2);
    });
  });

  describe('preserve none behavior', () => {
    test('removes all tool results when set to "none"', () => {
      const messages: Message[] = [
        { role: Role.USER, content: [{ type: 'text', text: 'request' }] },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-2', name: 'tool2', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2' }],
          toolCallId: 'call-2'
        }
      ];

      pruneToolResults(messages, 'none');

      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages.every(isRedactedToolMessage)).toBe(true);
      expect(toolMessages.every(m => m.content[0]?.type === 'text' && m.content[0]?.text === TOOL_REDACTION_PLACEHOLDER)).toBe(true);
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(2);
      expect(messages.filter(m => m.role === Role.USER)).toHaveLength(1);
    });

    test('preserves assistant and user messages when removing all tool results', () => {
      const messages: Message[] = [
        { role: Role.USER, content: [{ type: 'text', text: 'request' }] },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'calling tool' }],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        }
      ];

      pruneToolResults(messages, 'none');

      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe(Role.USER);
      expect(messages[1].role).toBe(Role.ASSISTANT);
      expect(messages[2].role).toBe(Role.TOOL);
      expect(isRedactedToolMessage(messages[2])).toBe(true);
      expect(messages[2].content[0]).toEqual({ type: 'text', text: TOOL_REDACTION_PLACEHOLDER });
    });
  });

  describe('preserve last N cycles', () => {
    test('handles preserving more cycles than exist (no removal needed)', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        }
      ];

      // Preserve 10 cycles when only 1 exists - should keep everything
      pruneToolResults(messages, 10);

      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(1);
      expect(isRedactedToolMessage(toolMessages[0])).toBe(false);
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(1);
    });

    test('uses default value of "all" when preserve count not specified', () => {
      const messages: Message[] = [];

      // Create 5 cycles
      for (let i = 1; i <= 5; i++) {
        messages.push({
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: `call-${i}`, name: `tool${i}`, arguments: {} }]
        });
        messages.push({
          role: Role.TOOL,
          content: [{ type: 'text', text: `result${i}` }],
          toolCallId: `call-${i}`
        });
      }

      // Call without second parameter to test default value
      pruneToolResults(messages);

      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(5);

      // Default is 'all' - no redaction should occur
      const redacted = toolMessages.filter(isRedactedToolMessage);
      const preserved = toolMessages.filter(m => !isRedactedToolMessage(m));

      expect(redacted).toHaveLength(0);
      expect(preserved.map(m => m.toolCallId)).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5']);

      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(5);
    });

    test('preserves last 3 cycles by default', () => {
      const messages: Message[] = [];

      // Create 5 cycles
      for (let i = 1; i <= 5; i++) {
        messages.push({
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: `call-${i}`, name: `tool${i}`, arguments: {} }]
        });
        messages.push({
          role: Role.TOOL,
          content: [{ type: 'text', text: `result${i}` }],
          toolCallId: `call-${i}`
        });
      }

      pruneToolResults(messages, 3);

      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(5);
      expect(toolMessages.filter(isRedactedToolMessage).map(m => m.toolCallId)).toEqual(['call-1', 'call-2']);
      expect(toolMessages.filter(m => !isRedactedToolMessage(m)).map(m => m.toolCallId)).toEqual([
        'call-3',
        'call-4',
        'call-5'
      ]);

      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(5);
    });

    test('preserves last 1 cycle', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-2', name: 'tool2', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2' }],
          toolCallId: 'call-2'
        }
      ];

      pruneToolResults(messages, 1);

      const toolResults = messages.filter(m => m.role === Role.TOOL);
      expect(toolResults).toHaveLength(2);
      expect(isRedactedToolMessage(toolResults[0])).toBe(true);
      expect(toolResults[0].toolCallId).toBe('call-1');
      expect(isRedactedToolMessage(toolResults[1])).toBe(false);
      expect(toolResults[1].toolCallId).toBe('call-2');
    });

    test('preserves last 5 cycles when only 3 exist', () => {
      const messages: Message[] = [];

      // Create 3 cycles
      for (let i = 1; i <= 3; i++) {
        messages.push({
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: `call-${i}`, name: `tool${i}`, arguments: {} }]
        });
        messages.push({
          role: Role.TOOL,
          content: [{ type: 'text', text: `result${i}` }],
          toolCallId: `call-${i}`
        });
      }

      pruneToolResults(messages, 5);

      // Should keep all 3 cycles since we requested 5 but only have 3
      expect(messages.filter(isRedactedToolMessage)).toHaveLength(0);
      expect(messages.filter(m => m.role === Role.TOOL)).toHaveLength(3);
    });

    test('preserves exactly N cycles when N cycles exist', () => {
      const messages: Message[] = [];

      // Create exactly 3 cycles
      for (let i = 1; i <= 3; i++) {
        messages.push({
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: `call-${i}`, name: `tool${i}`, arguments: {} }]
        });
        messages.push({
          role: Role.TOOL,
          content: [{ type: 'text', text: `result${i}` }],
          toolCallId: `call-${i}`
        });
      }

      pruneToolResults(messages, 3);

      // Should keep all 3 cycles since we requested exactly 3
      expect(messages.filter(isRedactedToolMessage)).toHaveLength(0);
      expect(messages.filter(m => m.role === Role.TOOL)).toHaveLength(3);
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(3);
    });
  });

  describe('multi-turn scenarios', () => {
    test('handles multiple tool calls in one turn', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [
            { id: 'call-1a', name: 'tool1', arguments: {} },
            { id: 'call-1b', name: 'tool2', arguments: {} }
          ]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1a' }],
          toolCallId: 'call-1a'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1b' }],
          toolCallId: 'call-1b'
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [
            { id: 'call-2a', name: 'tool3', arguments: {} },
            { id: 'call-2b', name: 'tool4', arguments: {} }
          ]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2a' }],
          toolCallId: 'call-2a'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2b' }],
          toolCallId: 'call-2b'
        }
      ];

      pruneToolResults(messages, 1);

      // First cycle should be redacted, last cycle preserved
      const redacted = messages.filter(isRedactedToolMessage);
      expect(redacted.map(m => m.toolCallId)).toEqual(['call-1a', 'call-1b']);

      const preserved = messages.filter(
        m => m.role === Role.TOOL && !isRedactedToolMessage(m)
      );
      expect(preserved.map(m => m.toolCallId)).toEqual(['call-2a', 'call-2b']);
    });

    test('handles interleaved user messages', () => {
      const messages: Message[] = [
        { role: Role.USER, content: [{ type: 'text', text: 'first request' }] },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        },
        { role: Role.USER, content: [{ type: 'text', text: 'second request' }] },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-2', name: 'tool2', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2' }],
          toolCallId: 'call-2'
        }
      ];

      pruneToolResults(messages, 1);

      expect(messages.filter(m => m.role === Role.USER)).toHaveLength(2);
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(2);
      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(2);
      expect(isRedactedToolMessage(toolMessages[0])).toBe(true);
      expect(toolMessages[0].toolCallId).toBe('call-1');
      expect(isRedactedToolMessage(toolMessages[1])).toBe(false);
      expect(toolMessages[1].toolCallId).toBe('call-2');
    });
  });

  describe('edge cases', () => {
    test('handles empty message array', () => {
      const messages: Message[] = [];
      pruneToolResults(messages, 3);
      expect(messages).toHaveLength(0);
    });

    test('handles messages with no tool calls', () => {
      const messages: Message[] = [
        { role: Role.USER, content: [{ type: 'text', text: 'request' }] },
        { role: Role.ASSISTANT, content: [{ type: 'text', text: 'response' }] }
      ];

      pruneToolResults(messages, 3);

      expect(messages).toHaveLength(2);
    });

    test('handles assistant message without tool results', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'no tools here' }]
        }
      ];

      pruneToolResults(messages, 1);

      expect(messages).toHaveLength(2);
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(2);
    });

    test('handles assistant message with empty toolCalls array', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: []  // Empty array - no tool calls made
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        }
      ];

      pruneToolResults(messages, 1);

      // Should keep the one real cycle, ignore the empty toolCalls array
      expect(messages).toHaveLength(3);
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(2);
      expect(messages.filter(m => m.role === Role.TOOL)).toHaveLength(1);
    });

    test('never removes system messages', () => {
      const messages: Message[] = [
        { role: Role.SYSTEM, content: [{ type: 'text', text: 'system prompt' }] },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        }
      ];

      pruneToolResults(messages, 'none');

      expect(messages.filter(m => m.role === Role.SYSTEM)).toHaveLength(1);
      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(1);
      expect(isRedactedToolMessage(toolMessages[0])).toBe(true);
    });

    test('handles tool results with complex content', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [
            { type: 'text', text: JSON.stringify({ complex: 'data' }) } as TextContent,
            {
              type: 'tool_result',
              toolName: 'tool1',
              result: { complex: 'data' }
            } as ToolResultContent
          ],
          toolCallId: 'call-1'
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-2', name: 'tool2', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [
            { type: 'text', text: JSON.stringify({ more: 'data' }) } as TextContent,
            {
              type: 'tool_result',
              toolName: 'tool2',
              result: { more: 'data' }
            } as ToolResultContent
          ],
          toolCallId: 'call-2'
        }
      ];

      pruneToolResults(messages, 1);

      const toolResults = messages.filter(m => m.role === Role.TOOL);
      expect(toolResults).toHaveLength(2);

      const redacted = toolResults.filter(isRedactedToolMessage);
      expect(redacted).toHaveLength(1);
      expect(redacted[0].toolCallId).toBe('call-1');
      expect(redacted[0].content[0]).toEqual({ type: 'text', text: TOOL_REDACTION_PLACEHOLDER });

      const preserved = toolResults.filter(m => !isRedactedToolMessage(m));
      expect(preserved).toHaveLength(1);
      expect(preserved[0].toolCallId).toBe('call-2');
    });

    test('handles zero preserve count', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        }
      ];

      pruneToolResults(messages, 0);

      // Zero should redact all tool results (same as 'none')
      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(1);
      expect(isRedactedToolMessage(toolMessages[0])).toBe(true);
    });

    test('skips inconsistent non-tool message gracefully', () => {
      const assistantMessage: Message = {
        role: Role.ASSISTANT,
        content: [],
        toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
      };

      const toolMessage: Message = {
        role: Role.TOOL,
        content: [{ type: 'text', text: 'result1' }],
        toolCallId: 'call-1'
      };

      let reads = 0;
      Object.defineProperty(toolMessage, 'role', {
        get: () => {
          const value = reads === 0 ? Role.TOOL : Role.USER;
          reads += 1;
          return value;
        }
      });

      const messages: Message[] = [assistantMessage, toolMessage];
      pruneToolResults(messages, 0);

      expect((messages[1].content[0] as TextContent).text).toBe('result1');
      expect(reads).toBeGreaterThanOrEqual(2);
    });

    test('ignores already redacted tool content on subsequent runs', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        }
      ];

      pruneToolResults(messages, 0);
      const firstPassText = (messages[1].content[0] as TextContent).text;
      pruneToolResults(messages, 0);

      expect(firstPassText).toBe(TOOL_REDACTION_PLACEHOLDER);
      expect((messages[1].content[0] as TextContent).text).toBe(TOOL_REDACTION_PLACEHOLDER);
    });

    test('handles orphaned tool result messages (mismatched toolCallId)', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'orphaned' }],
          toolCallId: 'call-999'  // Doesn't match any toolCall
        },
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-2', name: 'tool2', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2' }],
          toolCallId: 'call-2'
        }
      ];

      pruneToolResults(messages, 1);

      // Should keep last cycle (call-2) and not crash on orphaned tool result
      const toolResults = messages.filter(m => m.role === Role.TOOL);
      expect(toolResults).toHaveLength(3);

      // call-999 is orphaned and won't be counted as part of any cycle, so it stays untouched
      const orphan = toolResults.find(m => m.toolCallId === 'call-999');
      expect(orphan).toBeDefined();
      expect(isRedactedToolMessage(orphan!)).toBe(false);

      // Only call-1's result should be redacted
      const redacted = toolResults.filter(isRedactedToolMessage);
      expect(redacted.map(m => m.toolCallId)).toEqual(['call-1']);

      expect(toolResults.find(m => m.toolCallId === 'call-2')).toBeDefined();
    });

    test('handles tool result message without toolCallId', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: 'call-1', name: 'tool1', arguments: {} }]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'malformed - no toolCallId' }]
          // Missing toolCallId property
        } as Message
      ];

      pruneToolResults(messages, 0);

      // Should handle gracefully - only properly formed tool result should be redacted
      const proper = messages.find(m => m.role === Role.TOOL && m.toolCallId === 'call-1');
      expect(proper).toBeDefined();
      expect(isRedactedToolMessage(proper!)).toBe(true);

      const malformed = messages.find(m => m.role === Role.TOOL && !m.toolCallId);
      expect(malformed).toBeDefined();
      expect(isRedactedToolMessage(malformed!)).toBe(false);
    });
  });

  describe('stress test with many cycles', () => {
    test('correctly handles 10 cycles preserving last 3', () => {
      const messages: Message[] = [];

      // Create 10 cycles
      for (let i = 1; i <= 10; i++) {
        messages.push({
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [{ id: `call-${i}`, name: `tool${i}`, arguments: {} }]
        });
        messages.push({
          role: Role.TOOL,
          content: [{ type: 'text', text: `result${i}` }],
          toolCallId: `call-${i}`
        });
      }

      pruneToolResults(messages, 3);

      const toolResults = messages.filter(m => m.role === Role.TOOL);
      expect(toolResults).toHaveLength(10);
      expect(toolResults.filter(isRedactedToolMessage).map(m => m.toolCallId)).toEqual([
        'call-1',
        'call-2',
        'call-3',
        'call-4',
        'call-5',
        'call-6',
        'call-7'
      ]);
      expect(toolResults.filter(m => !isRedactedToolMessage(m)).map(m => m.toolCallId)).toEqual([
        'call-8',
        'call-9',
        'call-10'
      ]);

      // All 10 assistant messages should still exist
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(10);
    });

    test('handles cycle with 5 tool calls (exercises sort thoroughly)', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [],
          toolCalls: [
            { id: 'call-1', name: 'tool1', arguments: {} },
            { id: 'call-2', name: 'tool2', arguments: {} },
            { id: 'call-3', name: 'tool3', arguments: {} },
            { id: 'call-4', name: 'tool4', arguments: {} },
            { id: 'call-5', name: 'tool5', arguments: {} }
          ]
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result1' }],
          toolCallId: 'call-1'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result2' }],
          toolCallId: 'call-2'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result3' }],
          toolCallId: 'call-3'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result4' }],
          toolCallId: 'call-4'
        },
        {
          role: Role.TOOL,
          content: [{ type: 'text', text: 'result5' }],
          toolCallId: 'call-5'
        }
      ];

      pruneToolResults(messages, 'none');

      // Should redact all 5 tool results (exercises sort with 5 items)
      const toolMessages = messages.filter(m => m.role === Role.TOOL);
      expect(toolMessages).toHaveLength(5);
      expect(toolMessages.every(isRedactedToolMessage)).toBe(true);
      expect(messages.filter(m => m.role === Role.ASSISTANT)).toHaveLength(1);
    });
  });
});

describe('pruneReasoning', () => {
  describe('preserve all behavior', () => {
    test('preserves all reasoning when set to "all"', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'First response' }],
          reasoning: { text: 'First reasoning...' }
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Second response' }],
          reasoning: { text: 'Second reasoning...' }
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Third response' }],
          reasoning: { text: 'Third reasoning...' }
        }
      ];

      pruneReasoning(messages, 'all');

      expect(messages.every(m => m.reasoning && !m.reasoning.redacted)).toBe(true);
    });
  });

  describe('preserve none behavior', () => {
    test('redacts all reasoning when set to "none"', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'First response' }],
          reasoning: { text: 'First reasoning...' }
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Second response' }],
          reasoning: { text: 'Second reasoning...' }
        }
      ];

      pruneReasoning(messages, 'none');

      expect(messages.every(m => m.reasoning?.redacted === true)).toBe(true);
    });
  });

  describe('preserve last N behavior', () => {
    test('uses default value of "all" when preserve count not specified', () => {
      const messages: Message[] = [];

      // Create 5 assistant messages with reasoning
      for (let i = 1; i <= 5; i++) {
        messages.push({
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: `Response ${i}` }],
          reasoning: { text: `Reasoning ${i}...` }
        });
      }

      pruneReasoning(messages);

      // Default is 'all' - no redaction should occur
      const redacted = messages.filter(m => m.reasoning?.redacted === true);
      const preserved = messages.filter(m => m.reasoning && !m.reasoning.redacted);

      expect(redacted).toHaveLength(0);
      expect(preserved).toHaveLength(5);
    });

    test('preserves last 1 reasoning block', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'First' }],
          reasoning: { text: 'First reasoning...' }
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Second' }],
          reasoning: { text: 'Second reasoning...' }
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Third' }],
          reasoning: { text: 'Third reasoning...' }
        }
      ];

      pruneReasoning(messages, 1);

      expect(messages[0].reasoning?.redacted).toBe(true);
      expect(messages[1].reasoning?.redacted).toBe(true);
      expect(messages[2].reasoning?.redacted).toBe(undefined);
    });

    test('preserves last 3 reasoning blocks', () => {
      const messages: Message[] = [];

      // Create 5 assistant messages with reasoning
      for (let i = 1; i <= 5; i++) {
        messages.push({
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: `Response ${i}` }],
          reasoning: { text: `Reasoning ${i}...` }
        });
      }

      pruneReasoning(messages, 3);

      const redacted = messages.filter(m => m.reasoning?.redacted === true);
      const preserved = messages.filter(m => m.reasoning && !m.reasoning.redacted);

      expect(redacted).toHaveLength(2);
      expect(preserved).toHaveLength(3);
    });

    test('handles preserving more reasoning than exists', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Response' }],
          reasoning: { text: 'Reasoning...' }
        }
      ];

      pruneReasoning(messages, 10);

      expect(messages[0].reasoning?.redacted).toBe(undefined);
    });
  });

  describe('edge cases', () => {
    test('handles empty message array', () => {
      const messages: Message[] = [];
      pruneReasoning(messages, 3);
      expect(messages).toHaveLength(0);
    });

    test('handles messages without reasoning', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'No reasoning here' }]
        }
      ];

      pruneReasoning(messages, 3);

      expect(messages).toHaveLength(1);
      expect(messages[0].reasoning).toBeUndefined();
    });

    test('handles mixed messages (some with reasoning, some without)', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'First' }],
          reasoning: { text: 'First reasoning...' }
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Second - no reasoning' }]
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Third' }],
          reasoning: { text: 'Third reasoning...' }
        }
      ];

      pruneReasoning(messages, 1);

      expect(messages[0].reasoning?.redacted).toBe(true);
      expect(messages[1].reasoning).toBeUndefined();
      expect(messages[2].reasoning?.redacted).toBe(undefined);
    });

    test('handles user and system messages (ignores non-assistant)', () => {
      const messages: Message[] = [
        {
          role: Role.USER,
          content: [{ type: 'text', text: 'User message' }]
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Assistant' }],
          reasoning: { text: 'Reasoning...' }
        },
        {
          role: Role.SYSTEM,
          content: [{ type: 'text', text: 'System' }]
        }
      ];

      pruneReasoning(messages, 0);

      expect(messages[0].role).toBe(Role.USER);
      expect(messages[1].reasoning?.redacted).toBe(true);
      expect(messages[2].role).toBe(Role.SYSTEM);
    });

    test('ignores already redacted reasoning', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'First' }],
          reasoning: { text: 'First reasoning...', redacted: true }
        },
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Second' }],
          reasoning: { text: 'Second reasoning...' }
        }
      ];

      pruneReasoning(messages, 1);

      // First was already redacted, should stay that way
      expect(messages[0].reasoning?.redacted).toBe(true);
      // Second should be preserved (it's the last one)
      expect(messages[1].reasoning?.redacted).toBe(undefined);
    });

    test('handles zero preserve count', () => {
      const messages: Message[] = [
        {
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'Response' }],
          reasoning: { text: 'Reasoning...' }
        }
      ];

      pruneReasoning(messages, 0);

      expect(messages[0].reasoning?.redacted).toBe(true);
    });
  });
});
