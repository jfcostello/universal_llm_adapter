import type { Link, SpanContext, SpanStatus } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { isoToOtlpHrTime } from './time.js';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from './ids.js';
import type { OtlpSpanSpec } from './types.js';

function statusCodeToOtel(code: OtlpSpanSpec['status']): SpanStatusCode {
  const raw = code?.code;
  if (raw === 'OK') return SpanStatusCode.OK;
  if (raw === 'ERROR') return SpanStatusCode.ERROR;
  return SpanStatusCode.UNSET;
}

const DEFAULT_RESOURCE = new Resource({
  'service.name': 'universal-llm-adapter'
});

const DEFAULT_INSTRUMENTATION_LIBRARY = {
  name: 'universal-llm-adapter/observability'
} as const;

export function createReadableSpanFromSpec(spec: OtlpSpanSpec): ReadableSpan {
  const traceIdHex = deriveOtlpTraceIdHex(String(spec.traceIdHex));
  const spanIdHex = deriveOtlpSpanIdHex(String(spec.spanIdHex));
  const parentSpanIdHex = spec.parentSpanIdHex ? deriveOtlpSpanIdHex(String(spec.parentSpanIdHex)) : undefined;

  const ctx: SpanContext = {
    traceId: traceIdHex,
    spanId: spanIdHex,
    traceFlags: 1,
    isRemote: false
  } as any;

  const status: SpanStatus = {
    code: statusCodeToOtel(spec.status),
    message: spec.status?.message ? String(spec.status.message) : undefined
  };

  const startTime = isoToOtlpHrTime(spec.startTimeIso) as any;
  const endTime = isoToOtlpHrTime(spec.endTimeIso) as any;

  let durationSeconds = endTime[0] - startTime[0];
  let durationNanos = endTime[1] - startTime[1];
  if (durationNanos < 0) {
    durationSeconds -= 1;
    durationNanos += 1_000_000_000;
  }
  if (durationSeconds < 0) {
    durationSeconds = 0;
    durationNanos = 0;
  }

  const readable: ReadableSpan = {
    name: String(spec.name),
    kind: 2 as any, // CLIENT
    spanContext: () => ctx,
    parentSpanId: parentSpanIdHex,
    startTime,
    endTime,
    status,
    attributes: (spec.attributes ?? {}) as any,
    links: [] as Link[],
    events: [] as TimedEvent[],
    duration: [durationSeconds, durationNanos] as any,
    ended: true,
    resource: DEFAULT_RESOURCE,
    instrumentationLibrary: DEFAULT_INSTRUMENTATION_LIBRARY as any,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0
  };

  return readable;
}
