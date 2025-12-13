import type { UsageStats, JsonObject } from '../../kernel/index.js';

export function usageStatsToJson(usage: UsageStats): JsonObject {
  return {
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    cost: usage.cost ?? null,
    cachedTokens: usage.cachedTokens ?? null,
    audioTokens: usage.audioTokens ?? null
  };
}

