import {
  resolveObservabilityEnabled,
  resolveObservabilityTargetsOverride
} from '@/modules/observability/internal/env-overrides.ts';

describe('modules/observability env overrides', () => {
  test('resolveObservabilityEnabled prioritizes explicit spec value', () => {
    const env = { LLM_ADAPTER_OBSERVABILITY_ENABLED: '0' } as NodeJS.ProcessEnv;
    expect(resolveObservabilityEnabled(true, false, env)).toBe(true);
    expect(resolveObservabilityEnabled(false, true, env)).toBe(false);
  });

  test('resolveObservabilityEnabled parses env flags and falls back to defaults', () => {
    expect(resolveObservabilityEnabled(undefined, false, { LLM_ADAPTER_OBSERVABILITY_ENABLED: ' yes ' } as any)).toBe(true);
    expect(resolveObservabilityEnabled(undefined, true, { LLM_ADAPTER_OBSERVABILITY_ENABLED: 'OFF' } as any)).toBe(false);
    expect(resolveObservabilityEnabled(undefined, true, { LLM_ADAPTER_OBSERVABILITY_ENABLED: 'maybe' } as any)).toBe(true);
    expect(resolveObservabilityEnabled(undefined, false, { LLM_ADAPTER_OBSERVABILITY_ENABLED: '   ' } as any)).toBe(false);
  });

  test('resolveObservabilityTargetsOverride returns undefined when env var is missing or empty', () => {
    expect(resolveObservabilityTargetsOverride({} as any)).toBeUndefined();
    expect(resolveObservabilityTargetsOverride({ LLM_ADAPTER_OBSERVABILITY_TARGETS: '   ' } as any)).toBeUndefined();
  });

  test('resolveObservabilityTargetsOverride parses CSV provider lists', () => {
    const targets = resolveObservabilityTargetsOverride({
      LLM_ADAPTER_OBSERVABILITY_TARGETS: ' provider-a, , provider-b '
    } as any);

    expect(targets).toEqual([{ provider: 'provider-a' }, { provider: 'provider-b' }]);
    expect(resolveObservabilityTargetsOverride({ LLM_ADAPTER_OBSERVABILITY_TARGETS: ', , ' } as any)).toBeUndefined();
  });

  test('resolveObservabilityTargetsOverride parses JSON arrays and filters invalid entries', () => {
    const targets = resolveObservabilityTargetsOverride({
      LLM_ADAPTER_OBSERVABILITY_TARGETS: JSON.stringify([
        'provider-a',
        {
          provider: 'provider-b',
          providerConfig: { token: 'abc' },
          export: { signals: false },
          flushAt: 12,
          timeoutMs: 5000
        },
        {
          provider: 'provider-c',
          providerConfig: ['invalid'],
          export: ['invalid'],
          maxAttributeValueBytes: 8192
        },
        { provider: '' },
        null,
        ['nested-array'],
        123
      ])
    } as any);

    expect(targets).toEqual([
      { provider: 'provider-a' },
      {
        provider: 'provider-b',
        providerConfig: { token: 'abc' },
        export: { signals: false },
        flushAt: 12,
        timeoutMs: 5000
      },
      {
        provider: 'provider-c',
        maxAttributeValueBytes: 8192
      }
    ]);
  });

  test('resolveObservabilityTargetsOverride parses JSON single target objects', () => {
    const targets = resolveObservabilityTargetsOverride({
      LLM_ADAPTER_OBSERVABILITY_TARGETS: JSON.stringify({
        provider: 'single-target',
        maxAttempts: 4
      })
    } as any);

    expect(targets).toEqual([{ provider: 'single-target', maxAttempts: 4 }]);
  });

  test('resolveObservabilityTargetsOverride returns undefined for invalid or empty JSON target payloads', () => {
    expect(resolveObservabilityTargetsOverride({ LLM_ADAPTER_OBSERVABILITY_TARGETS: '[invalid-json' } as any)).toBeUndefined();
    expect(resolveObservabilityTargetsOverride({ LLM_ADAPTER_OBSERVABILITY_TARGETS: '[]' } as any)).toBeUndefined();
    expect(resolveObservabilityTargetsOverride({
      LLM_ADAPTER_OBSERVABILITY_TARGETS: JSON.stringify({ provider: '' })
    } as any)).toBeUndefined();
  });
});
