import { normalizeFlag } from '@/modules/shared/index.ts';

describe('modules/shared', () => {
  describe('normalizeFlag', () => {
    test('returns defaultValue for null and undefined', () => {
      expect(normalizeFlag(null, true)).toBe(true);
      expect(normalizeFlag(null, false)).toBe(false);
      expect(normalizeFlag(undefined, true)).toBe(true);
      expect(normalizeFlag(undefined, false)).toBe(false);
    });

    test('returns boolean values as-is', () => {
      expect(normalizeFlag(true, false)).toBe(true);
      expect(normalizeFlag(false, true)).toBe(false);
    });

    test('converts numbers via Boolean()', () => {
      expect(normalizeFlag(1, false)).toBe(true);
      expect(normalizeFlag(0, true)).toBe(false);
      expect(normalizeFlag(-1, false)).toBe(true);
      expect(normalizeFlag(0.5, false)).toBe(true);
    });

    test('handles truthy string values', () => {
      expect(normalizeFlag('true', false)).toBe(true);
      expect(normalizeFlag('TRUE', false)).toBe(true);
      expect(normalizeFlag('True', false)).toBe(true);
      expect(normalizeFlag('1', false)).toBe(true);
      expect(normalizeFlag('yes', false)).toBe(true);
      expect(normalizeFlag('YES', false)).toBe(true);
      expect(normalizeFlag('y', false)).toBe(true);
      expect(normalizeFlag('Y', false)).toBe(true);
      expect(normalizeFlag('on', false)).toBe(true);
      expect(normalizeFlag('ON', false)).toBe(true);
    });

    test('handles falsy string values', () => {
      expect(normalizeFlag('false', true)).toBe(false);
      expect(normalizeFlag('FALSE', true)).toBe(false);
      expect(normalizeFlag('False', true)).toBe(false);
      expect(normalizeFlag('0', true)).toBe(false);
      expect(normalizeFlag('no', true)).toBe(false);
      expect(normalizeFlag('NO', true)).toBe(false);
      expect(normalizeFlag('n', true)).toBe(false);
      expect(normalizeFlag('N', true)).toBe(false);
      expect(normalizeFlag('off', true)).toBe(false);
      expect(normalizeFlag('OFF', true)).toBe(false);
    });

    test('handles strings with whitespace', () => {
      expect(normalizeFlag('  true  ', false)).toBe(true);
      expect(normalizeFlag('  false  ', true)).toBe(false);
      expect(normalizeFlag('  YES  ', false)).toBe(true);
    });

    test('returns defaultValue for unrecognized strings', () => {
      expect(normalizeFlag('maybe', true)).toBe(true);
      expect(normalizeFlag('maybe', false)).toBe(false);
      expect(normalizeFlag('enabled', true)).toBe(true);
      expect(normalizeFlag('disabled', false)).toBe(false);
      expect(normalizeFlag('', true)).toBe(true);
      expect(normalizeFlag('', false)).toBe(false);
    });

    test('converts other types via Boolean()', () => {
      expect(normalizeFlag({}, false)).toBe(true);
      expect(normalizeFlag([], false)).toBe(true);
      expect(normalizeFlag(() => {}, false)).toBe(true);
    });
  });
});
