// Observability module public surface.
export * from './internal/observability.js';
export {
  resolveObservabilityEnabled,
  resolveObservabilityTargetsOverride
} from './internal/env-overrides.js';
export { createObservabilityRuntime } from './internal/runtime.js';
export type { ObservabilityRuntime } from './internal/runtime.js';
export { submitTelemetry } from './internal/telemetry-submit.js';
export type { TelemetrySubmissionPayload } from './internal/telemetry-submit.js';
export { calculateBackoffDelay, sleep } from '../shared/index.js';

export type { OtlpSpanSpec } from './internal/otlp/types.js';
export { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from './internal/otlp/ids.js';

export type { CachedRequestSummary } from './internal/compat-helpers.js';
export {
  resolveMaxAttributeBytes,
  eventTimestampToIso,
  deriveStartTimeIsoFromDuration,
  getStringArrayMetadata,
  resolveTraceContext,
  getEventIds,
  getEnvelopeId,
  isRequestEvent,
  isResponseEvent,
  deriveStartTimeIso,
  cacheKey,
  buildInputJson,
  buildOutputJson,
  buildCachedRequestSummary,
  applyTraceUpdateToCachedRequests
} from './internal/compat-helpers.js';

export async function sendOtlpTraceSpans(options: {
  spans: import('./internal/otlp/types.js').OtlpSpanSpec[];
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBatchBytes?: number;
  signal?: AbortSignal;
}): Promise<import('../../kernel/index.js').ObservabilityBatchResult> {
  const { sendOtlpTraceSpans } = await import('./internal/otlp/client.js');
  const result = await sendOtlpTraceSpans(options);
  return result;
}
