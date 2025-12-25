// Observability module public surface.
export * from './internal/observability.js';
export { calculateBackoffDelay, sleep } from '../shared/index.js';

export type { OtlpSpanSpec } from './internal/otlp/types.js';
export { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from './internal/otlp/ids.js';

export async function sendOtlpTraceSpans(options: {
  spans: import('./internal/otlp/types.js').OtlpSpanSpec[];
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBatchBytes?: number;
}): Promise<import('../kernel/index.js').ObservabilityBatchResult> {
  const { sendOtlpTraceSpans } = await import('./internal/otlp/client.js');
  const result = await sendOtlpTraceSpans(options);
  return result;
}
