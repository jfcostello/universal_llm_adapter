import { handle } from '@/plugins/modules/test-random.ts';

describe('plugins/modules/test-random', () => {
  test('returns random value within default range', () => {
    const result = handle({ args: {} });
    expect(result.randomValue).toBeGreaterThanOrEqual(0);
    expect(result.randomValue).toBeLessThanOrEqual(1000000);
    expect(typeof result.randomValue).toBe('number');
    expect(typeof result.timestamp).toBe('number');
  });

  test('returns random value within specified range', () => {
    const result = handle({ args: { min: 10, max: 20 } });
    expect(result.randomValue).toBeGreaterThanOrEqual(10);
    expect(result.randomValue).toBeLessThanOrEqual(20);
    expect(typeof result.timestamp).toBe('number');
  });

  test('handles min = max edge case', () => {
    const result = handle({ args: { min: 42, max: 42 } });
    expect(result.randomValue).toBe(42);
  });

  test('handles negative range', () => {
    const result = handle({ args: { min: -100, max: -50 } });
    expect(result.randomValue).toBeGreaterThanOrEqual(-100);
    expect(result.randomValue).toBeLessThanOrEqual(-50);
  });

  test('timestamp is recent', () => {
    const before = Date.now();
    const result = handle({ args: {} });
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});
