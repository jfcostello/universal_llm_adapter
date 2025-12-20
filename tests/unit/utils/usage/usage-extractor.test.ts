import { extractUsageStats, mergeUsageExtractionSpecs, getGlobalUsageSpec } from '@/modules/usage/index.ts';

describe('utils/usage/usage-extractor', () => {
  test('extracts token usage from nested objects and computes total when missing', () => {
    const raw = {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5
      }
    };

    const usage = extractUsageStats(raw, {
      promptTokens: ['usage', 'prompt_tokens'],
      completionTokens: ['usage', 'completion_tokens']
    });

    expect(usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15
    });
  });

  test('supports multiple string paths and coerces numeric strings', () => {
    const raw = { usage: { total_tokens: '20' } };
    const usage = extractUsageStats(raw, {
      totalTokens: ['usage.total_tokens', 'usage.totalTokens']
    });

    expect(usage).toEqual({ totalTokens: 20 });
  });

  test('falls back to later paths when earlier paths are missing', () => {
    const raw = { usage: { totalTokens: 30 } };
    const usage = extractUsageStats(raw, {
      totalTokens: ['usage.total_tokens', 'usage.totalTokens']
    });

    expect(usage).toEqual({ totalTokens: 30 });
  });

  test('supports multiple segment-path candidates (nested array paths)', () => {
    const raw = { alternative: { prompt: 7 } };
    const usage = extractUsageStats(raw, {
      promptTokens: [['usage', 'prompt_tokens'], ['alternative', 'prompt']]
    });

    expect(usage).toEqual({ promptTokens: 7 });
  });

  test('returns undefined when no fields are extracted', () => {
    const usage = extractUsageStats({ ok: true }, { totalTokens: 'usage.total_tokens' });
    expect(usage).toBeUndefined();
  });

  test('handles empty path lists', () => {
    const usage = extractUsageStats({ usage: { total_tokens: 1 } }, { totalTokens: [] });
    expect(usage).toBeUndefined();
  });

  test('ignores non-finite numbers and invalid numeric strings', () => {
    const raw = {
      usage: {
        total_tokens: Infinity,
        prompt_tokens: '   ',
        completion_tokens: 'nope'
      }
    };

    const usage = extractUsageStats(raw, {
      totalTokens: 'usage.total_tokens',
      promptTokens: 'usage.prompt_tokens',
      completionTokens: 'usage.completion_tokens'
    });

    expect(usage).toBeUndefined();
  });

  test('preserves explicit null token values', () => {
    const raw = {
      usage: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null
      }
    };

    const usage = extractUsageStats(raw, {
      promptTokens: 'usage.prompt_tokens',
      completionTokens: 'usage.completion_tokens',
      totalTokens: 'usage.total_tokens'
    });

    expect(usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null
    });
  });

  test('extracts extended usage fields when present', () => {
    const raw = {
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        reasoning_tokens: 3,
        cost: 0.01,
        cached_tokens: 4,
        audio_tokens: 5,
        total_tokens: 3
      }
    };

    const usage = extractUsageStats(raw, {
      promptTokens: 'usage.prompt_tokens',
      completionTokens: 'usage.completion_tokens',
      totalTokens: 'usage.total_tokens',
      reasoningTokens: 'usage.reasoning_tokens',
      cost: 'usage.cost',
      cachedTokens: 'usage.cached_tokens',
      audioTokens: 'usage.audio_tokens'
    });

    expect(usage).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      reasoningTokens: 3,
      cost: 0.01,
      cachedTokens: 4,
      audioTokens: 5
    });
  });
});

describe('utils/usage/usage-extractor global mapping', () => {
  test('global mapping extracts common usage shapes', () => {
    const raw = {
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 2 },
        prompt_tokens_details: { cached_tokens: 3, audio_tokens: 1 },
        cost: 0.0042
      }
    };

    const usage = extractUsageStats(raw, getGlobalUsageSpec());
    expect(usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      reasoningTokens: 2,
      cachedTokens: 3,
      audioTokens: 1,
      cost: 0.0042
    });
  });

  test('mergeUsageExtractionSpecs prepends overrides', () => {
    const globalSpec = getGlobalUsageSpec();
    const merged = mergeUsageExtractionSpecs(globalSpec, {
      promptTokens: ['meta.prompt_tokens'],
      completionTokens: ['meta.completion_tokens']
    });

    const raw = {
      meta: { prompt_tokens: 5, completion_tokens: 7 },
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    };

    const usage = extractUsageStats(raw, merged);
    expect(usage).toEqual({
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12
    });
  });
});
