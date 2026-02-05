import { randomUUID } from 'crypto';

import type { AdapterLogger, ObservabilityContext, ObservabilitySpec, PluginRegistry } from '../../../kernel/index.js';
import { getDefaults } from '../../../kernel/index.js';
import { clampInt, clampRate, readTrimmedStringProperty } from '../../shared/index.js';
import { createObservabilityDeps } from './observability.js';

export type ObservabilityRuntime = Omit<ObservabilityContext, 'traceId'> & {
  /**
   * Base trace id for this logical workflow.
   *
   * For single-call workflows this is the trace id.
   * For multi-turn workflows (e.g. realtime), callers may derive per-turn trace ids from this base.
   */
  baseTraceId: string;
};

function normalizeCaptureMessages(
  value: unknown,
  fallback: 'none' | 'text' | 'full'
): 'none' | 'text' | 'full' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'none' || raw === 'text' || raw === 'full') return raw;
  return fallback;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export async function createObservabilityRuntime(
  registry: PluginRegistry,
  spec?: ObservabilitySpec,
  options: {
    metadata?: Record<string, unknown>;
    runtime?: { batchId?: unknown };
    logger?: AdapterLogger;
    sessionIdFallback?: 'batch' | 'correlation' | 'auto';
  } = {}
): Promise<ObservabilityRuntime | undefined> {
  const defaults = getDefaults().observability;

  const enabled = spec?.enabled ?? defaults.enabled;
  if (!enabled) return undefined;

  const captureMessages = normalizeCaptureMessages(spec?.captureMessages, defaults.captureMessages);
  const captureToolArgs = normalizeBool(spec?.captureToolArgs, defaults.captureToolArgs);
  const captureRequestPayload = normalizeBool(spec?.captureRequestPayload, defaults.captureRequestPayload);
  const captureRawResponse = normalizeBool(spec?.captureRawResponse, defaults.captureRawResponse);
  const sampleRate = clampRate(spec?.sampleRate, defaults.sampleRate);
  const maxInputTextBytes = clampInt(spec?.maxInputTextBytes, defaults.maxInputTextBytes, 0, 1_000_000);
  const maxOutputTextBytes = clampInt(spec?.maxOutputTextBytes, defaults.maxOutputTextBytes, 0, 1_000_000);
  const maxJsonBytes = clampInt(spec?.maxJsonBytes, defaults.maxJsonBytes, 0, 5_000_000);

  // Sampling: if disabled or this call is not selected, skip observability entirely.
  if (sampleRate <= 0) return undefined;
  if (sampleRate < 1 && Math.random() >= sampleRate) return undefined;

  const obsDeps = await createObservabilityDeps(registry, spec, options.logger);
  if (!obsDeps.isEnabled()) return undefined;

  const exporter = obsDeps.getExporter();
  const metadata = options.metadata;

  const correlationId = readTrimmedStringProperty(metadata, 'correlationId');
  const baseTraceId = spec?.traceId ?? correlationId ?? randomUUID();

  const batchId = readTrimmedStringProperty(metadata, 'batchId');
  const runtimeBatchId = options.runtime?.batchId !== undefined ? String(options.runtime.batchId) : undefined;
  const envBatchId = readTrimmedStringProperty(process.env, 'LLM_ADAPTER_BATCH_ID');
  const sessionIdFallback = options.sessionIdFallback ?? 'batch';

  const sessionId =
    spec?.sessionId ??
    batchId ??
    (sessionIdFallback === 'batch'
      ? (runtimeBatchId || envBatchId)
      : sessionIdFallback === 'correlation'
        ? (correlationId || runtimeBatchId || envBatchId)
        : (correlationId || runtimeBatchId || envBatchId));

  return {
    exporter,
    baseTraceId,
    sessionId,
    metadata: metadata as any,
    captureMessages,
    captureToolArgs,
    captureRequestPayload,
    captureRawResponse,
    sampleRate,
    maxInputTextBytes,
    maxOutputTextBytes,
    maxJsonBytes
  };
}
