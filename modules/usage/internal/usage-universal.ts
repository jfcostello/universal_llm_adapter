import type { UsageStats } from '../../kernel/index.js';
import type { UsageExtractionSpec } from './usage-extractor.js';
import { extractUsageStats, mergeUsageExtractionSpecs } from './usage-extractor.js';

const COMMON_USAGE_SPEC: UsageExtractionSpec = {
  promptTokens: [
    ['usage', 'prompt_tokens'],
    ['usage', 'promptTokens'],
    ['prompt_tokens'],
    ['promptTokens'],
    ['usage', 'input_tokens'],
    ['usage', 'inputTokens'],
    ['input_tokens'],
    ['inputTokens']
  ],
  completionTokens: [
    ['usage', 'completion_tokens'],
    ['usage', 'completionTokens'],
    ['completion_tokens'],
    ['completionTokens'],
    ['usage', 'output_tokens'],
    ['usage', 'outputTokens'],
    ['output_tokens'],
    ['outputTokens']
  ],
  totalTokens: [
    ['usage', 'total_tokens'],
    ['usage', 'totalTokens'],
    ['total_tokens'],
    ['totalTokens']
  ],
  reasoningTokens: [
    ['usage', 'reasoning_tokens'],
    ['reasoning_tokens'],
    ['reasoningTokens']
  ],
  cost: [
    ['usage', 'cost'],
    ['cost']
  ],
  cachedTokens: [
    ['usage', 'cached_tokens'],
    ['cached_tokens'],
    ['cachedTokens']
  ],
  audioTokens: [
    ['usage', 'audio_tokens'],
    ['audio_tokens'],
    ['audioTokens']
  ]
};

export function extractUniversalUsageStats(
  raw: unknown,
  spec?: UsageExtractionSpec
): UsageStats | undefined {
  const merged = mergeUsageExtractionSpecs(COMMON_USAGE_SPEC, spec);
  const extracted = extractUsageStats(raw, merged);
  if (extracted) {
    return extracted;
  }

  if (raw && typeof raw === 'object' && 'usage' in (raw as Record<string, unknown>)) {
    const usage = (raw as Record<string, unknown>).usage;
    if (usage && typeof usage === 'object' && Object.keys(usage).length === 0) {
      return { totalTokens: 0 };
    }
  }

  return undefined;
}
