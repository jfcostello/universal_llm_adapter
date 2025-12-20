import type { UsageStats } from '../../kernel/index.js';

interface UsageCostRates {
  input?: number;
  output?: number;
  cached?: number;
}

type UsageCostTable = Record<string, Record<string, UsageCostRates>>;

let cachedCostTable: UsageCostTable | null = null;
let cachedCostPath: string | null = null;

function coerceRate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function roundCost(cost: number): number {
  return Number(cost.toFixed(6));
}

function isCostTable(value: unknown): value is UsageCostTable {
  return typeof value === 'object' && value !== null;
}

async function loadCostTable(costsPath: string): Promise<UsageCostTable | null> {
  if (cachedCostTable && cachedCostPath === costsPath) {
    return cachedCostTable;
  }

  const path = await import('path');
  const fs = await import('fs');
  const { loadJsonFile, PACKAGE_ROOT } = await import('../../kernel/index.js');

  const resolvedPaths = path.isAbsolute(costsPath)
    ? [costsPath]
    : [
        path.resolve(process.cwd(), costsPath),
        path.resolve(PACKAGE_ROOT, costsPath)
      ];

  const targetPath = resolvedPaths.find(p => fs.existsSync(p));
  if (!targetPath) {
    return null;
  }

  try {
    const loaded = loadJsonFile(targetPath);
    if (!isCostTable(loaded)) {
      return null;
    }
    cachedCostTable = loaded;
    cachedCostPath = costsPath;
    return cachedCostTable;
  } catch {
    return null;
  }
}

export async function estimateUsageCost(options: {
  provider: string;
  model: string;
  usage: UsageStats;
  costsPath: string;
}): Promise<number | undefined> {
  const promptTokens = typeof options.usage.promptTokens === 'number'
    ? options.usage.promptTokens
    : undefined;
  const completionTokens = typeof options.usage.completionTokens === 'number'
    ? options.usage.completionTokens
    : undefined;
  const cachedTokens = typeof options.usage.cachedTokens === 'number'
    ? options.usage.cachedTokens
    : 0;

  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }

  const costTable = await loadCostTable(options.costsPath);
  if (!costTable) return undefined;

  const providerTable = costTable[options.provider];
  if (!providerTable) return undefined;

  const rates = providerTable[options.model];
  if (!rates) return undefined;

  const inputRate = coerceRate(rates.input);
  const outputRate = coerceRate(rates.output);
  const cachedRate = coerceRate(rates.cached) ?? 0;

  if (inputRate === undefined || outputRate === undefined) {
    return undefined;
  }

  const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
  const inputCost = (uncachedPromptTokens * inputRate) / 1_000_000;
  const cachedCost = (cachedTokens * cachedRate) / 1_000_000;
  const outputCost = (completionTokens * outputRate) / 1_000_000;

  return roundCost(inputCost + cachedCost + outputCost);
}
