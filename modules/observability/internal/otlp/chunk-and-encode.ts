import type { OtlpSpanSpec } from './types.js';
import { encodeOtlpTraceRequest } from './encode.js';

export type EncodedOtlpChunk = {
  envelopeIds: string[];
  body: Uint8Array;
  oversize: boolean;
};

function getEnvelopeIds(spans: OtlpSpanSpec[]): string[] {
  return spans
    .map(s => (typeof s.envelopeId === 'string' ? s.envelopeId : ''))
    .filter(Boolean);
}

export function chunkAndEncodeOtlpTraceSpans(
  spans: OtlpSpanSpec[],
  maxBatchBytes: number
): EncodedOtlpChunk[] {
  const body = encodeOtlpTraceRequest(spans);
  const envelopeIds = getEnvelopeIds(spans);
  const fits = body.byteLength <= maxBatchBytes;

  if (fits) {
    return [{ envelopeIds, body, oversize: false }];
  }

  if (spans.length <= 1) {
    return [{ envelopeIds, body, oversize: true }];
  }

  const mid = Math.floor(spans.length / 2);
  const left = spans.slice(0, mid);
  const right = spans.slice(mid);
  return [
    ...chunkAndEncodeOtlpTraceSpans(left, maxBatchBytes),
    ...chunkAndEncodeOtlpTraceSpans(right, maxBatchBytes)
  ];
}

