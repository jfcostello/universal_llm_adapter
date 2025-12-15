import { getDefaults } from '../../kernel/index.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier: number;
  rateLimitDelays?: number[];
}

/**
 * Get the default rate limit delays from the config.
 * Exported for backward compatibility.
 */
export function getDefaultRateLimitDelays(): number[] {
  return getDefaults().retry.rateLimitDelays;
}

/**
 * @deprecated Use getDefaultRateLimitDelays() for dynamic access.
 * This constant is kept for backward compatibility but now loads from config.
 */
export const DEFAULT_RATE_LIMIT_DELAYS = getDefaults().retry.rateLimitDelays;

export function createDefaultRetryPolicy(): RetryPolicy {
  const { retry } = getDefaults();
  return {
    maxAttempts: retry.maxAttempts,
    baseDelayMs: retry.baseDelayMs,
    multiplier: retry.multiplier,
    rateLimitDelays: retry.rateLimitDelays
  };
}
