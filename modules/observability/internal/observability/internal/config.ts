import type { AdapterLogger, DefaultSettings, ObservabilitySpec } from '../../../../../kernel/index.js';

export type ObservabilityTargetExportConfig = {
  traces: boolean;
  tools: boolean;
  signals: boolean;
  traceUpdates: boolean;
};

export type ResolvedObservabilityTarget = {
  provider: string;
  config: ObservabilityExporterConfig;
  export: ObservabilityTargetExportConfig;
};

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

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeExportConfig(value: unknown): ObservabilityTargetExportConfig {
  const raw = (value && typeof value === 'object') ? (value as any) : {};
  return {
    traces: normalizeBool(raw.traces, true),
    tools: normalizeBool(raw.tools, true),
    signals: normalizeBool(raw.signals, true),
    traceUpdates: normalizeBool(raw.traceUpdates, true)
  };
}

function readProviderId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

export function resolveTargets(
  spec: ObservabilitySpec | undefined,
  defaults: DefaultSettings['observability'],
  logger: AdapterLogger
): ResolvedObservabilityTarget[] | null {
  const enabled = spec?.enabled ?? defaults.enabled;
  if (!enabled) return null;

  const specProvider = readProviderId(spec?.provider);

  const specTargetsRaw = spec?.targets;
  const specTargets = Array.isArray(specTargetsRaw) ? specTargetsRaw : null;

  const defaultsTargetsRaw = (defaults as any).targets;
  const defaultsTargets = Array.isArray(defaultsTargetsRaw) ? defaultsTargetsRaw : null;

  const rawTargets = specTargets ?? (specProvider ? null : defaultsTargets);
  if (!rawTargets) {
    const single = resolveConfig(spec, defaults, logger);
    if (!single) return null;
    return [
      {
        provider: single.provider,
        config: single,
        export: { traces: true, tools: true, signals: true, traceUpdates: true }
      }
    ];
  }

  const resolved: ResolvedObservabilityTarget[] = [];
  for (const target of rawTargets) {
    const provider = readProviderId((target as any)?.provider);
    if (!provider) continue;

    const maxQueueSize = clampInt((target as any)?.maxQueueSize ?? (spec as any)?.maxQueueSize, defaults.maxQueueSize, 1, 100_000);
    const flushAt = clampInt((target as any)?.flushAt ?? (spec as any)?.flushAt, defaults.flushAt, 1, maxQueueSize);
    const flushIntervalMs = clampInt((target as any)?.flushIntervalMs ?? (spec as any)?.flushIntervalMs, defaults.flushIntervalMs, 250, 3_600_000);
    const maxAttempts = clampInt((target as any)?.maxAttempts ?? (spec as any)?.maxAttempts, defaults.maxAttempts, 1, 20);
    const baseDelayMs = clampInt((target as any)?.baseDelayMs ?? (spec as any)?.baseDelayMs, defaults.baseDelayMs, 0, 300_000);
    const maxDelayMs = clampInt((target as any)?.maxDelayMs ?? (spec as any)?.maxDelayMs, defaults.maxDelayMs, 0, 300_000);
    const timeoutMs = clampInt((target as any)?.timeoutMs ?? (spec as any)?.timeoutMs, defaults.timeoutMs, 250, 300_000);
    const maxAttributeValueBytes = clampInt(
      (target as any)?.maxAttributeValueBytes ?? (spec as any)?.maxAttributeValueBytes,
      (defaults as any).maxAttributeValueBytes ?? 16384,
      256,
      1_000_000
    );

    const providerConfig = (target as any)?.providerConfig;
    const exportCfg = normalizeExportConfig((target as any)?.export);

    resolved.push({
      provider,
      config: {
        provider,
        logger,
        providerConfig: providerConfig && typeof providerConfig === 'object' ? providerConfig : undefined,
        flushAt,
        flushIntervalMs,
        maxQueueSize,
        maxAttempts,
        baseDelayMs,
        maxDelayMs,
        timeoutMs,
        maxAttributeValueBytes
      },
      export: exportCfg
    });
  }

  if (resolved.length === 0) {
    logger.warning('Observability disabled: no valid targets configured', { targets: rawTargets.length });
    return null;
  }

  return resolved;
}
