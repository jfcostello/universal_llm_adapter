import { UsageStats } from '../../core/types.js';

export function usageStatsToJson(
  usage: UsageStats
): { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; reasoningTokens: number | null } {
  return {
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null
  };
}
