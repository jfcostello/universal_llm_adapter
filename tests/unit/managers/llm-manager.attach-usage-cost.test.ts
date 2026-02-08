import { attachUsageCostForResponseIfNeeded } from '@/modules/llm/internal/llm-manager/internal/attach-usage-cost.ts';

describe('managers/llm-manager/attach-usage-cost', () => {
  test('no-ops when usage is missing', async () => {
    await expect(
      attachUsageCostForResponseIfNeeded({
        usage: undefined,
        settings: { usageCost: true } as any,
        provider: 'google',
        model: 'gemini-3-flash-preview'
      })
    ).resolves.toBeUndefined();
  });

  test('no-ops when usage cost already present', async () => {
    const usage: any = { promptTokens: 1000, completionTokens: 1000, cost: 123 };
    await attachUsageCostForResponseIfNeeded({
      usage,
      settings: { usageCost: true } as any,
      provider: 'google',
      model: 'gemini-3-flash-preview'
    });
    expect(usage.cost).toBe(123);
  });

  test('no-ops when usageCost is disabled', async () => {
    const usage: any = { promptTokens: 1000, completionTokens: 1000 };
    await attachUsageCostForResponseIfNeeded({
      usage,
      settings: { usageCost: false } as any,
      provider: 'google',
      model: 'gemini-3-flash-preview'
    });
    expect(usage.cost).toBeUndefined();
  });

  test('no-ops when rates are missing for provider/model', async () => {
    const usage: any = { promptTokens: 1000, completionTokens: 1000 };
    await attachUsageCostForResponseIfNeeded({
      usage,
      settings: { usageCost: true } as any,
      provider: 'example-provider',
      model: 'missing-model'
    });
    expect(usage.cost).toBeUndefined();
  });

  test('attaches usage cost when enabled and missing', async () => {
    const usage: any = { promptTokens: 1000, completionTokens: 1000 };
    await attachUsageCostForResponseIfNeeded({
      usage,
      settings: { usageCost: true } as any,
      provider: 'google',
      model: 'gemini-3-flash-preview'
    });
    expect(usage.cost).toBe(0.00075);
  });
});

