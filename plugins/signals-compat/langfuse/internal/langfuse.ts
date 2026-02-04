import type {
  ISignalsCompat,
  SignalEvent,
  SignalsBatchResult,
  SignalsCompatContext,
  SignalsProviderManifest
} from '../../../../kernel/index.js';
import { safeJsonStringify, readTrimmedStringProperty } from '../../../../modules/shared/index.js';
import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex, sendOtlpTraceSpans } from '../../../../modules/observability/index.js';

import {
  buildBasicAuthHeader,
  getEnvelopeId,
  getEventIds,
  getStringArrayMetadata,
  resolveIngestionUrl
} from '../../../observability-compat/langfuse/index.js';

const DEFAULT_EVENT_NAME = 'signal.event';

type LangfuseObservationLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

function toLangfuseLevel(level: unknown): LangfuseObservationLevel {
  const raw = String(level).trim().toLowerCase();
  if (raw === 'debug') return 'DEBUG';
  if (raw === 'warning') return 'WARNING';
  if (raw === 'error') return 'ERROR';
  return 'DEFAULT';
}

function truncateUtf8(value: string, maxBytes: number): string {
  const str = value;
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;

  // Binary search prefix length by UTF-16 code units (good enough for truncation).
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = str.slice(0, mid);
    if (Buffer.byteLength(slice, 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, lo);
}

function isSignalEvent(event: any): event is SignalEvent {
  return !!event &&
    typeof event === 'object' &&
    typeof event.traceId === 'string' &&
    typeof event.generationId === 'string' &&
    typeof event.timestampMs === 'number' &&
    Number.isFinite(event.timestampMs) &&
    typeof event.message === 'string' &&
    typeof event.level === 'string';
}

export class LangfuseSignalsCompat implements ISignalsCompat {
  buildBatch(
    events: unknown[],
    _manifest: SignalsProviderManifest,
    context?: SignalsCompatContext
  ): { payload: { spans: OtlpSpanSpec[] }; eventIndexByEnvelopeId: Map<string, number> } {
    const eventIds = getEventIds(context as any);
    const spans: OtlpSpanSpec[] = [];
    const eventIndexByEnvelopeId = new Map<string, number>();

    const maxBytes = typeof context?.maxAttributeValueBytes === 'number' && Number.isFinite(context.maxAttributeValueBytes)
      ? Math.max(0, Math.floor(context.maxAttributeValueBytes))
      : 16384;

    for (let i = 0; i < events.length; i++) {
      const event = events[i] as any;
      if (!isSignalEvent(event)) continue;

      const envelopeId = getEnvelopeId(
        eventIds,
        i,
        event.generationId ? String(event.generationId) : `signal-${i}`
      );

      const metadata = event.metadata;
      const correlationId = readTrimmedStringProperty(metadata, 'correlationId');
      const batchId = readTrimmedStringProperty(metadata, 'batchId');
      const sessionId = readTrimmedStringProperty(metadata, 'sessionId');
      const traceTags = getStringArrayMetadata(metadata, 'tags');

      const tsIso = new Date(event.timestampMs).toISOString();
      const statusMessage = truncateUtf8(event.message, maxBytes);

      const level = toLangfuseLevel(event.level);
      const spanStatus =
        level === 'ERROR'
          ? { code: 'ERROR' as const, message: statusMessage || 'error' }
          : { code: 'OK' as const };

      spans.push({
        traceIdHex: deriveOtlpTraceIdHex(String(event.traceId)),
        spanIdHex: deriveOtlpSpanIdHex(envelopeId),
        ...(event.generationId ? { parentSpanIdHex: deriveOtlpSpanIdHex(String(event.generationId)) } : {}),
        name: DEFAULT_EVENT_NAME,
        startTimeIso: tsIso,
        endTimeIso: tsIso,
        status: spanStatus,
        attributes: {
          'llm.adapter.trace_id': String(event.traceId),
          ...(sessionId ? { 'langfuse.session.id': sessionId, 'llm.adapter.session_id': sessionId } : {}),
          ...(correlationId ? { 'langfuse.trace.name': correlationId, 'llm.adapter.correlation_id': correlationId } : {}),
          ...(batchId ? { 'llm.adapter.batch_id': batchId } : {}),
          ...(traceTags ? { 'langfuse.trace.tags': traceTags } : {}),
          'langfuse.observation.type': 'event',
          'langfuse.observation.level': level,
          'langfuse.observation.status_message': statusMessage,
          'langfuse.observation.input': safeJsonStringify(
            {
              code: event.code,
              tags: event.tags,
              metadata: event.metadata
            },
            { maxBytes }
          ),
          'langfuse.observation.output': safeJsonStringify(
            {
              message: event.message,
              stack: event.stack
            },
            { maxBytes }
          )
        },
        envelopeId
      });

      eventIndexByEnvelopeId.set(envelopeId, i);
    }

    return {
      payload: { spans },
      eventIndexByEnvelopeId
    };
  }

  async sendBatch(
    payload: unknown,
    manifest: SignalsProviderManifest,
    context?: SignalsCompatContext
  ): Promise<SignalsBatchResult> {
    const spans = Array.isArray((payload as any)?.spans) ? ((payload as any).spans as OtlpSpanSpec[]) : [];
    if (spans.length === 0) {
      return { success: true, outcomes: [] };
    }

    const url = resolveIngestionUrl(manifest as any, context as any);
    const headers: Record<string, string> = {
      ...(manifest.endpoint.headers ?? {}),
      Authorization: buildBasicAuthHeader(manifest as any),
      'Content-Type': 'application/x-protobuf'
    };

    return await sendOtlpTraceSpans({
      spans,
      url,
      headers,
      timeoutMs: context?.timeoutMs,
      maxBatchBytes: manifest.limits?.maxBatchBytes,
      signal: context?.signal
    }) as any;
  }
}

export default LangfuseSignalsCompat;
