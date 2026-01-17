export type ToolCallRunMetadata = { threadId: string; runId: string };

export const TOOL_BUDGET_FINAL_PROMPT_PREFIX = 'All tool calls have been consumed (';

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

