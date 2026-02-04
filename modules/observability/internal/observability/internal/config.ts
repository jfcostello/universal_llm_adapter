import type { AdapterLogger, DefaultSettings, ObservabilitySpec } from '../../../../../kernel/index.js';
import type { BatchedHttpExporterConfig } from '../../../../batched-http-exporter/index.js';
import { clampInt } from '../../../../shared/index.js';

/**
 * Configuration for the observability exporter.
 *
 * Re-exported as an alias to the shared batched HTTP exporter config.
 */
export type ObservabilityExporterConfig = BatchedHttpExporterConfig;

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
