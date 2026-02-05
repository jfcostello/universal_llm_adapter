import type {
  AdapterLogger,
  ObservabilityRecordResult,
  ObservabilitySignalLevel,
  ObservabilitySpec,
  PluginRegistry
} from '../../../kernel/index.js';

import { redactJsonCredentials } from '../../security/index.js';
import { createObservabilityRuntime } from './runtime.js';

export type TelemetrySubmissionPayload =
  | {
      type: 'signal';
      traceId: string;
      generationId?: string;
      timestampMs?: number;
      level: ObservabilitySignalLevel;
      message: string;
      source?: string;
      code?: string;
      stack?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      observability?: ObservabilitySpec;
    }
  | {
      type: 'trace_update';
      traceId: string;
      generationId?: string;
      timestampMs?: number;
      name?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      observability?: ObservabilitySpec;
    };

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTimestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return Date.now();
}

export async function submitTelemetry(
  registry: PluginRegistry,
  payload: TelemetrySubmissionPayload,
  options: {
    logger?: AdapterLogger;
    runtime?: { batchId?: unknown };
  } = {}
): Promise<ObservabilityRecordResult & { traceId: string }> {
  const traceId = readTrimmedString((payload as any)?.traceId) ?? '';
  if (!traceId) {
    return { traceId: '', eventId: '', queued: false, reason: 'invalid_trace_id' };
  }
  const generationId = readTrimmedString((payload as any)?.generationId);
  const timestampMs = normalizeTimestampMs((payload as any)?.timestampMs);
  const metadata = payload.metadata ? (redactJsonCredentials(payload.metadata) as Record<string, unknown>) : undefined;

  const spec: ObservabilitySpec = {
    ...(payload.observability && typeof payload.observability === 'object' ? payload.observability : {}),
    traceId
  };

  const runtimeObs = await createObservabilityRuntime(registry, spec, {
    metadata,
    runtime: options.runtime,
    logger: options.logger,
    sessionIdFallback: 'batch'
  });

  if (!runtimeObs) {
    return { traceId, eventId: '', queued: false, reason: 'disabled' };
  }

  const sessionId = runtimeObs.sessionId;

  if (payload.type === 'signal') {
    const result = runtimeObs.exporter.recordSignal({
      traceId,
      ...(generationId ? { generationId } : {}),
      ...(sessionId ? { sessionId } : {}),
      timestampMs,
      level: payload.level,
      message: payload.message,
      ...(payload.source ? { source: payload.source } : { source: 'client' }),
      ...(payload.code ? { code: payload.code } : {}),
      ...(payload.stack ? { stack: payload.stack } : {}),
      ...(payload.tags ? { tags: payload.tags } : {}),
      ...(metadata ? { metadata } : {})
    } as any);

    return { traceId, ...result };
  }

  const result = runtimeObs.exporter.recordTraceUpdate({
    traceId,
    ...(generationId ? { generationId } : {}),
    ...(sessionId ? { sessionId } : {}),
    timestampMs,
    ...(payload.name ? { name: payload.name } : {}),
    ...(payload.tags ? { tags: payload.tags } : {}),
    ...(metadata ? { metadata } : {})
  } as any);

  return { traceId, ...result };
}
