import { finalizeUsageStats } from '@/modules/usage/index.ts';
import { estimateUsageCost } from '@/modules/usage/internal/usage-cost.ts';
import { resetDefaultsCache } from '@/modules/kernel/index.ts';
import { createTempDir, withTempCwd, writeJson } from '@/tests/helpers/temp-files.ts';

describe('utils/usage/usage-cost', () => {
  afterEach(() => {
    resetDefaultsCache();
  });

  test('estimates cost when enabled and rates are available', async () => {
    await withTempCwd('usage-cost', async (dir) => {
      const costsPath = `${dir}/plugins/configs/costs.json`;
      writeJson(costsPath, {
        providerA: {
          modelA: {
            input: 1,
            output: 2,
            cached: 0.5
          }
        }
      });

      const usage = await finalizeUsageStats({
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          cachedTokens: 20
        },
        provider: 'providerA',
        model: 'modelA',
        settings: {
          usageCost: { enabled: true }
        }
      });

      expect(usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 20,
        cost: 0.00019
      });
    });
  });

  test('skips estimation when disabled', async () => {
    const usage = await finalizeUsageStats({
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 0
      },
      provider: 'providerA',
      model: 'modelA',
      settings: {
        usageCost: { enabled: false }
      }
    });

    expect(usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0
    });
  });

  test('returns undefined when prompt tokens are missing', async () => {
    const dir = createTempDir('usage-cost-missing-prompt');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      providerA: { modelA: { input: 1, output: 2 } }
    });

    const result = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { completionTokens: 5 },
      costsPath
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when completion tokens are missing', async () => {
    const dir = createTempDir('usage-cost-missing-completion');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      providerA: { modelA: { input: 1, output: 2 } }
    });

    const result = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { promptTokens: 5 },
      costsPath
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when costs file is missing', async () => {
    const result = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { promptTokens: 5, completionTokens: 6 },
      costsPath: './missing-costs.json'
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when provider or model rates are missing', async () => {
    const dir = createTempDir('usage-cost-missing-rates');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      providerA: { modelA: { input: 1, output: 2 } }
    });

    const noProvider = await estimateUsageCost({
      provider: 'providerB',
      model: 'modelA',
      usage: { promptTokens: 5, completionTokens: 6 },
      costsPath
    });

    const noModel = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelB',
      usage: { promptTokens: 5, completionTokens: 6 },
      costsPath
    });

    expect(noProvider).toBeUndefined();
    expect(noModel).toBeUndefined();
  });

  test('returns undefined when input/output rates are invalid', async () => {
    const dir = createTempDir('usage-cost-invalid-rate');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      providerA: { modelA: { input: '', output: 'nope', cached: '1.2' } }
    });

    const result = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { promptTokens: 5, completionTokens: 6, cachedTokens: 1 },
      costsPath
    });

    expect(result).toBeUndefined();
  });

  test('uses cached table and string rates', async () => {
    const dir = createTempDir('usage-cost-cache');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      providerA: {
        modelA: { input: '1', output: '2', cached: '0.25' }
      }
    });

    const first = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 },
      costsPath
    });
    const second = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 },
      costsPath
    });

    expect(first).toBe(0.000019);
    expect(second).toBe(0.000019);
  });

  test('treats invalid cached rates as zero', async () => {
    const dir = createTempDir('usage-cost-cached-fallback');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      providerA: {
        modelA: { input: 1, output: 1, cached: 'nope' }
      }
    });

    const result = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 },
      costsPath
    });

    expect(result).toBe(0.000013);
  });

  test('returns undefined when costs file is invalid JSON', async () => {
    await withTempCwd('usage-cost-invalid-json', async (dir) => {
      const costsPath = `${dir}/costs.json`;
      writeJson(costsPath, { ok: true });
      const invalidPath = `${dir}/bad.json`;
      const fs = await import('fs');
      fs.writeFileSync(invalidPath, '{', 'utf-8');

      const result = await estimateUsageCost({
        provider: 'providerA',
        model: 'modelA',
        usage: { promptTokens: 1, completionTokens: 1 },
        costsPath: invalidPath
      });

      expect(result).toBeUndefined();
    });
  });

  test('returns undefined when costs file is not an object', async () => {
    const dir = createTempDir('usage-cost-bad-shape');
    const costsPath = `${dir}/costs.json`;
    const fs = await import('fs');
    fs.writeFileSync(costsPath, '"bad"', 'utf-8');

    const result = await estimateUsageCost({
      provider: 'providerA',
      model: 'modelA',
      usage: { promptTokens: 1, completionTokens: 1 },
      costsPath
    });

    expect(result).toBeUndefined();
  });
});
