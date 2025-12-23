import { normalizeFlag, createDeferred, calculateBackoffDelay, sleep, type Deferred } from '@/modules/shared/index.ts';

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

  describe('createDeferred', () => {
    test('resolve() settles promise with value', async () => {
      const deferred = createDeferred<string>();
      deferred.resolve('hello');
      await expect(deferred.promise).resolves.toBe('hello');
    });

    test('reject() settles promise with error', async () => {
      const deferred = createDeferred<string>();
      const error = new Error('test error');
      deferred.reject(error);
      await expect(deferred.promise).rejects.toBe(error);
    });

    test('works with void type (default)', async () => {
      const deferred = createDeferred();
      deferred.resolve();
      await expect(deferred.promise).resolves.toBeUndefined();
    });

    test('works with number type', async () => {
      const deferred = createDeferred<number>();
      deferred.resolve(42);
      await expect(deferred.promise).resolves.toBe(42);
    });

    test('works with object type', async () => {
      const deferred = createDeferred<{ name: string }>();
      const obj = { name: 'test' };
      deferred.resolve(obj);
      await expect(deferred.promise).resolves.toBe(obj);
    });

    test('multiple deferreds are independent', async () => {
      const deferred1 = createDeferred<string>();
      const deferred2 = createDeferred<string>();

      deferred1.resolve('first');
      deferred2.resolve('second');

      await expect(deferred1.promise).resolves.toBe('first');
      await expect(deferred2.promise).resolves.toBe('second');
    });

    test('resolving before await still works', async () => {
      const deferred = createDeferred<string>();
      deferred.resolve('early');
      // Wait a tick to ensure resolution happened
      await new Promise(r => setTimeout(r, 0));
      await expect(deferred.promise).resolves.toBe('early');
    });

    test('rejecting before await still works', async () => {
      const deferred = createDeferred<string>();
      const error = new Error('early error');
      // Attach a no-op catch handler to prevent unhandled rejection warning
      deferred.promise.catch(() => {});
      deferred.reject(error);
      // Wait a tick to ensure rejection happened
      await new Promise(r => setTimeout(r, 0));
      await expect(deferred.promise).rejects.toBe(error);
    });

    test('reject() with string reason', async () => {
      const deferred = createDeferred<void>();
      deferred.promise.catch(() => {});
      deferred.reject('string reason');
      await expect(deferred.promise).rejects.toBe('string reason');
    });

    test('reject() with undefined reason', async () => {
      const deferred = createDeferred<void>();
      deferred.promise.catch(() => {});
      deferred.reject();
      await expect(deferred.promise).rejects.toBeUndefined();
    });

    test('returns Deferred interface shape', () => {
      const deferred: Deferred<string> = createDeferred<string>();
      expect(typeof deferred.promise).toBe('object');
      expect(deferred.promise instanceof Promise).toBe(true);
      expect(typeof deferred.resolve).toBe('function');
      expect(typeof deferred.reject).toBe('function');
    });
  });

  describe('calculateBackoffDelay', () => {
    test('returns base delay for first attempt', () => {
      // With jitter, result should be between baseDelay * 0.75 and baseDelay * 1.25
      const delay = calculateBackoffDelay(0, 250, 30000);
      expect(delay).toBeGreaterThanOrEqual(187); // 250 * 0.75 (floored)
      expect(delay).toBeLessThanOrEqual(312); // 250 * 1.25 (floored, jitter < 1.25)
    });

    test('increases exponentially with attempts', () => {
      // Attempt 1: base * 2 = 500ms (with jitter: 375-625)
      const delay1 = calculateBackoffDelay(1, 250, 30000);
      expect(delay1).toBeGreaterThanOrEqual(375);
      expect(delay1).toBeLessThanOrEqual(625);

      // Attempt 2: base * 4 = 1000ms (with jitter: 750-1250)
      const delay2 = calculateBackoffDelay(2, 250, 30000);
      expect(delay2).toBeGreaterThanOrEqual(750);
      expect(delay2).toBeLessThanOrEqual(1250);
    });

    test('caps at max delay', () => {
      // Very high attempt should be capped at maxDelay (with jitter: maxDelay * 0.75 to maxDelay * 1.25)
      const delay = calculateBackoffDelay(20, 250, 1000);
      expect(delay).toBeGreaterThanOrEqual(750); // 1000 * 0.75
      expect(delay).toBeLessThanOrEqual(1250); // 1000 * 1.25
    });
  });

  describe('sleep', () => {
    test('waits for specified duration', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });
  });
});
