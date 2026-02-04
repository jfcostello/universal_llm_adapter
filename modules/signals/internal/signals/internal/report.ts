import type { AdapterLogger, PluginRegistry, SignalEvent, SignalLevel, SignalsRecordResult, SignalsSpec } from '../../../../../kernel/index.js';
import { getNoopLogger } from '../../../../../kernel/index.js';

import { createSignalsDeps } from './create-deps.js';

export type SignalEventInput = {
  traceId: string;
  generationId: string;
  timestampMs?: number;
  level: SignalLevel;
  message: string;
  code?: string;
  stack?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

function createValidationError(message: string): Error {
  const error = new Error(message);
  (error as any).statusCode = 400;
  (error as any).code = 'validation_error';
  return error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeRequiredTrimmedString(value: unknown, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!trimmed) {
    throw createValidationError(`${field} is required`);
  }
  return trimmed;
}

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = typeof value === 'string' ? value.trim() : String(value).trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTimestampMs(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return Date.now();
  }

  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(num)) {
    throw createValidationError('timestampMs must be a number');
  }

  return Math.floor(num);
}

function normalizeLevel(value: unknown): SignalLevel {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'debug' || raw === 'info' || raw === 'warning' || raw === 'error') return raw;
  throw createValidationError('level must be one of: debug, info, warning, error');
}

function normalizeStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw createValidationError(`${field} must be an object`);
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).trim();
    if (!key) continue;
    const val = v === undefined || v === null ? '' : String(v).trim();
    if (!val) continue;
    out[key] = val;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeUnknownRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw createValidationError(`${field} must be an object`);
  }

  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : undefined;
}

export function normalizeSignalEventInput(input: unknown): SignalEvent {
  if (!isPlainObject(input)) {
    throw createValidationError('Event must be an object');
  }

  const code = normalizeOptionalTrimmedString(input.code);
  const stack = normalizeOptionalTrimmedString(input.stack);
  const tags = normalizeStringRecord(input.tags, 'tags');
  const metadata = normalizeUnknownRecord(input.metadata, 'metadata');

  return {
    traceId: normalizeRequiredTrimmedString(input.traceId, 'traceId'),
    generationId: normalizeRequiredTrimmedString(input.generationId, 'generationId'),
    timestampMs: normalizeTimestampMs(input.timestampMs),
    level: normalizeLevel(input.level),
    message: normalizeRequiredTrimmedString(input.message, 'message'),
    ...(code ? { code } : {}),
    ...(stack ? { stack } : {}),
    ...(tags ? { tags } : {}),
    ...(metadata ? { metadata } : {})
  };
}

export async function reportSignal(options: {
  registry: PluginRegistry;
  event: SignalEventInput | SignalEvent | unknown;
  spec?: SignalsSpec;
  logger?: AdapterLogger;
}): Promise<SignalsRecordResult> {
  const logger = options.logger ?? getNoopLogger();
  const deps = await createSignalsDeps(options.registry, options.spec, logger);
  const event = normalizeSignalEventInput(options.event);
  return deps.getExporter().recordSignal(event);
}
