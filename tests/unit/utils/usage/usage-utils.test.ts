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
      reasoningTokens: null,
      cost: null,
      cachedTokens: null,
      audioTokens: null
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
      reasoningTokens: 2,
      cost: null,
      cachedTokens: null,
      audioTokens: null
    });
  });

  test('usageStatsToJson handles entirely missing fields', () => {
    const result = usageStatsToJson({});
    expect(result).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      cost: null,
      cachedTokens: null,
      audioTokens: null
    });
  });

  test('usageStatsToJson handles extended usage fields (OpenRouter caching)', () => {
    const result = usageStatsToJson({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: 25,
      cost: 0.00125,
      cachedTokens: 75,
      audioTokens: 10
    });

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: 25,
      cost: 0.00125,
      cachedTokens: 75,
      audioTokens: 10
    });
  });

  test('usageStatsToJson handles partial extended usage fields', () => {
    const result = usageStatsToJson({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 0.001
    });

    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      reasoningTokens: null,
      cost: 0.001,
      cachedTokens: null,
      audioTokens: null
    });
  });
});
