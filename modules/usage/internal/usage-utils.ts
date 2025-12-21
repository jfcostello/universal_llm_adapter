import type { UsageStats, JsonObject } from '../../kernel/index.js';
import { getPromptTokensIncludeCached, setPromptTokensIncludeCached } from './usage-extractor.js';

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

export function stripNullUsageStats(usage: UsageStats | undefined): UsageStats | undefined {
  if (!usage) return usage;

  const cleaned: UsageStats = {};
  const fields: Array<keyof UsageStats> = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'reasoningTokens',
    'cost',
    'cachedTokens',
    'audioTokens'
  ];

  for (const field of fields) {
    const value = usage[field];
    if (value !== null && value !== undefined) {
      cleaned[field] = value;
    }
  }

  const promptTokensIncludeCached = getPromptTokensIncludeCached(usage);
  if (typeof promptTokensIncludeCached === 'boolean') {
    setPromptTokensIncludeCached(cleaned, promptTokensIncludeCached);
  }

  return cleaned;
}
