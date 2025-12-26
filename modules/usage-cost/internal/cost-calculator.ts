import fs from 'fs';
import path from 'path';
import type { UsageStats } from '../../../kernel/index.js';
import { loadJsonFile, PACKAGE_ROOT } from '../../../kernel/index.js';
import { getPromptTokensIncludeCached } from '../../usage/index.js';

export interface UsageCostRates {
  input: number;
  output: number;
  cached?: number;
}

export type UsageCostTable = Record<string, Record<string, UsageCostRates>>;

const COST_TABLE_FILENAME = 'usage-costs.json';
let cachedTable: UsageCostTable | null | undefined;

function resolveCostTablePaths(): string[] {
  const candidates = [
    path.resolve(process.cwd(), 'plugins', 'configs', COST_TABLE_FILENAME),
    path.resolve(PACKAGE_ROOT, 'plugins', 'configs', COST_TABLE_FILENAME)
  ];

  return [...new Set(candidates)];
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeRates(raw: any): UsageCostRates | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const input = coerceNumber(raw.input ?? raw.inputPerMillion ?? raw.input_per_million);
  const output = coerceNumber(raw.output ?? raw.outputPerMillion ?? raw.output_per_million);
  const cached = coerceNumber(raw.cached ?? raw.cachedPerMillion ?? raw.cached_per_million);

  if (input === undefined || output === undefined) return undefined;

  return { input, output, cached };
}

export function loadUsageCostTable(): UsageCostTable | undefined {
  if (cachedTable !== undefined) {
    return cachedTable ?? undefined;
  }

  const paths = resolveCostTablePaths();
  for (const candidate of paths) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const data = loadJsonFile(candidate);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        cachedTable = data as UsageCostTable;
        return cachedTable;
      }
    } catch {
      // Continue to next candidate path (e.g., cwd -> package fallback).
      continue;
    }
  }

  cachedTable = null;
  return undefined;
}

export function resetUsageCostTableCache(): void {
  cachedTable = undefined;
}

export function getUsageCostRates(
  provider: string,
  model: string,
  table?: UsageCostTable
): UsageCostRates | undefined {
  const resolvedTable = table ?? loadUsageCostTable();
  if (!resolvedTable) return undefined;

  const providerEntry = resolvedTable[provider];
  if (!providerEntry || typeof providerEntry !== 'object') return undefined;

  const modelEntry = (providerEntry as any)[model];
  return normalizeRates(modelEntry);
}

function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value < 0 ? 0 : value;
  }
  const num = coerceNumber(value);
  if (num === undefined) return undefined;
  return num < 0 ? 0 : num;
}

export function calculateUsageCost(options: {
  provider: string;
  model: string;
  usage: UsageStats | undefined;
  table?: UsageCostTable;
}): number | undefined {
  const { provider, model, usage, table } = options;
  if (!usage) return undefined;

  const promptTokens = normalizeTokenCount(usage.promptTokens);
  const completionTokens = normalizeTokenCount(usage.completionTokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;

  const cachedTokens = normalizeTokenCount(usage.cachedTokens) ?? 0;

  const rates = getUsageCostRates(provider, model, table);
  if (!rates) return undefined;

  const safePrompt = Math.max(0, promptTokens);
  const safeCompletion = Math.max(0, completionTokens);
  const safeCached = Math.max(0, cachedTokens);

  const promptIncludesCached = getPromptTokensIncludeCached(usage) ?? true;
  const effectiveCached = promptIncludesCached ? Math.min(safeCached, safePrompt) : safeCached;
  const effectivePrompt = promptIncludesCached ? safePrompt - effectiveCached : safePrompt;

  const inputRate = rates.input / 1_000_000;
  const outputRate = rates.output / 1_000_000;
  const cachedRate = (rates.cached ?? rates.input) / 1_000_000;

  const cost = (effectivePrompt * inputRate) + (effectiveCached * cachedRate) + (safeCompletion * outputRate);
  const rounded = Math.round(cost * 1_000_000) / 1_000_000;

  return Number.isFinite(rounded) ? rounded : undefined;
}

export function attachUsageCostIfMissing(options: {
  provider: string;
  model: string;
  usage: UsageStats | undefined;
  table?: UsageCostTable;
}): number | undefined {
  const { provider, model, usage, table } = options;
  if (!usage) return undefined;
  if (typeof usage.cost === 'number') return undefined;

  const cost = calculateUsageCost({ provider, model, usage, table });
  if (typeof cost !== 'number') return undefined;

  usage.cost = cost;
  return cost;
}
