import { partitionSettings, mergeRuntimeSettings } from '@/utils/settings/settings-partitioner.ts';

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
