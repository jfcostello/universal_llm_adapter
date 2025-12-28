/**
 * Shared utilities module.
 *
 * This module contains small, reusable utility functions that are shared across
 * multiple lazy-loaded modules. Functions here should be:
 * - Small (<30 lines for direct inclusion, <100 lines for internal/ file)
 * - Generic and reusable across multiple modules
 * - Not appropriate for kernel (which is always loaded)
 *
 * @module shared
 */

/**
 * Normalizes a value to a boolean flag with flexible input handling.
 *
 * Accepts:
 * - boolean: returned as-is
 * - number: converted via Boolean()
 * - string: 'true'/'1'/'yes'/'y'/'on' → true, 'false'/'0'/'no'/'n'/'off' → false
 * - null/undefined: returns defaultValue
 * - other: converted via Boolean()
 *
 * @param value - The value to normalize
 * @param defaultValue - Default to return for null/undefined/unrecognized strings
 * @returns The normalized boolean value
 */
export function normalizeFlag(value: unknown, defaultValue: boolean): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Boolean(value);
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
  }
  return Boolean(value);
}

/**
 * Assert a string is a valid extension identifier.
 *
 * Extensions are top-level feature modules (e.g. `extensions/<name>`). This helper is shared
 * between the server and CLI extension hosts.
 */
export function assertValidExtensionName(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error('Invalid extension name: empty');
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(raw)) {
    throw new Error(`Invalid extension name: '${raw}'`);
  }
  return raw;
}

/**
 * Read a trimmed, non-empty string property from an unknown record.
 *
 * @param record - Any object-like value
 * @param key - Property name to read
 * @returns A trimmed string, or `undefined` if missing/blank/not a string
 */
export function readTrimmedStringProperty(record: unknown, key: string): string | undefined {
  const value = (record as any)?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Derive a human-meaningful model identifier for observability exports.
 *
 * When an upstream provider hint is available (e.g. a proxy returns `{ provider: "upstream" }`),
 * the observability model is emitted as `${upstreamProvider}/${model}` so downstream observability
 * providers can disambiguate the true origin of the generation.
 */
export function deriveObservabilityModel(options: {
  /** Configured provider id (the adapter provider) */
  provider: string;
  /** Configured model id from the call spec */
  model: string;
  /**
   * Provider hint string, or an object that contains a `provider` string field (e.g. raw response).
   * Treated as optional and ignored when missing/blank.
   */
  providerHint?: unknown;
}): string {
  const provider = typeof options.provider === 'string' ? options.provider : String(options.provider ?? '');
  const model = typeof options.model === 'string' ? options.model : String(options.model ?? '');

  const upstreamProvider = (() => {
    if (typeof options.providerHint === 'string') {
      const trimmed = options.providerHint.trim();
      return trimmed ? trimmed : undefined;
    }
    return readTrimmedStringProperty(options.providerHint, 'provider');
  })();

  if (!upstreamProvider) return model;
  if (upstreamProvider === provider) return model;
  if (model.startsWith(`${upstreamProvider}/`)) return model;

  return `${upstreamProvider}/${model}`;
}

/**
 * A deferred promise with externally accessible resolve/reject handlers.
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Creates a deferred promise with externally accessible resolve/reject.
 * Equivalent to the ES2024 Promise.withResolvers() API.
 *
 * @example
 * const deferred = createDeferred<string>();
 * setTimeout(() => deferred.resolve('done'), 1000);
 * await deferred.promise; // 'done'
 */
export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Sleep for a specified duration.
 *
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sleep for a specified duration, but resolve early if the signal is aborted.
 *
 * @param ms - Milliseconds to sleep
 * @param signal - Optional AbortSignal to cancel the sleep
 * @returns `true` if the full duration elapsed, `false` if aborted early
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }

  const durationMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (durationMs === 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(true);
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Get a monotonic high-resolution timestamp.
 *
 * This is safe for duration deltas and is not affected by wall-clock changes.
 * Prefer using `Date.now()` for epoch timestamps and `monotonicElapsedMs()` for durations.
 */
export function monotonicNowNs(): bigint {
  return process.hrtime.bigint();
}

/**
 * Compute a monotonic elapsed duration (ms) from a monotonic start timestamp.
 *
 * @param startNs - Start time from `monotonicNowNs()`
 * @param endNs - Optional end time; defaults to `monotonicNowNs()`
 * @returns Elapsed milliseconds (floored), never negative
 */
export function monotonicElapsedMs(startNs: bigint, endNs: bigint = monotonicNowNs()): number {
  const deltaNs = endNs - startNs;
  if (deltaNs <= 0n) return 0;
  return Number(deltaNs / 1_000_000n);
}

/**
 * Calculate delay with exponential backoff and jitter.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @returns Delay in milliseconds with jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap at maxDelayMs
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: +/- 25% randomness
  const jitter = 0.75 + Math.random() * 0.5; // 0.75 to 1.25
  return Math.floor(cappedDelay * jitter);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function safeSliceByCodeUnits(value: string, end: number): string {
  const safeEnd = Math.max(0, Math.min(value.length, end));
  const prev = value.charCodeAt(safeEnd - 1);
  // Avoid cutting between a surrogate pair.
  if (isHighSurrogate(prev)) {
    return value.slice(0, Math.max(0, safeEnd - 1));
  }
  return value.slice(0, safeEnd);
}

/**
 * Truncate a string to a maximum UTF-8 byte length, appending an ellipsis suffix.
 * This is safe for multi-byte characters and avoids splitting surrogate pairs.
 *
 * @param value - Input string
 * @param maxBytes - Maximum UTF-8 bytes to return (including suffix)
 * @returns Truncated string (or original if already within limit)
 */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const input = typeof value === 'string' ? value : String(value ?? '');
  const limit = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0;
  if (limit <= 0) return '';

  if (Buffer.byteLength(input, 'utf8') <= limit) return input;

  const suffix = '…';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (suffixBytes >= limit) {
    return suffixBytes <= limit ? suffix : '';
  }

  const targetBytes = limit - suffixBytes;
  let low = 0;
  let high = input.length;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidate = safeSliceByCodeUnits(input, mid);
    const bytes = Buffer.byteLength(candidate, 'utf8');
    if (bytes <= targetBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const truncated = safeSliceByCodeUnits(input, low);
  return truncated + suffix;
}

export interface SafeJsonStringifyOptions {
  /**
   * Maximum UTF-8 bytes for the returned string. When exceeded, the value is truncated with an ellipsis.
   */
  maxBytes?: number;

  /**
   * Maximum object/array nesting depth to include.
   */
  maxDepth?: number;

  /**
   * Maximum number of array items to include per array.
   */
  maxArrayLength?: number;

  /**
   * Maximum number of object keys to include per object.
   */
  maxObjectKeys?: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function describeByteArray(value: Uint8Array): string {
  const bytes = value.byteLength;
  const label = Buffer.isBuffer(value) ? 'Buffer' : 'Uint8Array';
  return `[${label} ${bytes} bytes]`;
}

function boundJsonValue(
  value: unknown,
  depth: number,
  limits: { maxArrayLength: number; maxObjectKeys: number; maxStringBytes: number },
  seen: WeakSet<object>
): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    return truncateUtf8Bytes(value, limits.maxStringBytes);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);

  if (isByteArray(value)) {
    return describeByteArray(value);
  }

  if (Array.isArray(value)) {
    if (depth <= 0) return ['[Truncated]'];
    const out: unknown[] = [];
    const len = Math.min(value.length, limits.maxArrayLength);
    for (let i = 0; i < len; i++) {
      out.push(boundJsonValue(value[i], depth - 1, limits, seen));
    }
    if (value.length > len) out.push('…');
    return out;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);

    if (depth <= 0) return '[Truncated]';

    const keys = Object.keys(obj);
    const maxKeys = Math.min(keys.length, limits.maxObjectKeys);
    const out: Record<string, unknown> = {};

    for (let i = 0; i < maxKeys; i++) {
      const key = keys[i];
      out[key] = boundJsonValue(obj[key], depth - 1, limits, seen);
    }

    if (keys.length > maxKeys) {
      out['…'] = `+${keys.length - maxKeys} keys`;
    }

    return out;
  }
}

/**
 * JSON.stringify wrapper with cycle/BigInt safety and predictable output bounds.
 * This prevents accidental megabyte-scale stringification when exporting to external sinks.
 */
export function safeJsonStringify(value: unknown, options: SafeJsonStringifyOptions = {}): string {
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : null;

  if (maxBytes !== null && maxBytes <= 0) return '';

  const maxDepth = clampInt(options.maxDepth, 6, 0, 25);
  const maxArrayLength = clampInt(options.maxArrayLength, 50, 0, 1000);
  const maxObjectKeys = clampInt(options.maxObjectKeys, 50, 0, 2000);

  const maxStringBytes = maxBytes !== null
    ? Math.min(maxBytes, 4096)
    : 4096;

  const bounded = boundJsonValue(
    value,
    maxDepth,
    { maxArrayLength, maxObjectKeys, maxStringBytes },
    new WeakSet()
  );

  const json = JSON.stringify(bounded);
  return maxBytes === null ? json : truncateUtf8Bytes(json, maxBytes);
}

export interface FlattenPrimitiveStringsOptions {
  /**
   * Maximum UTF-8 bytes for the returned string. When exceeded, the value is truncated with an ellipsis.
   */
  maxBytes?: number;

  /**
   * Maximum object/array nesting depth to include.
   */
  maxDepth?: number;

  /**
   * Maximum number of primitive values to include.
   */
  maxValues?: number;
}

/**
 * Collects primitive values from a nested structure into a single newline-delimited string.
 * Designed for observability "text summary" fields with strict size caps.
 */
export function flattenPrimitiveStrings(
  value: unknown,
  options: FlattenPrimitiveStringsOptions = {}
): string {
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : null;

  if (maxBytes !== null && maxBytes <= 0) return '';

  const maxDepth = clampInt(options.maxDepth, 10, 0, 50);
  const maxValues = clampInt(
    options.maxValues,
    maxBytes !== null ? Math.max(10, Math.ceil(maxBytes / 8)) : 10_000,
    1,
    100_000
  );

  const newline = '\n';
  const newlineBytes = Buffer.byteLength(newline, 'utf8');
  const out: string[] = [];
  let usedBytes = 0;
  let halted = false;

  const push = (raw: unknown): void => {
    let str = String(raw);
    if (str.trim() === '') return;

    if (maxBytes === null) {
      out.push(str);
      if (out.length >= maxValues) halted = true;
      return;
    }

    const sepBytes = out.length > 0 ? newlineBytes : 0;
    const strBytes = Buffer.byteLength(str, 'utf8');
    const nextBytes = usedBytes + sepBytes + strBytes;

    if (nextBytes <= maxBytes) {
      out.push(str);
      usedBytes = nextBytes;
      if (out.length >= maxValues) halted = true;
      return;
    }

    const remaining = maxBytes - usedBytes - sepBytes;
    if (remaining > 0) {
      str = truncateUtf8Bytes(str, remaining);
      out.push(str);
    }
    usedBytes = maxBytes;
    halted = true;
  };

  const walk = (v: unknown, depth: number): void => {
    if (v === null || v === undefined) return;

    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      push(v);
      return;
    }

    if (isByteArray(v)) {
      push(describeByteArray(v));
      return;
    }

    if (Array.isArray(v)) {
      if (depth <= 0) {
        push('[Truncated]');
        return;
      }
      for (const entry of v) {
        walk(entry, depth - 1);
        if (halted) return;
      }
      return;
    }

    if (typeof v === 'object') {
      if (depth <= 0) {
        push('[Truncated]');
        return;
      }
      for (const entry of Object.values(v as Record<string, unknown>)) {
        walk(entry, depth - 1);
        if (halted) return;
      }
    }
  };

  walk(value, maxDepth);

  const result = out.join(newline);
  return maxBytes === null ? result : truncateUtf8Bytes(result, maxBytes);
}
