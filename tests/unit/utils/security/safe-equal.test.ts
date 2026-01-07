import { describe, expect, test } from '@jest/globals';
import { safeEqual } from '@/modules/security/index.ts';

describe('utils/security/safe-equal', () => {
  test('returns true for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  test('returns false for same-length mismatches', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  test('returns false for different-length strings', () => {
    expect(safeEqual('a', 'ab')).toBe(false);
  });

  test('handles empty strings without throwing', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

