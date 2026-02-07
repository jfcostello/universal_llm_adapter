import { clampInt } from './normalize-number.js';

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function safeSliceByCodeUnits(value: string, end: number): string {
  const safeEnd = Math.max(0, Math.min(value.length, end));
  const prev = value.charCodeAt(safeEnd - 1);
  if (isHighSurrogate(prev)) {
    return value.slice(0, Math.max(0, safeEnd - 1));
  }
  return value.slice(0, safeEnd);
}

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

function isByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function describeByteArray(value: Uint8Array): string {
  const bytes = value.byteLength;
  const label = Buffer.isBuffer(value) ? 'Buffer' : 'Uint8Array';
  return `[${label} ${bytes} bytes]`;
}

export interface SafeJsonStringifyOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
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

export type SafeJsonValueOptions = SafeJsonStringifyOptions;

export function safeJsonValue(value: unknown, options: SafeJsonValueOptions = {}): unknown {
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : null;

  if (maxBytes !== null && maxBytes <= 0) return null;

  let maxDepth = clampInt(options.maxDepth, 6, 0, 25);
  let maxArrayLength = clampInt(options.maxArrayLength, 50, 0, 1000);
  let maxObjectKeys = clampInt(options.maxObjectKeys, 50, 0, 2000);

  let maxStringBytes = maxBytes !== null
    ? Math.min(maxBytes, 4096)
    : 4096;

  for (let attempt = 0; attempt < 6; attempt++) {
    const bounded = boundJsonValue(
      value,
      maxDepth,
      { maxArrayLength, maxObjectKeys, maxStringBytes },
      new WeakSet()
    );

    if (maxBytes === null) return bounded;

    const json = JSON.stringify(bounded);
    if (Buffer.byteLength(json, 'utf8') <= maxBytes) return bounded;

    if (maxDepth <= 0 && maxArrayLength <= 0 && maxObjectKeys <= 0 && maxStringBytes <= 16) {
      break;
    }

    maxDepth = maxDepth <= 0 ? 0 : Math.floor(maxDepth * 0.6);
    maxArrayLength = maxArrayLength <= 0 ? 0 : Math.floor(maxArrayLength * 0.6);
    maxObjectKeys = maxObjectKeys <= 0 ? 0 : Math.floor(maxObjectKeys * 0.6);
    maxStringBytes = Math.max(16, Math.floor(maxStringBytes * 0.6));
  }

  return '[Truncated]';
}

export interface FlattenPrimitiveStringsOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxValues?: number;
}

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
