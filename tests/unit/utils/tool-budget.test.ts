import { ToolCallBudget } from '@/utils/tools/tool-budget.ts';
import { formatCountdown, buildFinalPrompt } from '@/utils/tools/tool-message.ts';

describe('utils/tools/tool-budget', () => {
  test('consumes with finite budget and reports remaining', () => {
    const budget = new ToolCallBudget(2);
    expect(budget.remaining).toBe(2);
    expect(budget.consume()).toBe(true);
    expect(budget.remaining).toBe(1);
    expect(budget.exhausted).toBe(false);
    expect(budget.consume()).toBe(true);
    expect(budget.exhausted).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.remaining).toBe(0);
    budget.usedCalls = 5;
    expect(budget.remaining).toBe(0);
    expect(formatCountdown(budget)).toBe('Tool calls used 5 of 2 - 0 remaining.');
    expect(buildFinalPrompt(budget)).toContain('All tool calls have been consumed');
  });

  test('supports unlimited budget and validates inputs', () => {
    const budget = new ToolCallBudget(null);
    expect(budget.consume(2)).toBe(true);
    expect(budget.remaining).toBeNull();
    expect(budget.exhausted).toBe(false);
    expect(formatCountdown(budget)).toBeNull();
    expect(() => buildFinalPrompt(budget)).toThrow('Final prompt requested');
    expect(() => budget.consume(0)).toThrow('amount must be positive');
    expect(() => new ToolCallBudget(-1)).toThrow('maxCalls cannot be negative');
  });
});
