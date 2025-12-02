import { partitionSettings, mergeRuntimeSettings, mergeProviderSettings } from '@/utils/settings/settings-partitioner.ts';

describe('settings-partitioner', () => {
  test('separates runtime keys from provider settings', () => {
    const { runtime, provider, providerExtras } = partitionSettings({
      temperature: 0.2,
      toolCountdownEnabled: false,
      maxToolIterations: 5,
      preserveReasoning: 2
    });

    expect(runtime).toEqual({
      toolCountdownEnabled: false,
      maxToolIterations: 5,
      preserveReasoning: 2
    });
    expect(provider).toEqual({ temperature: 0.2 });
    expect(providerExtras).toEqual({});
  });

  test('surfaces unknown keys as provider extras', () => {
    const { providerExtras } = partitionSettings({
      fakeField: 'value',
      provider: { route: 'fast' }
    });

    expect(providerExtras).toEqual({
      fakeField: 'value',
      provider: { route: 'fast' }
    });
  });

  test('includes known provider settings without duplicating extras', () => {
    const { runtime, provider, providerExtras } = partitionSettings({
      temperature: 0.7,
      topP: 0.9,
      fakeField: 'value',
      toolFinalPromptEnabled: false
    });

    expect(runtime).toEqual({ toolFinalPromptEnabled: false });
    expect(provider.temperature).toBe(0.7);
    expect(provider.topP).toBe(0.9);
    expect(providerExtras).toEqual({ fakeField: 'value' });
  });

  test('returns empty structures when settings undefined', () => {
    const { runtime, provider, providerExtras } = partitionSettings(undefined);
    expect(runtime).toEqual({});
    expect(provider).toEqual({});
    expect(providerExtras).toEqual({});
  });

  test('ignores undefined values in settings', () => {
    const { runtime, provider, providerExtras } = partitionSettings({
      temperature: undefined,
      toolCountdownEnabled: undefined,
      mysterious: undefined
    } as any);

    expect(runtime).toEqual({});
    expect(provider).toEqual({});
    expect(providerExtras).toEqual({});
  });

  test('mergeRuntimeSettings applies overrides and handles undefined', () => {
    const base = { toolCountdownEnabled: true } as any;
    const overrides = { toolCountdownEnabled: false, maxToolIterations: 4 } as any;

    expect(mergeRuntimeSettings(base, undefined)).toEqual(base);
    expect(mergeRuntimeSettings(base, overrides)).toEqual({
      toolCountdownEnabled: false,
      maxToolIterations: 4
    });
  });
});

describe('mergeProviderSettings', () => {
  test('returns global settings when no per-provider settings provided', () => {
    const global = { temperature: 0.7, maxTokens: 100 };
    expect(mergeProviderSettings(global, undefined)).toEqual(global);
  });

  test('returns global settings when per-provider is empty object', () => {
    const global = { temperature: 0.7, maxTokens: 100 };
    expect(mergeProviderSettings(global, {})).toEqual(global);
  });

  test('overrides primitive values', () => {
    const global = { temperature: 0.7, maxTokens: 100, topP: 0.9 };
    const perProvider = { temperature: 0.3 };
    const result = mergeProviderSettings(global, perProvider);

    expect(result).toEqual({
      temperature: 0.3,
      maxTokens: 100,
      topP: 0.9
    });
  });

  test('overrides multiple primitive values', () => {
    const global = { temperature: 0.7, maxTokens: 100, topP: 0.9, seed: 42 };
    const perProvider = { temperature: 0.3, maxTokens: 500 };
    const result = mergeProviderSettings(global, perProvider);

    expect(result).toEqual({
      temperature: 0.3,
      maxTokens: 500,
      topP: 0.9,
      seed: 42
    });
  });

  test('deep merges nested objects (reasoning)', () => {
    const global = {
      temperature: 0.7,
      reasoning: { enabled: true, budget: 1000 }
    };
    const perProvider = {
      reasoning: { budget: 2000 }
    };
    const result = mergeProviderSettings(global, perProvider);

    expect(result.reasoning).toEqual({
      enabled: true,
      budget: 2000
    });
    expect(result.temperature).toBe(0.7);
  });

  test('replaces arrays entirely (stop sequences)', () => {
    const global = { temperature: 0.7, stop: ['STOP1', 'STOP2'] };
    const perProvider = { stop: ['END'] };
    const result = mergeProviderSettings(global, perProvider);

    expect(result.stop).toEqual(['END']);
    expect(result.temperature).toBe(0.7);
  });

  test('ignores undefined values in per-provider settings', () => {
    const global = { temperature: 0.7, maxTokens: 100 };
    const perProvider = { temperature: undefined, maxTokens: 200 } as any;
    const result = mergeProviderSettings(global, perProvider);

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: 200
    });
  });

  test('adds new fields from per-provider settings', () => {
    const global = { temperature: 0.7 };
    const perProvider = { maxTokens: 500, seed: 42 };
    const result = mergeProviderSettings(global, perProvider);

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: 500,
      seed: 42
    });
  });

  test('handles null values in per-provider (replaces)', () => {
    const global = { temperature: 0.7, reasoning: { enabled: true } };
    const perProvider = { reasoning: null } as any;
    const result = mergeProviderSettings(global, perProvider);

    expect(result.reasoning).toBeNull();
  });

  test('handles adding nested object when global has none', () => {
    const global = { temperature: 0.7 };
    const perProvider = { reasoning: { enabled: true, budget: 1000 } };
    const result = mergeProviderSettings(global, perProvider);

    expect(result).toEqual({
      temperature: 0.7,
      reasoning: { enabled: true, budget: 1000 }
    });
  });

  test('does not mutate original global settings', () => {
    const global = { temperature: 0.7, reasoning: { enabled: true, budget: 1000 } };
    const perProvider = { temperature: 0.3, reasoning: { budget: 2000 } };

    const result = mergeProviderSettings(global, perProvider);

    // Original should be unchanged
    expect(global.temperature).toBe(0.7);
    expect(global.reasoning.budget).toBe(1000);

    // Result should have merged values
    expect(result.temperature).toBe(0.3);
    expect(result.reasoning?.budget).toBe(2000);
  });

  test('handles runtime settings (maxToolIterations etc)', () => {
    const global = {
      temperature: 0.7,
      maxToolIterations: 10,
      toolCountdownEnabled: true
    };
    const perProvider = {
      maxToolIterations: 5
    };
    const result = mergeProviderSettings(global, perProvider);

    expect(result).toEqual({
      temperature: 0.7,
      maxToolIterations: 5,
      toolCountdownEnabled: true
    });
  });
});
