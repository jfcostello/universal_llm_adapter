import { createDefaultRetryPolicy, DEFAULT_RATE_LIMIT_DELAYS } from '@/utils/retry/retry-policy.ts';

describe('utils/retry/retry-policy', () => {
  test('createDefaultRetryPolicy returns expected policy', () => {
    const policy = createDefaultRetryPolicy();
    expect(policy.maxAttempts).toBe(3);
    expect(policy.baseDelayMs).toBe(250);
    expect(policy.multiplier).toBe(2);
    expect(policy.rateLimitDelays).toEqual(DEFAULT_RATE_LIMIT_DELAYS);
  });
});
