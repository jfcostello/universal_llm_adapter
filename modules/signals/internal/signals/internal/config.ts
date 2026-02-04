import type { AdapterLogger, DefaultSettings, SignalsSpec, SignalsTargetSpec } from '../../../../../kernel/index.js';
import { getNoopLogger } from '../../../../../kernel/index.js';

import { clampInt, normalizeFlag, readTrimmedStringProperty } from '../../../../shared/index.js';

export type SignalsExporterConfig = {
  flushAt: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  maxAttributeValueBytes: number;
};

export type SignalsTargetConfig = SignalsTargetSpec;

export type SignalsTargetExporterConfig = SignalsExporterConfig & {
  provider: string;
  providerConfig?: Record<string, unknown>;
  logger?: AdapterLogger;
};

export type SignalsResolvedConfig = SignalsExporterConfig & {
  targets: SignalsTargetConfig[];
  logger: AdapterLogger;
};

function normalizeTargets(targets: unknown): SignalsTargetConfig[] {
  if (!Array.isArray(targets)) return [];
  return targets
    .map(t => {
      const provider = typeof (t as any)?.provider === 'string' ? String((t as any).provider).trim() : '';
      if (!provider) return null;
      const providerConfig = (t as any)?.providerConfig;
      return providerConfig !== undefined ? { provider, providerConfig } : { provider };
    })
    .filter((t): t is SignalsTargetConfig => Boolean(t));
}

function parseTargetsFromCsv(raw: string): SignalsTargetConfig[] {
  const parts = raw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  return parts.map(provider => ({ provider }));
}

function parseTargetsFromEnv(raw: string): SignalsTargetConfig[] {
  const trimmed = raw.trim();

  if (trimmed.startsWith('[')) {
    try {
      return normalizeTargets(JSON.parse(trimmed));
    } catch {
      return parseTargetsFromCsv(trimmed);
    }
  }

  return parseTargetsFromCsv(trimmed);
}

export function resolveConfig(
  spec: SignalsSpec | undefined,
  defaults: DefaultSettings['signals'],
  logger: AdapterLogger = getNoopLogger()
): SignalsResolvedConfig | null {
  const env = process.env;

  const envEnabledRaw = readTrimmedStringProperty(env, 'LLM_ADAPTER_SIGNALS_ENABLED');
  const envEnabled = envEnabledRaw !== undefined ? normalizeFlag(envEnabledRaw, defaults.enabled) : undefined;

  const enabled = spec?.enabled ?? envEnabled ?? defaults.enabled;
  if (!enabled) return null;

  const envTargetsRaw = readTrimmedStringProperty(env, 'LLM_ADAPTER_SIGNALS_TARGETS');
  const envTargets = envTargetsRaw !== undefined ? parseTargetsFromEnv(envTargetsRaw) : undefined;

  const targets = normalizeTargets(spec?.targets ?? envTargets ?? defaults.targets);
  if (targets.length === 0) {
    logger.warning('Signals disabled: no targets configured', { targets: [] });
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
    defaults.maxAttributeValueBytes ?? 16384,
    256,
    1_000_000
  );

  return {
    targets,
    logger,
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
