import { jest } from '@jest/globals';
import {
  normalizeFlag,
  parseNonNegativeInt,
  assertValidExtensionName,
  readTrimmedStringProperty,
  makeHttpError,
  createDeferred,
  calculateBackoffDelay,
  sleep,
  sleepWithSignal,
  setUnrefTimeout,
  monotonicNowNs,
  monotonicElapsedMs,
  deriveObservabilityModel,
  truncateUtf8Bytes,
  safeJsonStringify,
  flattenPrimitiveStrings,
  isPlainObject,
  emitManifestOverrideWarning,
  validateE164,
  clampInt,
  type Deferred,
  type ValidateE164Result
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

  describe('parseNonNegativeInt', () => {
    test('returns defaultValue for null and undefined', () => {
      expect(parseNonNegativeInt(null, 5)).toBe(5);
      expect(parseNonNegativeInt(undefined, 5)).toBe(5);
    });

    test('coerces numbers by flooring and clamping to >= 0', () => {
      expect(parseNonNegativeInt(0, 5)).toBe(0);
      expect(parseNonNegativeInt(3.9, 5)).toBe(3);
      expect(parseNonNegativeInt(-1, 5)).toBe(0);
    });

    test('returns defaultValue for non-finite numbers', () => {
      expect(parseNonNegativeInt(Number.NaN, 5)).toBe(5);
      expect(parseNonNegativeInt(Number.POSITIVE_INFINITY, 5)).toBe(5);
      expect(parseNonNegativeInt(Number.NEGATIVE_INFINITY, 5)).toBe(5);
    });

    test('parses strings via parseInt and clamps negatives', () => {
      expect(parseNonNegativeInt('7', 5)).toBe(7);
      expect(parseNonNegativeInt('7.9', 5)).toBe(7);
      expect(parseNonNegativeInt('-2', 5)).toBe(0);
      expect(parseNonNegativeInt('nope', 5)).toBe(5);
    });
  });

  describe('clampInt', () => {
    test('coerces numbers and clamps to the provided range', () => {
      expect(clampInt(0, 5, 1, 10)).toBe(1);
      expect(clampInt(3.9, 5, 1, 10)).toBe(3);
      expect(clampInt(11, 5, 1, 10)).toBe(10);
      expect(clampInt(-5, 5, 1, 10)).toBe(1);
    });

    test('accepts numeric strings and floors', () => {
      expect(clampInt('7', 5, 1, 10)).toBe(7);
      expect(clampInt('7.9', 5, 1, 10)).toBe(7);
    });

    test('falls back for non-finite values and invalid strings', () => {
      expect(clampInt(Number.NaN, 5, 1, 10)).toBe(5);
      expect(clampInt(Number.POSITIVE_INFINITY, 5, 1, 10)).toBe(5);
      expect(clampInt(Number.NEGATIVE_INFINITY, 5, 1, 10)).toBe(5);
      expect(clampInt('nope', 5, 1, 10)).toBe(5);
    });
  });

  describe('assertValidExtensionName', () => {
    test('returns trimmed value when valid', () => {
      expect(assertValidExtensionName('voice')).toBe('voice');
      expect(assertValidExtensionName(' voice ')).toBe('voice');
      expect(assertValidExtensionName('a')).toBe('a');
      expect(assertValidExtensionName('a0')).toBe('a0');
      expect(assertValidExtensionName('a-b_c')).toBe('a-b_c');
    });

    test('throws for invalid values', () => {
      expect(() => assertValidExtensionName('')).toThrow('Invalid extension name: empty');
      expect(() => assertValidExtensionName('   ')).toThrow('Invalid extension name: empty');
      expect(() => assertValidExtensionName(null)).toThrow('Invalid extension name: empty');
      expect(() => assertValidExtensionName(123)).toThrow('Invalid extension name: empty');
      expect(() => assertValidExtensionName('Voice')).toThrow("Invalid extension name: 'Voice'");
      expect(() => assertValidExtensionName('1a')).toThrow("Invalid extension name: '1a'");
      expect(() => assertValidExtensionName('a/b')).toThrow("Invalid extension name: 'a/b'");
    });
  });

  describe('readTrimmedStringProperty', () => {
    test('returns undefined for missing/invalid values', () => {
      expect(readTrimmedStringProperty(null, 'k')).toBeUndefined();
      expect(readTrimmedStringProperty(undefined, 'k')).toBeUndefined();
      expect(readTrimmedStringProperty('nope', 'k')).toBeUndefined();
      expect(readTrimmedStringProperty({}, 'k')).toBeUndefined();
      expect(readTrimmedStringProperty({ k: 123 }, 'k')).toBeUndefined();
      expect(readTrimmedStringProperty({ k: '   ' }, 'k')).toBeUndefined();
    });

    test('returns trimmed string when present', () => {
      expect(readTrimmedStringProperty({ k: '  value  ' }, 'k')).toBe('value');
      expect(readTrimmedStringProperty({ k: 'value' }, 'k')).toBe('value');
    });
  });

  describe('makeHttpError', () => {
    test('sets statusCode and code when provided', () => {
      const err: any = makeHttpError({ message: 'nope', statusCode: 401, code: 'unauthorized' });
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('nope');
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe('unauthorized');
    });

    test('sets statusCode without forcing code', () => {
      const err: any = makeHttpError({ message: 'bad', statusCode: 500 });
      expect(err.statusCode).toBe(500);
      expect(err.code).toBeUndefined();
    });

    test('normalizes nullish message inputs', () => {
      const err: any = makeHttpError({ message: undefined as any, statusCode: 400, code: 'x' });
      expect(err.message).toBe('');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('x');
    });
  });

  describe('deriveObservabilityModel', () => {
    test('returns the base model when no provider hint is present', () => {
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm' })).toBe('m');
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm', providerHint: {} })).toBe('m');
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm', providerHint: { provider: 123 } })).toBe('m');
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm', providerHint: { provider: '   ' } })).toBe('m');
    });

    test('treats blank providerHint strings as missing', () => {
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm', providerHint: '   ' })).toBe('m');
    });

    test('prefixes the model with the upstream provider when the hint differs from the configured provider', () => {
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm', providerHint: { provider: 'upstream' } }))
        .toBe('upstream/m');
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm', providerHint: 'upstream' }))
        .toBe('upstream/m');
    });

    test('normalizes non-string provider/model inputs via String()', () => {
      expect(deriveObservabilityModel({ provider: 123 as any, model: 'm', providerHint: { provider: 'upstream' } }))
        .toBe('upstream/m');
      expect(deriveObservabilityModel({ provider: null as any, model: 'm', providerHint: { provider: 'upstream' } }))
        .toBe('upstream/m');
      expect(deriveObservabilityModel({ provider: 'proxy', model: 123 as any, providerHint: { provider: 'upstream' } }))
        .toBe('upstream/123');
      expect(deriveObservabilityModel({ provider: 'proxy', model: null as any, providerHint: { provider: 'upstream' } }))
        .toBe('upstream/');
    });

    test('does not prefix when the upstream provider equals the configured provider', () => {
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'm', providerHint: { provider: 'proxy' } }))
        .toBe('m');
    });

    test('does not double-prefix when model already includes upstream provider', () => {
      expect(deriveObservabilityModel({ provider: 'proxy', model: 'upstream/m', providerHint: { provider: 'upstream' } }))
        .toBe('upstream/m');
    });
  });

  describe('setUnrefTimeout', () => {
    const originalSetTimeout = globalThis.setTimeout;

    afterEach(() => {
      globalThis.setTimeout = originalSetTimeout;
    });

    test('calls unref() when available', () => {
      const unref = jest.fn();
      const fakeTimeout: any = { unref };
      globalThis.setTimeout = jest.fn(() => fakeTimeout) as any;

      const out = setUnrefTimeout(() => {}, 10);
      expect(out).toBe(fakeTimeout);
      expect(unref).toHaveBeenCalledTimes(1);
    });

    test('ignores missing unref()', () => {
      const fakeTimeout: any = {};
      globalThis.setTimeout = jest.fn(() => fakeTimeout) as any;

      const out = setUnrefTimeout(() => {}, 10);
      expect(out).toBe(fakeTimeout);
    });

    test('ignores unref() exceptions', () => {
      const unref = jest.fn(() => {
        throw new Error('boom');
      });
      const fakeTimeout: any = { unref };
      globalThis.setTimeout = jest.fn(() => fakeTimeout) as any;

      const out = setUnrefTimeout(() => {}, 10);
      expect(out).toBe(fakeTimeout);
      expect(unref).toHaveBeenCalledTimes(1);
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

  describe('isPlainObject', () => {
    test('returns true for Object and null-prototype objects', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
      expect(isPlainObject(Object.create(null))).toBe(true);
    });

    test('returns false for non-objects and arrays', () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject('x')).toBe(false);
      expect(isPlainObject(123)).toBe(false);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject([1, 2, 3])).toBe(false);
    });

    test('returns false for class instances', () => {
      class Test {
        public value = 1;
      }
      expect(isPlainObject(new Test())).toBe(false);
      expect(isPlainObject(new Date())).toBe(false);
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

  describe('emitManifestOverrideWarning', () => {
    test('calls warn function with formatted message and data', () => {
      const warn = jest.fn();
      emitManifestOverrideWarning(warn, 'providers', 'test-id', '/path/old.json', '/path/new.json');

      expect(warn).toHaveBeenCalledWith('providers.override', {
        id: 'test-id',
        previous: '/path/old.json',
        next: '/path/new.json'
      });
    });

    test('formats area in message prefix', () => {
      const warn = jest.fn();
      emitManifestOverrideWarning(warn, 'voice.provider_plugins', 'my-provider', '/a.json', '/b.json');

      expect(warn).toHaveBeenCalledWith('voice.provider_plugins.override', expect.any(Object));
    });

    test('does not throw when warn function throws', () => {
      const warn = jest.fn(() => {
        throw new Error('warn failed');
      });

      expect(() => {
        emitManifestOverrideWarning(warn, 'test', 'id', '/old', '/new');
      }).not.toThrow();
    });

    test('passes all data to warn function', () => {
      const warn = jest.fn();
      emitManifestOverrideWarning(warn, 'area', 'my-id', '/previous/path', '/next/path');

      expect(warn).toHaveBeenCalledTimes(1);
      const [message, data] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toBe('area.override');
      expect(data.id).toBe('my-id');
      expect(data.previous).toBe('/previous/path');
      expect(data.next).toBe('/next/path');
    });
  });

  describe('validateE164', () => {
    test('returns ok: true with normalized value for valid E.164 numbers', () => {
      expect(validateE164('+14155551234')).toEqual({ ok: true, value: '+14155551234' });
      expect(validateE164('+442071234567')).toEqual({ ok: true, value: '+442071234567' });
      expect(validateE164('+8613812345678')).toEqual({ ok: true, value: '+8613812345678' });
      expect(validateE164('+12')).toEqual({ ok: true, value: '+12' }); // Minimum: 2 digits (country + 1)
    });

    test('trims whitespace from valid numbers', () => {
      expect(validateE164('  +14155551234  ')).toEqual({ ok: true, value: '+14155551234' });
      expect(validateE164('\t+442071234567\n')).toEqual({ ok: true, value: '+442071234567' });
    });

    test('returns ok: false for empty or missing values', () => {
      const result1 = validateE164('') as { ok: false; error: string };
      expect(result1.ok).toBe(false);
      expect(result1.error).toContain('required');

      const result2 = validateE164(null) as { ok: false; error: string };
      expect(result2.ok).toBe(false);
      expect(result2.error).toContain('required');

      const result3 = validateE164(undefined) as { ok: false; error: string };
      expect(result3.ok).toBe(false);
      expect(result3.error).toContain('required');

      const result4 = validateE164('   ') as { ok: false; error: string };
      expect(result4.ok).toBe(false);
      expect(result4.error).toContain('required');
    });

    test('returns ok: false for numbers without + prefix', () => {
      const result = validateE164('14155551234') as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('E.164');
    });

    test('returns ok: false for numbers starting with +0', () => {
      const result = validateE164('+0123456789') as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('E.164');
    });

    test('returns ok: false for numbers with non-digit characters', () => {
      expect((validateE164('+1-415-555-1234') as { ok: false; error: string }).ok).toBe(false);
      expect((validateE164('+1 415 555 1234') as { ok: false; error: string }).ok).toBe(false);
      expect((validateE164('+1(415)5551234') as { ok: false; error: string }).ok).toBe(false);
      expect((validateE164('+1.415.555.1234') as { ok: false; error: string }).ok).toBe(false);
    });

    test('returns ok: false for numbers exceeding 15 digits', () => {
      // + followed by 16 digits (exceeds E.164 limit of 15)
      const result = validateE164('+1234567890123456') as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('E.164');
    });

    test('accepts maximum length E.164 numbers (15 digits)', () => {
      // + followed by exactly 15 digits
      expect(validateE164('+123456789012345')).toEqual({ ok: true, value: '+123456789012345' });
    });

    test('returns ok: false for just + sign', () => {
      const result = validateE164('+') as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('E.164');
    });

    test('returns ok: false for single digit (need at least 2)', () => {
      const result = validateE164('+1') as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('E.164');
    });

    test('coerces non-string inputs via String()', () => {
      // Number coercion (but still invalid format without +)
      const result = validateE164(14155551234) as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('E.164');
    });

    test('type guard: ValidateE164Result type works correctly', () => {
      const result: ValidateE164Result = validateE164('+14155551234');
      if (result.ok) {
        const _value: string = result.value;
        expect(_value).toBe('+14155551234');
      } else {
        const _error: string = result.error;
        expect(_error).toBeDefined();
      }
    });
  });
});
