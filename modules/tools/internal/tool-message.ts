import { ToolCallBudget } from './tool-budget.js';

export function formatCountdown(budget: ToolCallBudget): string | null {
  if (budget.maxCalls === null) return null;

  const remaining = budget.remaining || 0;
  return `Tool calls used ${budget.usedCalls} of ${budget.maxCalls} - ${remaining} remaining.`;
}

export function buildFinalPrompt(budget: ToolCallBudget): string {
  if (budget.maxCalls === null) {
    throw new Error('Final prompt requested without a finite tool call budget');
  }

  return `All tool calls have been consumed (${budget.usedCalls} of ${budget.maxCalls}). ` +
    'Provide your final response using the information gathered so far.';
}

