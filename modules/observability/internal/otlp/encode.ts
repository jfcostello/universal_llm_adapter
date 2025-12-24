import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { OtlpSpanSpec } from './types.js';
import { createReadableSpanFromSpec } from './spans.js';

export function encodeOtlpTraceRequest(spans: OtlpSpanSpec[]): Uint8Array {
  const readable = spans.map(createReadableSpanFromSpec);
  return ProtobufTraceSerializer.serializeRequest(readable as any) as Uint8Array;
}

