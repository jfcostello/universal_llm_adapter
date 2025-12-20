import { calculateUsageCost, loadUsageCostTable, resetUsageCostTableCache, getUsageCostRates } from '@/modules/usage-cost/index.ts';
import { jest } from '@jest/globals';

describe('modules/usage-cost', () => {
  const table = {
    providerA: {
      modelX: { input: 0.25, output: 1, cached: 0.1 },
      modelY: { input: 0.5, output: 1.5 }
    }
  };

  test('returns undefined when usage is missing or incomplete', () => {
    expect(calculateUsageCost({ provider: 'providerA', model: 'modelX', usage: undefined, table })).toBeUndefined();
    expect(calculateUsageCost({
      provider: 'providerA',
      model: 'modelX',
      usage: { promptTokens: 10 } as any,
      table
    })).toBeUndefined();
  });

  test('returns undefined when rates are incomplete', () => {
    const badTable = { providerA: { modelBad: { input: 1 } } } as any;
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelBad',
      usage: { promptTokens: 10, completionTokens: 5 },
      table: badTable
    });
    expect(cost).toBeUndefined();
  });

  test('calculates cost with cached tokens and explicit cached rate', () => {
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelX',
      usage: { promptTokens: 1000, completionTokens: 2000, cachedTokens: 100 },
      table
    });

    // ((1000-100)*0.25 + 100*0.1 + 2000*1) / 1_000_000 = 0.002235
    expect(cost).toBe(0.002235);
  });

  test('falls back to input rate when cached rate is missing', () => {
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelY',
      usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 20 },
      table
    });

    // ((100-20)*0.5 + 20*0.5 + 50*1.5) / 1_000_000 = 0.000125
    expect(cost).toBe(0.000125);
  });

  test('clamps cached tokens above prompt tokens', () => {
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelX',
      usage: { promptTokens: 10, completionTokens: 0, cachedTokens: 25 },
      table
    });

    // cached capped at 10: (0*0.25 + 10*0.1 + 0*1) / 1_000_000
    expect(cost).toBe(0.000001);
  });

  test('rounds cost to 6 decimals', () => {
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelX',
      usage: { promptTokens: 3, completionTokens: 0, cachedTokens: 0 },
      table
    });

    // 3 * 0.25 / 1_000_000 = 0.00000075 -> rounds to 0.000001
    expect(cost).toBe(0.000001);
  });

  test('accepts string rates in the cost table', () => {
    const stringTable = {
      providerA: {
        modelStr: { input: '0.25', output: '0.5' }
      }
    } as any;
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelStr',
      usage: { promptTokens: 4, completionTokens: 0 },
      table: stringTable
    });

    // 4 * 0.25 / 1_000_000 = 0.000001
    expect(cost).toBe(0.000001);
  });

  test('coerces string token counts in usage', () => {
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelX',
      usage: { promptTokens: '-5', completionTokens: '10', cachedTokens: '-2' } as any,
      table
    });

    // prompt and cached clamp to 0, completion = 10
    expect(cost).toBe(0.00001);
  });

  test('accepts per-million key variants in the cost table', () => {
    const variantTable = {
      providerA: {
        modelVariant: {
          inputPerMillion: 0.2,
          output_per_million: 0.4,
          cached_per_million: 0.05
        }
      }
    } as any;

    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelVariant',
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 },
      table: variantTable
    });

    // ((10-2)*0.2 + 2*0.05 + 5*0.4) / 1_000_000 = 0.0000037 -> rounds to 0.000004
    expect(cost).toBe(0.000004);
  });

  test('accepts input_per_million fallback when inputPerMillion missing', () => {
    const variantTable = {
      providerA: {
        modelVariant: {
          input_per_million: 1,
          outputPerMillion: 2
        }
      }
    } as any;

    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelVariant',
      usage: { promptTokens: 1, completionTokens: 1 },
      table: variantTable
    });

    // (1*1 + 1*2) / 1_000_000 = 0.000003
    expect(cost).toBe(0.000003);
  });

  test('returns undefined for invalid numeric rate values', () => {
    const blankInputTable = {
      providerA: {
        modelBad: { input: ' ', output: '1' }
      }
    } as any;
    const blankCost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelBad',
      usage: { promptTokens: 1, completionTokens: 1 },
      table: blankInputTable
    });
    expect(blankCost).toBeUndefined();

    const nanInputTable = {
      providerA: {
        modelBad: { input: 'NaN', output: '1' }
      }
    } as any;
    const nanCost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelBad',
      usage: { promptTokens: 1, completionTokens: 1 },
      table: nanInputTable
    });
    expect(nanCost).toBeUndefined();
  });

  test('returns undefined for non-finite numeric rates', () => {
    const infiniteTable = {
      providerA: {
        modelBad: { input: Number.POSITIVE_INFINITY, output: 1 }
      }
    } as any;
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelBad',
      usage: { promptTokens: 1, completionTokens: 1 },
      table: infiniteTable
    });
    expect(cost).toBeUndefined();
  });

  test('returns undefined for non-object model entries', () => {
    const badTable = { providerA: { modelBad: true } } as any;
    const rates = getUsageCostRates('providerA', 'modelBad', badTable);
    expect(rates).toBeUndefined();
  });

  test('clamps negative token counts to zero', () => {
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelX',
      usage: { promptTokens: -10, completionTokens: 2, cachedTokens: 0 },
      table
    });

    // (0*0.25 + 0*0.1 + 2*1) / 1_000_000 = 0.000002
    expect(cost).toBe(0.000002);
  });

  test('returns undefined when token counts are non-finite numbers', () => {
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelX',
      usage: { promptTokens: Number.POSITIVE_INFINITY, completionTokens: 1 },
      table
    });

    expect(cost).toBeUndefined();
  });

  test('returns undefined when cost calculation overflows', () => {
    const hugeTable = {
      providerA: {
        modelHuge: { input: 1e308, output: 1e308 }
      }
    } as any;
    const cost = calculateUsageCost({
      provider: 'providerA',
      model: 'modelHuge',
      usage: { promptTokens: 1e308, completionTokens: 1e308 },
      table: hugeTable
    });

    expect(cost).toBeUndefined();
  });

  test('loads usage cost table from file', () => {
    resetUsageCostTableCache();
    const loaded = loadUsageCostTable();
    expect(loaded).toBeDefined();
  });

  test('getUsageCostRates returns undefined when model missing', () => {
    const rates = getUsageCostRates('missing-provider', 'missing-model', table as any);
    expect(rates).toBeUndefined();
  });
});

describe('modules/usage-cost loading fallback', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('returns undefined when no cost table file exists', async () => {
    const originalFs = await import('fs');
    const fsMock: any = {
      __esModule: true,
      existsSync: jest.fn(() => false),
      readFileSync: originalFs.readFileSync
    };
    fsMock.default = fsMock;

    (jest as any).unstable_mockModule('fs', () => fsMock);

    const { loadUsageCostTable, resetUsageCostTableCache } = await import('@/modules/usage-cost/index.ts');
    resetUsageCostTableCache();
    const loaded = loadUsageCostTable();
    expect(loaded).toBeUndefined();
    const secondLoad = loadUsageCostTable();
    expect(secondLoad).toBeUndefined();

    const { getUsageCostRates } = await import('@/modules/usage-cost/index.ts');
    const rates = getUsageCostRates('missing-provider', 'missing-model');
    expect(rates).toBeUndefined();

    jest.resetModules();
  });

  test('returns undefined when cost table file cannot be parsed', async () => {
    const fsMock: any = {
      __esModule: true,
      existsSync: jest.fn(() => true)
    };
    fsMock.default = fsMock;

    (jest as any).unstable_mockModule('fs', () => fsMock);
    (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
      __esModule: true,
      PACKAGE_ROOT: process.cwd(),
      loadJsonFile: () => {
        throw new Error('boom');
      }
    }));

    const { loadUsageCostTable, resetUsageCostTableCache } = await import('@/modules/usage-cost/index.ts');
    resetUsageCostTableCache();
    const loaded = loadUsageCostTable();
    expect(loaded).toBeUndefined();

    jest.resetModules();
  });
});
