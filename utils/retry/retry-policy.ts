export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier: number;
  rateLimitDelays?: number[];
}

export const DEFAULT_RATE_LIMIT_DELAYS = [
  1, 1, 5, 5, 5, 15, 15, 16, 30, 31, 61, 5, 5, 51
];

export function createDefaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 3,
    baseDelayMs: 250,
    multiplier: 2.0,
    rateLimitDelays: DEFAULT_RATE_LIMIT_DELAYS
  };
}