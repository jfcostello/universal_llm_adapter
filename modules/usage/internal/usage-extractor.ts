import type { UsageStats, PathSegment } from '../../kernel/index.js';
import { getByPath } from '../../kernel/index.js';

export type UsagePath = string | PathSegment[];

export interface UsagePathSumSpec {
  mode: 'sum';
  paths: UsagePath | UsagePath[];
}

export type UsagePathCandidate = UsagePath | UsagePathSumSpec;
export type UsagePathSpec = UsagePathCandidate | UsagePathCandidate[];

export interface UsageExtractionSpec {
  promptTokens?: UsagePathSpec;
  completionTokens?: UsagePathSpec;
  totalTokens?: UsagePathSpec;
  reasoningTokens?: UsagePathSpec;
  cost?: UsagePathSpec;
  cachedTokens?: UsagePathSpec;
  audioTokens?: UsagePathSpec;
  promptTokensIncludeCached?: boolean;
}

const GLOBAL_USAGE_SPEC: UsageExtractionSpec = {
  promptTokens: [
    ['usage', 'prompt_tokens'],
    ['usage', 'input_tokens'],
    ['usage', 'promptTokens'],
    ['usage', 'inputTokens'],
    ['prompt_tokens'],
    ['input_tokens'],
    ['promptTokens'],
    ['inputTokens']
  ],
  completionTokens: [
    ['usage', 'completion_tokens'],
    ['usage', 'output_tokens'],
    ['usage', 'completionTokens'],
    ['usage', 'outputTokens'],
    ['completion_tokens'],
    ['output_tokens'],
    ['completionTokens'],
    ['outputTokens']
  ],
  totalTokens: [
    ['usage', 'total_tokens'],
    ['usage', 'totalTokens'],
    ['total_tokens'],
    ['totalTokens']
  ],
  reasoningTokens: [
    ['usage', 'completion_tokens_details', 'reasoning_tokens'],
    ['usage', 'reasoning_tokens'],
    ['usage', 'reasoningTokens'],
    ['reasoning_tokens'],
    ['reasoningTokens'],
    ['usage', 'thoughtsTokenCount'],
    ['thoughtsTokenCount']
  ],
  cost: [
    ['usage', 'cost'],
    ['usage', 'total_cost'],
    ['usage', 'totalCost'],
    ['cost'],
    ['total_cost'],
    ['totalCost'],
    ['usage', 'cost_usd'],
    ['cost_usd']
  ],
  cachedTokens: [
    ['usage', 'prompt_tokens_details', 'cached_tokens'],
    ['usage', 'input_tokens_details', 'cached_tokens'],
    ['usage', 'input_token_details', 'cached_tokens'],
    ['usage', 'cached_tokens'],
    ['usage', 'cachedTokens'],
    ['prompt_tokens_details', 'cached_tokens'],
    ['input_tokens_details', 'cached_tokens'],
    ['input_token_details', 'cached_tokens'],
    ['cached_tokens'],
    ['cachedTokens']
  ],
  audioTokens: [
    ['usage', 'prompt_tokens_details', 'audio_tokens'],
    ['usage', 'input_tokens_details', 'audio_tokens'],
    ['usage', 'input_token_details', 'audio_tokens'],
    ['usage', 'audio_tokens'],
    ['usage', 'audioTokens'],
    ['prompt_tokens_details', 'audio_tokens'],
    ['input_tokens_details', 'audio_tokens'],
    ['input_token_details', 'audio_tokens'],
    ['audio_tokens'],
    ['audioTokens']
  ]
};

export function getGlobalUsageSpec(): UsageExtractionSpec {
  return mergeUsageExtractionSpecs(GLOBAL_USAGE_SPEC);
}

function isSumSpec(value: unknown): value is UsagePathSumSpec {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as UsagePathSumSpec).mode === 'sum' &&
    'paths' in (value as UsagePathSumSpec)
  );
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

function toCandidateList(value?: UsagePathSpec): UsagePathCandidate[] {
  if (!value) return [];
  if (isSumSpec(value)) return [value];
  if (!Array.isArray(value)) return [value as UsagePath];
  if (value.length === 0) return [];

  if (value.some(isSumSpec)) {
    return value as UsagePathCandidate[];
  }

  // Disambiguate:
  // - PathSegment[] (single path): ['usage', 'prompt_tokens']
  // - UsagePathCandidate[] (multiple paths): ['usage.prompt_tokens', 'usage2.prompt_tokens'] or [['usage','prompt_tokens'], ...]
  if (value.some(v => Array.isArray(v))) {
    return value as UsagePathCandidate[];
  }
  if (value.some(v => typeof v === 'string' && v.includes('.'))) {
    return value as UsagePathCandidate[];
  }

  return [value as PathSegment[]];
}

function clonePath(path: UsagePath): UsagePath {
  return Array.isArray(path) ? [...path] : path;
}

function serializePath(path: UsagePath): string {
  return Array.isArray(path) ? path.map(segment => String(segment)).join('.') : path;
}

function cloneCandidate(candidate: UsagePathCandidate): UsagePathCandidate {
  if (isSumSpec(candidate)) {
    const paths = toPathList(candidate.paths).map(clonePath);
    return { mode: 'sum', paths };
  }
  return clonePath(candidate);
}

function serializeCandidate(candidate: UsagePathCandidate): string {
  if (isSumSpec(candidate)) {
    const parts = toPathList(candidate.paths).map(serializePath).join('|');
    return `sum:${parts}`;
  }
  return serializePath(candidate);
}

function mergeCandidates(base?: UsagePathSpec, override?: UsagePathSpec): UsagePathCandidate[] {
  const merged: UsagePathCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: UsagePathCandidate) => {
    const key = serializeCandidate(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(cloneCandidate(candidate));
  };

  for (const candidate of toCandidateList(override)) {
    pushCandidate(candidate);
  }

  for (const candidate of toCandidateList(base)) {
    pushCandidate(candidate);
  }

  return merged;
}

export function mergeUsageExtractionSpecs(
  base: UsageExtractionSpec,
  override?: UsageExtractionSpec
): UsageExtractionSpec {
  const merged: UsageExtractionSpec = {};

  type UsagePathField = keyof Pick<UsageExtractionSpec,
  'promptTokens' |
  'completionTokens' |
  'totalTokens' |
  'reasoningTokens' |
  'cost' |
  'cachedTokens' |
  'audioTokens'
  >;

  const fields: UsagePathField[] = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'reasoningTokens',
    'cost',
    'cachedTokens',
    'audioTokens'
  ];

  for (const field of fields) {
    const candidates = mergeCandidates(base[field], override?.[field]);
    if (candidates.length > 0) {
      merged[field] = candidates;
    }
  }

  if (override?.promptTokensIncludeCached !== undefined) {
    merged.promptTokensIncludeCached = override.promptTokensIncludeCached;
  } else if (base.promptTokensIncludeCached !== undefined) {
    merged.promptTokensIncludeCached = base.promptTokensIncludeCached;
  }

  return merged;
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

function readNumberByPaths(raw: unknown, paths: UsagePath[]): number | null | undefined {
  for (const p of paths) {
    const value = getByPath(raw, p);
    if (value === null) {
      return null;
    }
    const num = coerceToNumber(value);
    if (num !== undefined) {
      return num;
    }
  }
  return undefined;
}

function readSumByPaths(raw: unknown, paths: UsagePath[]): number | null | undefined {
  let total = 0;
  let hasValue = false;

  for (const p of paths) {
    const value = getByPath(raw, p);
    if (value === null) {
      return null;
    }
    const num = coerceToNumber(value);
    if (num !== undefined) {
      total += num;
      hasValue = true;
    }
  }

  return hasValue ? total : undefined;
}

function readNumberByCandidates(raw: unknown, candidates: UsagePathCandidate[]): number | null | undefined {
  for (const candidate of candidates) {
    const value = isSumSpec(candidate)
      ? readSumByPaths(raw, toPathList(candidate.paths))
      : readNumberByPaths(raw, toPathList(candidate));
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

const PROMPT_TOKENS_INCLUDE_CACHED = Symbol('usage.promptTokensIncludeCached');

export function setPromptTokensIncludeCached(usage: UsageStats, value: boolean): void {
  Object.defineProperty(usage, PROMPT_TOKENS_INCLUDE_CACHED, {
    value,
    enumerable: false,
    configurable: false
  });
}

export function getPromptTokensIncludeCached(usage: UsageStats | undefined): boolean | undefined {
  if (!usage) return undefined;
  return (usage as any)[PROMPT_TOKENS_INCLUDE_CACHED];
}

export function extractUsageStats(raw: unknown, spec: UsageExtractionSpec): UsageStats | undefined {
  const usage: UsageStats = {};

  const promptTokens = readNumberByCandidates(raw, toCandidateList(spec.promptTokens));
  if (promptTokens !== undefined) usage.promptTokens = promptTokens;

  const completionTokens = readNumberByCandidates(raw, toCandidateList(spec.completionTokens));
  if (completionTokens !== undefined) usage.completionTokens = completionTokens;

  const totalTokens = readNumberByCandidates(raw, toCandidateList(spec.totalTokens));
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;

  const reasoningTokens = readNumberByCandidates(raw, toCandidateList(spec.reasoningTokens));
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;

  const cost = readNumberByCandidates(raw, toCandidateList(spec.cost));
  if (cost !== undefined) usage.cost = cost;

  const cachedTokens = readNumberByCandidates(raw, toCandidateList(spec.cachedTokens));
  if (cachedTokens !== undefined) usage.cachedTokens = cachedTokens;

  const audioTokens = readNumberByCandidates(raw, toCandidateList(spec.audioTokens));
  if (audioTokens !== undefined) usage.audioTokens = audioTokens;

  if (usage.totalTokens === undefined) {
    const hasPrompt = typeof usage.promptTokens === 'number';
    const hasCompletion = typeof usage.completionTokens === 'number';
    if (hasPrompt && hasCompletion) {
      usage.totalTokens = (usage.promptTokens as number) + (usage.completionTokens as number);
    }
  }

  if (typeof spec.promptTokensIncludeCached === 'boolean') {
    setPromptTokensIncludeCached(usage, spec.promptTokensIncludeCached);
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}
