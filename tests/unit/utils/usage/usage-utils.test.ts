import { usageStatsToJson } from '@/utils/usage/usage-utils.ts';

describe('utils/usage/usage-utils', () => {
  test('usageStatsToJson normalizes optional values to null', () => {
    const result = usageStatsToJson({
      promptTokens: 5,
      completionTokens: undefined,
      totalTokens: 6,
      reasoningTokens: undefined
    });

    expect(result).toEqual({
      promptTokens: 5,
      completionTokens: null,
      totalTokens: 6,
      reasoningTokens: null
    });
  });

  test('usageStatsToJson preserves defined numeric values', () => {
    const result = usageStatsToJson({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      reasoningTokens: 2
    });

    expect(result).toEqual({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      reasoningTokens: 2
    });
  });

  test('usageStatsToJson handles entirely missing fields', () => {
    const result = usageStatsToJson({});
    expect(result).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      reasoningTokens: null
    });
  });
});
