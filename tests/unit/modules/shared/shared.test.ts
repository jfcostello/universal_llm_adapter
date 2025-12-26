import { jest } from '@jest/globals';
import {
  normalizeFlag,
  createDeferred,
  calculateBackoffDelay,
  sleep,
  sleepWithSignal,
  monotonicNowNs,
  monotonicElapsedMs,
  truncateUtf8Bytes,
  safeJsonStringify,
  flattenPrimitiveStrings,
  type Deferred
} from '@/modules/shared/index.ts';

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

  describe('sleepWithSignal', () => {
    test('returns true immediately for non-positive durations', async () => {
      const ac = new AbortController();
      await expect(sleepWithSignal(0, ac.signal)).resolves.toBe(true);
      await expect(sleepWithSignal(-1, ac.signal)).resolves.toBe(true);
    });

    test('returns true immediately for non-finite durations', async () => {
      const ac = new AbortController();
      await expect(sleepWithSignal(Number.NaN, ac.signal)).resolves.toBe(true);
      await expect(sleepWithSignal(Number.POSITIVE_INFINITY, ac.signal)).resolves.toBe(true);
    });

    test('returns false immediately when signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(sleepWithSignal(50, ac.signal)).resolves.toBe(false);
    });

    test('resolves true after duration elapses when not aborted', async () => {
      jest.useFakeTimers();
      try {
        const ac = new AbortController();
        let resolved: boolean | undefined;
        const promise = sleepWithSignal(100, ac.signal).then(value => {
          resolved = value;
          return value;
        });

        await Promise.resolve();
        expect(resolved).toBeUndefined();

        jest.advanceTimersByTime(100);
        await expect(promise).resolves.toBe(true);
        expect(resolved).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    test('resolves false when aborted during sleep', async () => {
      jest.useFakeTimers();
      try {
        const ac = new AbortController();
        let resolved: boolean | undefined;
        const promise = sleepWithSignal(1000, ac.signal).then(value => {
          resolved = value;
          return value;
        });

        await Promise.resolve();
        expect(resolved).toBeUndefined();

        ac.abort();
        await expect(promise).resolves.toBe(false);
        expect(resolved).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('monotonic timing', () => {
    test('monotonicNowNs returns a bigint and uses process.hrtime.bigint()', () => {
      const spy = jest.spyOn(process.hrtime, 'bigint').mockReturnValueOnce(1234n);
      try {
        expect(monotonicNowNs()).toBe(1234n);
      } finally {
        spy.mockRestore();
      }
    });

    test('monotonicElapsedMs floors nanoseconds to milliseconds and never returns negative', () => {
      expect(monotonicElapsedMs(0n, 0n)).toBe(0);
      expect(monotonicElapsedMs(100n, 99n)).toBe(0);
      expect(monotonicElapsedMs(0n, 999_999n)).toBe(0);
      expect(monotonicElapsedMs(0n, 1_000_000n)).toBe(1);
      expect(monotonicElapsedMs(0n, 1_999_999n)).toBe(1);
      expect(monotonicElapsedMs(0n, 2_000_000n)).toBe(2);
    });

    test('monotonicElapsedMs defaults endNs to monotonicNowNs()', () => {
      const spy = jest.spyOn(process.hrtime, 'bigint').mockReturnValueOnce(2_500_000n);
      try {
        expect(monotonicElapsedMs(0n)).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('truncateUtf8Bytes', () => {
    test('returns input unchanged when within limit', () => {
      expect(truncateUtf8Bytes('hello', 5)).toBe('hello');
      expect(truncateUtf8Bytes('hello', 100)).toBe('hello');
    });

    test('truncates and appends suffix when over limit', () => {
      const out = truncateUtf8Bytes('hello world', 6);
      expect(out).toBe('hel…');
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(6);
    });

    test('does not split surrogate pairs (emoji)', () => {
      const emoji = '🙂'; // 4 bytes in UTF-8
      const input = `${emoji}${emoji}${emoji}`;
      const out = truncateUtf8Bytes(input, 5);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(5);
      expect(out.endsWith('…')).toBe(true);
      // Should not contain the replacement character due to broken UTF-16/UTF-8.
      expect(out.includes('\uFFFD')).toBe(false);
    });

    test('returns empty string for non-positive limits', () => {
      expect(truncateUtf8Bytes('hello', 0)).toBe('');
      expect(truncateUtf8Bytes('hello', -1)).toBe('');
    });

    test('returns suffix-only (or empty) when limit cannot fit any content', () => {
      expect(truncateUtf8Bytes('hello', 3)).toBe('…');
      expect(truncateUtf8Bytes('hello', 2)).toBe('');
    });

    test('coerces non-string inputs and handles nullish values', () => {
      expect(truncateUtf8Bytes(123 as any, 10)).toBe('123');
      expect(truncateUtf8Bytes(null as any, 10)).toBe('');
    });

    test('treats non-finite maxBytes as zero', () => {
      expect(truncateUtf8Bytes('hello', Number.NaN as any)).toBe('');
      expect(truncateUtf8Bytes('hello', Number.POSITIVE_INFINITY as any)).toBe('');
    });
  });

  describe('safeJsonStringify', () => {
    test('serializes values and is safe for BigInt and cycles', () => {
      expect(safeJsonStringify(BigInt(1))).toBe('\"1\"');

      const obj: any = { a: 1 };
      obj.self = obj;
      const out = safeJsonStringify(obj);
      expect(out).toContain('Circular');
      expect(JSON.parse(out).a).toBe(1);
    });

    test('handles symbols, functions, and byte arrays', () => {
      expect(JSON.parse(safeJsonStringify(Symbol('x')))).toContain('Symbol');
      expect(JSON.parse(safeJsonStringify(() => {}))).toContain('=>');

      expect(JSON.parse(safeJsonStringify(new Uint8Array([1, 2, 3])))).toBe('[Uint8Array 3 bytes]');
      expect(JSON.parse(safeJsonStringify(Buffer.from([1, 2, 3])))).toBe('[Buffer 3 bytes]');
    });

    test('respects maxDepth for arrays and objects', () => {
      expect(JSON.parse(safeJsonStringify([1, 2, 3], { maxDepth: 0 }))).toEqual(['[Truncated]']);
      expect(JSON.parse(safeJsonStringify({ a: { b: 1 } }, { maxDepth: 0 }))).toBe('[Truncated]');
    });

    test('bounds output size with maxBytes and appends ellipsis', () => {
      const out = safeJsonStringify({ a: 'x'.repeat(1000) }, { maxBytes: 50 });
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(50);
      expect(out.endsWith('…')).toBe(true);
    });

    test('applies structural limits for arrays and objects', () => {
      const out = safeJsonStringify(
        { a: 1, b: 2, c: 3 },
        { maxObjectKeys: 1 }
      );
      const parsed = JSON.parse(out);
      expect(parsed.a).toBe(1);
      expect(parsed['…']).toBe('+2 keys');

      const outArray = safeJsonStringify([1, 2, 3, 4], { maxArrayLength: 2 });
      expect(JSON.parse(outArray)).toEqual([1, 2, '…']);
    });

    test('returns empty string for non-positive maxBytes', () => {
      expect(safeJsonStringify({ a: 1 }, { maxBytes: 0 })).toBe('');
      expect(safeJsonStringify({ a: 1 }, { maxBytes: -1 })).toBe('');
    });
  });

  describe('flattenPrimitiveStrings', () => {
    test('collects primitives from nested structures', () => {
      const out = flattenPrimitiveStrings({
        a: 'hi',
        b: 2,
        c: true,
        d: null,
        e: ['x', { y: 'z' }]
      });
      expect(out).toContain('hi');
      expect(out).toContain('2');
      expect(out).toContain('true');
      expect(out).toContain('x');
      expect(out).toContain('z');
    });

    test('skips whitespace-only primitives and can halt by maxValues', () => {
      expect(flattenPrimitiveStrings('   ', { maxBytes: 50 })).toBe('');
      expect(flattenPrimitiveStrings(['one', 'two'], { maxValues: 1 })).toBe('one');
      expect(flattenPrimitiveStrings(['one', 'two'], { maxValues: 1, maxBytes: 100 })).toBe('one');
    });

    test('handles byte arrays and depth truncation', () => {
      expect(flattenPrimitiveStrings(new Uint8Array([1, 2, 3]), { maxBytes: 100 })).toContain('Uint8Array');
      expect(flattenPrimitiveStrings([1, 2], { maxDepth: 0, maxBytes: 100 })).toBe('[Truncated]');
      expect(flattenPrimitiveStrings({ a: { b: 1 } }, { maxDepth: 0, maxBytes: 100 })).toBe('[Truncated]');
    });

    test('when there is no remaining budget for the separator, it drops subsequent values', () => {
      expect(flattenPrimitiveStrings(['aaaa', 'bbbb'], { maxBytes: 5 })).toBe('aaaa');
    });

    test('bounds output size with maxBytes and appends ellipsis', () => {
      const out = flattenPrimitiveStrings({ a: 'x'.repeat(1000) }, { maxBytes: 20 });
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20);
      expect(out.endsWith('…')).toBe(true);
    });

    test('returns empty string for non-positive maxBytes', () => {
      expect(flattenPrimitiveStrings('hi', { maxBytes: 0 })).toBe('');
      expect(flattenPrimitiveStrings('hi', { maxBytes: -1 })).toBe('');
    });
  });
});
