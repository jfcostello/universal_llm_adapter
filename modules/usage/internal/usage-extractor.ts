import type { UsageStats, PathSegment } from '../../kernel/index.js';
import { getByPath } from '../../kernel/index.js';

export type UsagePath = string | PathSegment[];

export interface UsageExtractionSpec {
  promptTokens?: UsagePath | UsagePath[];
  completionTokens?: UsagePath | UsagePath[];
  totalTokens?: UsagePath | UsagePath[];
  reasoningTokens?: UsagePath | UsagePath[];
  cost?: UsagePath | UsagePath[];
  cachedTokens?: UsagePath | UsagePath[];
  audioTokens?: UsagePath | UsagePath[];
}

function toPathList(value?: UsagePath | UsagePath[]): UsagePath[] {
  if (!value) return [];
  if (!Array.isArray(value)) return [value];
  if (value.length === 0) return [];

  // Disambiguate:
  // - PathSegment[] (single path): ['usage', 'prompt_tokens']
  // - UsagePath[] (multiple paths): ['usage.prompt_tokens', 'usage2.prompt_tokens'] or [['usage','prompt_tokens'], ...]
  if (value.some(v => Array.isArray(v))) {
    return value as UsagePath[];
  }
  if (value.some(v => typeof v === 'string' && v.includes('.'))) {
    return value as UsagePath[];
  }

  return [value as PathSegment[]];
}

function coerceToNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function readNumberByPaths(raw: unknown, paths: UsagePath[]): number | undefined {
  for (const p of paths) {
    const value = getByPath(raw, p);
    const num = coerceToNumber(value);
    if (num !== undefined) {
      return num;
    }
  }
  return undefined;
}

export function mergeUsageExtractionSpecs(
  ...specs: Array<UsageExtractionSpec | undefined>
): UsageExtractionSpec {
  const merged: UsageExtractionSpec = {};
  const fields: Array<keyof UsageExtractionSpec> = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'reasoningTokens',
    'cost',
    'cachedTokens',
    'audioTokens'
  ];

  for (const field of fields) {
    const paths: UsagePath[] = [];
    for (const spec of specs) {
      if (!spec?.[field]) continue;
      paths.push(...toPathList(spec[field]));
    }
    if (paths.length > 0) {
      merged[field] = paths;
    }
  }

  return merged;
}

export function extractUsageStats(raw: unknown, spec: UsageExtractionSpec): UsageStats | undefined {
  const usage: UsageStats = {};

  const promptTokens = readNumberByPaths(raw, toPathList(spec.promptTokens));
  if (promptTokens !== undefined) usage.promptTokens = promptTokens;

  const completionTokens = readNumberByPaths(raw, toPathList(spec.completionTokens));
  if (completionTokens !== undefined) usage.completionTokens = completionTokens;

  const totalTokens = readNumberByPaths(raw, toPathList(spec.totalTokens));
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;

  const reasoningTokens = readNumberByPaths(raw, toPathList(spec.reasoningTokens));
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;

  const cost = readNumberByPaths(raw, toPathList(spec.cost));
  if (cost !== undefined) usage.cost = cost;

  const cachedTokens = readNumberByPaths(raw, toPathList(spec.cachedTokens));
  if (cachedTokens !== undefined) usage.cachedTokens = cachedTokens;

  const audioTokens = readNumberByPaths(raw, toPathList(spec.audioTokens));
  if (audioTokens !== undefined) usage.audioTokens = audioTokens;

  if (usage.totalTokens === undefined) {
    const hasPrompt = typeof usage.promptTokens === 'number';
    const hasCompletion = typeof usage.completionTokens === 'number';
    if (hasPrompt && hasCompletion) {
      usage.totalTokens = (usage.promptTokens as number) + (usage.completionTokens as number);
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}
