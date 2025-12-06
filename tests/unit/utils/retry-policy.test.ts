import { createDefaultRetryPolicy, DEFAULT_RATE_LIMIT_DELAYS, getDefaultRateLimitDelays } from '@/utils/retry/retry-policy.ts';

describe('utils/retry/retry-policy', () => {
  test('createDefaultRetryPolicy returns expected policy', () => {
    const policy = createDefaultRetryPolicy();
    expect(policy.maxAttempts).toBe(3);
    expect(policy.baseDelayMs).toBe(250);
    expect(policy.multiplier).toBe(2);
    expect(policy.rateLimitDelays).toEqual(DEFAULT_RATE_LIMIT_DELAYS);
  });

  test('getDefaultRateLimitDelays returns rate limit delays from config', () => {
    const delays = getDefaultRateLimitDelays();
    expect(Array.isArray(delays)).toBe(true);
    expect(delays).toEqual(DEFAULT_RATE_LIMIT_DELAYS);
    expect(delays.every(d => typeof d === 'number')).toBe(true);
  });
});
