import type { LLMCallSpec, VectorContextConfig, VectorRequestPolicy } from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';
import { parseNonNegativeInt } from '../../../../shared/index.js';

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseNonNegativeInt(value, fallback);
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function resolveVectorContexts(spec: LLMCallSpec): VectorContextConfig[] {
  if (!Array.isArray(spec.vectorContexts) || spec.vectorContexts.length < 1) {
    return [];
  }

  const out: VectorContextConfig[] = [];
  for (const ctx of spec.vectorContexts) {
    if (!ctx || typeof ctx !== 'object') continue;
    if (!Array.isArray(ctx.stores) || ctx.stores.length < 1) continue;
    out.push(ctx);
  }
  return out;
}

export function resolveVectorRequestPolicy(spec: LLMCallSpec): VectorRequestPolicy {
  const defaults = getDefaults().vector.requestPolicy;
  const override = (spec.vectorRequestPolicy && typeof spec.vectorRequestPolicy === 'object')
    ? spec.vectorRequestPolicy
    : {};

  const maxAutoContexts = normalizePositiveInt(override.maxAutoContexts, defaults.maxAutoContexts, 0, 20);
  const perContextTimeoutMs = normalizePositiveInt(override.perContextTimeoutMs, defaults.perContextTimeoutMs, 50, 120000);
  const totalAutoBudgetMs = normalizePositiveInt(
    override.totalAutoBudgetMs,
    defaults.totalAutoBudgetMs,
    50,
    300000
  );
  const maxInjectedPayloadBytes = normalizePositiveInt(
    override.maxInjectedPayloadBytes,
    defaults.maxInjectedPayloadBytes,
    64,
    1_000_000
  );

  return {
    maxAutoContexts,
    perContextTimeoutMs,
    totalAutoBudgetMs,
    maxInjectedPayloadBytes
  };
}

export function resolveAutoVectorContexts(
  contexts: VectorContextConfig[],
  policy: VectorRequestPolicy
): VectorContextConfig[] {
  const autoEnabled = contexts.filter(ctx => ctx.mode === 'auto' || ctx.mode === 'both');
  if (policy.maxAutoContexts <= 0) return [];
  return autoEnabled.slice(0, policy.maxAutoContexts);
}

export function hasToolVectorContexts(contexts: VectorContextConfig[]): boolean {
  return contexts.some(ctx => ctx.mode === 'tool' || ctx.mode === 'both');
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation(new AbortController().signal);
  }

  const abortController = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(abortController.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
