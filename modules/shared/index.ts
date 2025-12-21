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
