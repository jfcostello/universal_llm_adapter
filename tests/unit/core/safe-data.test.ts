import { getByPath, safeJsonParse } from '@/modules/kernel/index.ts';

describe('core/safe-data', () => {
  describe('getByPath', () => {
    test('reads nested object paths', () => {
      expect(getByPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    });

    test('supports array indices in string paths', () => {
      const value = { a: [{ b: 2 }] };
      expect(getByPath(value, 'a.0.b')).toBe(2);
    });

    test('supports array paths with numeric segments', () => {
      const value = { a: [{ b: 3 }] };
      expect(getByPath(value, ['a', 0, 'b'])).toBe(3);
    });

    test('returns defaultValue for missing paths', () => {
      expect(getByPath({ a: 1 }, 'a.b')).toBeUndefined();
      expect(getByPath({ a: 1 }, 'a.b', { defaultValue: 'fallback' })).toBe('fallback');
      expect(getByPath({ a: {} }, 'a.b', { defaultValue: 'fallback' })).toBe('fallback');
    });

    test('treats empty paths as identity', () => {
      expect(getByPath(123, '')).toBe(123);
      expect(getByPath(123, '   ')).toBe(123);
    });

    test('supports numeric segments for non-array objects', () => {
      expect(getByPath({ a: { 0: 'x' } }, 'a.0')).toBe('x');
    });
  });

  describe('safeJsonParse', () => {
    test('parses valid JSON', () => {
      expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    });

    test('returns fallback for invalid JSON', () => {
      expect(safeJsonParse('{')).toBeUndefined();
      expect(safeJsonParse('{', { ok: false })).toEqual({ ok: false });
    });

    test('returns fallback for empty input', () => {
      expect(safeJsonParse('')).toBeUndefined();
      expect(safeJsonParse('   ', 123)).toBe(123);
    });

    test('returns fallback for null/undefined input', () => {
      expect(safeJsonParse(null)).toBeUndefined();
      expect(safeJsonParse(undefined, 'fallback')).toBe('fallback');
    });
  });
});
