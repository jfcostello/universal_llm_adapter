import { describe, expect, test } from '@jest/globals';
import { Role } from '@/modules/kernel/index.ts';
import { filterContentForObservability, filterMessagesForObservability } from '@/modules/llm/internal/observability-capture.ts';

describe('modules/llm/internal/observability-capture', () => {
  test('filterMessagesForObservability: full returns original messages array', () => {
    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    expect(filterMessagesForObservability(messages as any, 'full')).toBe(messages as any);
  });

  test('filterMessagesForObservability: none returns empty array', () => {
    const messages: any[] = [{ role: Role.USER, content: [{ type: 'text', text: 'hi' }] }];
    expect(filterMessagesForObservability(messages as any, 'none')).toEqual([]);
  });

  test('filterMessagesForObservability: text keeps only text parts and drops empty messages', () => {
    const messages: any[] = [
      {
        role: Role.USER,
        content: [
          null,
          'not-an-object',
          { type: 'not_text', text: 'nope' },
          { type: 'text', text: 123 },
          { type: 'text', text: 'keep' },
          { type: 'tool_result', data: { big: 'blob' } }
        ]
      },
      { role: Role.ASSISTANT, content: [{ type: 'tool_result', data: 'no text' }] },
      { role: Role.SYSTEM, content: 'not-an-array' }
    ];

    expect(filterMessagesForObservability(messages as any, 'text')).toEqual([
      { role: Role.USER, content: [{ type: 'text', text: 'keep' }] }
    ]);
  });

  test('filterContentForObservability: full returns original content array', () => {
    const content: any[] = [{ type: 'text', text: 'hi' }];
    expect(filterContentForObservability(content as any, 'full')).toBe(content as any);
  });

  test('filterContentForObservability: none returns empty array', () => {
    const content: any[] = [{ type: 'text', text: 'hi' }];
    expect(filterContentForObservability(content as any, 'none')).toEqual([]);
  });

  test('filterContentForObservability: text keeps only valid text parts', () => {
    const content: any = [
      null,
      'not-an-object',
      { type: 'not_text', text: 'nope' },
      { type: 'text', text: 123 },
      { type: 'text', text: 'keep' }
    ];

    expect(filterContentForObservability(content, 'text')).toEqual([{ type: 'text', text: 'keep' }]);
    expect(filterContentForObservability(null as any, 'text')).toEqual([]);
  });
});

