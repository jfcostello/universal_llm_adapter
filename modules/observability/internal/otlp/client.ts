import type { ObservabilityEnvelopeOutcome } from '../../../kernel/index.js';
import type { OtlpSpanSpec } from './types.js';
import { encodeOtlpTraceRequest } from './encode.js';
import { sleep } from '../../../shared/index.js';

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfterMs(headerValue: unknown): number | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.floor(seconds * 1000);
}

function chunkAndEncode(
  spans: OtlpSpanSpec[],
  maxBatchBytes: number
): Array<{ spans: OtlpSpanSpec[]; body: Uint8Array; oversize: boolean }> {
  const body = encodeOtlpTraceRequest(spans);
  const fits = body.byteLength <= maxBatchBytes;

  if (fits) {
    return [{ spans, body, oversize: false }];
  }

  if (spans.length <= 1) {
    return [{ spans, body, oversize: true }];
  }

  const mid = Math.floor(spans.length / 2);
  const left = spans.slice(0, mid);
  const right = spans.slice(mid);
  return [...chunkAndEncode(left, maxBatchBytes), ...chunkAndEncode(right, maxBatchBytes)];
}

export async function sendOtlpTraceSpans(options: {
  spans: OtlpSpanSpec[];
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBatchBytes?: number;
}): Promise<{ success: boolean; outcomes: ObservabilityEnvelopeOutcome[] }> {
  const spans = Array.isArray(options.spans) ? options.spans : [];
  const url = String(options.url);
  const headers = { ...(options.headers ?? {}) };
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : undefined;

  // Conservative default to avoid oversized protobuf exports.
  const maxBatchBytes = typeof options.maxBatchBytes === 'number' && options.maxBatchBytes > 0
    ? Math.floor(options.maxBatchBytes)
    : 3_670_016; // ~3.5 MiB

  if (spans.length === 0) {
    return { success: true, outcomes: [] };
  }

  const chunks = chunkAndEncode(spans, maxBatchBytes);

  const outcomes: ObservabilityEnvelopeOutcome[] = [];
  let overallSuccess = true;

  for (const chunk of chunks) {
    const envelopeIds = chunk.spans
      .map(s => (typeof s.envelopeId === 'string' ? s.envelopeId : ''))
      .filter(Boolean);

    if (chunk.oversize) {
      overallSuccess = false;
      for (const envelopeId of envelopeIds) {
        outcomes.push({
          envelopeId,
          success: false,
          error: `OTLP payload exceeds maxBatchBytes (${maxBatchBytes})`,
          retryable: false
        });
      }
      continue;
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: chunk.body,
        signal: controller.signal
      });

      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      if (res.ok) {
        for (const envelopeId of envelopeIds) {
          outcomes.push({ envelopeId, success: true, status: res.status });
        }
        continue;
      }

      overallSuccess = false;
      const retryable = isRetryableStatus(res.status);
      const statusText = typeof (res as any).statusText === 'string' ? String((res as any).statusText) : '';
      const errorText = statusText ? `HTTP ${res.status}: ${statusText}` : `HTTP ${res.status}`;

      for (const envelopeId of envelopeIds) {
        outcomes.push({
          envelopeId,
          success: false,
          status: res.status,
          error: errorText,
          retryable
        });
      }

      if (res.status === 429) {
        const retryAfterHeader = (res as any)?.headers?.get?.('retry-after');
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
        if (retryAfterMs && retryAfterMs > 0) {
          await sleep(retryAfterMs);
        }
      }
    } catch (error: any) {
      overallSuccess = false;
      const message = (error as Error)?.message ?? String(error);
      for (const envelopeId of envelopeIds) {
        outcomes.push({
          envelopeId,
          success: false,
          error: message,
          retryable: true
        });
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  return {
    success: overallSuccess && outcomes.every(o => o.success),
    outcomes
  };
}
