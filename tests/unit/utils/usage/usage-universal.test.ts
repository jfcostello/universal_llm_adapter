import { extractUniversalUsageStats } from '@/modules/usage/index.ts';

describe('utils/usage/usage-universal', () => {
  test('extracts common token fields from nested usage payloads', () => {
    const raw = {
      usage: {
        prompt_tokens: 4,
        completion_tokens: 6,
        cost: 0.02,
        total_tokens: 10
      }
    };

    const usage = extractUniversalUsageStats(raw);
    expect(usage).toEqual({
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
      cost: 0.02
    });
  });

  test('merges compat-specific mappings with common mappings', () => {
    const raw = {
      promptTokenCount: 7,
      candidatesTokenCount: 9
    };

    const usage = extractUniversalUsageStats(raw, {
      promptTokens: ['promptTokenCount'],
      completionTokens: ['candidatesTokenCount']
    });

    expect(usage).toEqual({
      promptTokens: 7,
      completionTokens: 9,
      totalTokens: 16
    });
  });
});
