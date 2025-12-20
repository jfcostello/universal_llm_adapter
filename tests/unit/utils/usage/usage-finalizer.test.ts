import { finalizeUsageStats } from '@/modules/usage/index.ts';
import fs from 'fs';
import path from 'path';
import { resetDefaultsCache } from '@/modules/kernel/index.ts';
import { createTempDir, writeJson } from '@/tests/helpers/temp-files.ts';

describe('utils/usage/usage-finalizer', () => {
  const defaultsPath = path.join(process.cwd(), 'plugins', 'configs', 'defaults.json');
  const originalDefaults = fs.readFileSync(defaultsPath, 'utf-8');

  async function withDefaults(
    usageCost: { enabled: boolean; costsPath?: string },
    fn: () => Promise<void>
  ): Promise<void> {
    const current = JSON.parse(originalDefaults);
    const next = { ...current, usageCost };
    fs.writeFileSync(defaultsPath, JSON.stringify(next, null, 2), 'utf-8');
    resetDefaultsCache();
    try {
      await fn();
    } finally {
      fs.writeFileSync(defaultsPath, originalDefaults, 'utf-8');
      resetDefaultsCache();
    }
  }

  test('returns undefined when usage is missing', async () => {
    const result = await finalizeUsageStats({
      usage: undefined,
      provider: 'p',
      model: 'm'
    });

    expect(result).toBeUndefined();
  });

  test('returns usage when cost is already present', async () => {
    const usage = await finalizeUsageStats({
      usage: { promptTokens: 1, completionTokens: 2, cost: 0.01 },
      provider: 'p',
      model: 'm'
    });

    expect(usage).toEqual({ promptTokens: 1, completionTokens: 2, cost: 0.01 });
  });

  test('respects override to disable estimation', async () => {
    await withDefaults({ enabled: true, costsPath: './plugins/configs/costs.json' }, async () => {
      const usage = await finalizeUsageStats({
        usage: { promptTokens: 1, completionTokens: 2 },
        provider: 'p',
        model: 'm',
        settings: { usageCost: { enabled: false } }
      });

      expect(usage).toEqual({ promptTokens: 1, completionTokens: 2 });
    });
  });

  test('uses defaults when override is not provided', async () => {
    const dir = createTempDir('usage-finalizer-defaults');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      p: { m: { input: 1, output: 1 } }
    });

    await withDefaults({ enabled: true, costsPath }, async () => {
      const usage = await finalizeUsageStats({
        usage: { promptTokens: 1, completionTokens: 1 },
        provider: 'p',
        model: 'm'
      });

      expect(usage?.cost).toBe(0.000002);
    });
  });

  test('uses override to enable estimation when defaults disabled', async () => {
    const dir = createTempDir('usage-finalizer-override');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      p: { m: { input: 1, output: 1 } }
    });

    await withDefaults({ enabled: false, costsPath }, async () => {
      const usage = await finalizeUsageStats({
        usage: { promptTokens: 2, completionTokens: 3 },
        provider: 'p',
        model: 'm',
        settings: { usageCost: { enabled: true } }
      });

      expect(usage?.cost).toBe(0.000005);
    });
  });

  test('returns usage when costsPath is missing', async () => {
    await withDefaults({ enabled: true, costsPath: '' }, async () => {
      const usage = await finalizeUsageStats({
        usage: { promptTokens: 1, completionTokens: 1 },
        provider: 'p',
        model: 'm'
      });

      expect(usage).toEqual({ promptTokens: 1, completionTokens: 1 });
    });
  });

  test('returns usage when estimation returns undefined', async () => {
    const dir = createTempDir('usage-finalizer-undefined');
    const costsPath = `${dir}/costs.json`;
    writeJson(costsPath, {
      p: { m: { input: 1, output: 1 } }
    });

    await withDefaults({ enabled: true, costsPath }, async () => {
      const usage = await finalizeUsageStats({
        usage: { promptTokens: 1 },
        provider: 'p',
        model: 'm'
      });

      expect(usage).toEqual({ promptTokens: 1 });
    });
  });

  test('falls back to disabled when defaults are missing enabled flag', async () => {
    await withDefaults({} as any, async () => {
      const usage = await finalizeUsageStats({
        usage: { promptTokens: 1, completionTokens: 2 },
        provider: 'p',
        model: 'm'
      });

      expect(usage).toEqual({ promptTokens: 1, completionTokens: 2 });
    });
  });
});
