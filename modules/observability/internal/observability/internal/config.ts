import type { AdapterLogger, DefaultSettings, ObservabilitySpec } from '../../../../../kernel/index.js';

/**
 * Configuration for the observability exporter.
 */
export interface ObservabilityExporterConfig {
  /** Observability provider ID */
  provider: string;

  /** Structured logger (no-op when omitted) */
  logger?: AdapterLogger;

  /** Provider-specific configuration overrides (opaque to core) */
  providerConfig?: Record<string, unknown>;

  /** Flush when queue reaches this size */
  flushAt: number;

  /** Flush interval in milliseconds */
  flushIntervalMs: number;

  /** Maximum queue size (events dropped if exceeded) */
  maxQueueSize: number;

  /** Maximum retry attempts per batch */
  maxAttempts: number;

  /** Base delay for exponential backoff */
  baseDelayMs: number;

  /** Maximum delay cap for backoff */
  maxDelayMs: number;

  /** HTTP timeout for export requests */
  timeoutMs: number;

  /** Maximum UTF-8 bytes for any exported attribute string value */
  maxAttributeValueBytes?: number;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const normalized = normalizeNumber(value);
  const asInt = Number.isFinite(normalized as any) ? Math.floor(normalized as number) : Math.floor(fallback);
  return Math.min(max, Math.max(min, asInt));
}

/**
 * Resolve observability configuration from spec and defaults.
 */
export function resolveConfig(
  spec: ObservabilitySpec | undefined,
  defaults: DefaultSettings['observability'],
  logger: AdapterLogger
): ObservabilityExporterConfig | null {
  const enabled = spec?.enabled ?? defaults.enabled;

  if (!enabled) {
    return null;
  }

  const provider = spec?.provider ?? defaults.provider;

  if (!provider) {
    logger.warning('Observability disabled: no provider configured', { provider: null });
    return null;
  }

  const maxQueueSize = clampInt(spec?.maxQueueSize, defaults.maxQueueSize, 1, 100_000);
  const flushAt = clampInt(spec?.flushAt, defaults.flushAt, 1, maxQueueSize);
  const flushIntervalMs = clampInt(spec?.flushIntervalMs, defaults.flushIntervalMs, 250, 3_600_000);
  const maxAttempts = clampInt(spec?.maxAttempts, defaults.maxAttempts, 1, 20);
  const baseDelayMs = clampInt(spec?.baseDelayMs, defaults.baseDelayMs, 0, 300_000);
  const maxDelayMs = clampInt(spec?.maxDelayMs, defaults.maxDelayMs, 0, 300_000);
  const timeoutMs = clampInt(spec?.timeoutMs, defaults.timeoutMs, 250, 300_000);
  const maxAttributeValueBytes = clampInt(
    spec?.maxAttributeValueBytes,
    (defaults as any).maxAttributeValueBytes ?? 16384,
    256,
    1_000_000
  );

  return {
    provider,
    logger,
    providerConfig: spec?.providerConfig,
    flushAt,
    flushIntervalMs,
    maxQueueSize,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    timeoutMs,
    maxAttributeValueBytes
  };
}
