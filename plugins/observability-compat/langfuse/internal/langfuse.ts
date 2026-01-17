import type {
  IObservabilityCompat,
  ObservabilityProviderManifest,
  ObservabilityBatchResult,
  ObservabilityCompatContext,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent
} from '../../../../kernel/index.js';
import { LruMap } from '../../../../kernel/index.js';
import { safeJsonStringify, flattenPrimitiveStrings, readTrimmedStringProperty } from '../../../../modules/shared/index.js';
import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '../../../../modules/observability/index.js';

import {
  buildBasicAuthHeader,
  buildCachedRequestSummary,
  buildInputJson,
  buildLangfuseCostDetails,
  buildLangfuseUsageDetails,
  buildOutputJson,
  cacheKey,
  deriveStartTimeIso,
  eventTimestampToIso,
  getEnvelopeId,
  getEventIds,
  getStringArrayMetadata,
  isRequestEvent,
  isResponseEvent,
  resolveIngestionUrl
} from './langfuse-helpers.js';
import type { CachedRequest } from './langfuse-helpers.js';

const DEFAULT_SPAN_NAME = 'llm.generation';

const REQUEST_CACHE_TTL_MS = 10 * 60_000;
const REQUEST_CACHE_MAX_ENTRIES = 1000;

export class LangfuseCompat implements IObservabilityCompat {
  private requestCache = new LruMap<string, CachedRequest>(REQUEST_CACHE_MAX_ENTRIES);

  buildBatch(
    events: unknown[],
    _manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): { payload: { spans: OtlpSpanSpec[] }; eventIndexByEnvelopeId: Map<string, number> } {
    const now = Date.now();
    this.pruneRequestCache(now);

    const eventIds = getEventIds(context);
    const spans: OtlpSpanSpec[] = [];
    const eventIndexByEnvelopeId = new Map<string, number>();

    for (let i = 0; i < events.length; i++) {
      const event = events[i] as any;

      if (isRequestEvent(event)) {
        const key = cacheKey(event.traceId, event.generationId);
        this.requestCache.set(key, { summary: buildCachedRequestSummary(event, context), createdAtMs: now });
        continue;
      }

      if (!isResponseEvent(event)) {
        continue;
      }

      const key = cacheKey(event.traceId, event.generationId);
      const cached = this.requestCache.get(key);
      const cachedSummary = cached?.summary;

      const maxBytes = typeof context?.maxAttributeValueBytes === 'number' && Number.isFinite(context.maxAttributeValueBytes) && context.maxAttributeValueBytes > 0
        ? Math.floor(context.maxAttributeValueBytes)
        : 16384;

      const sessionId = cachedSummary?.sessionId
        ? String(cachedSummary.sessionId)
        : event.sessionId
          ? String(event.sessionId)
          : undefined;
      const metadata = event.metadata;
      const correlationId = cachedSummary?.correlationId ?? readTrimmedStringProperty(metadata, 'correlationId');
      const batchId = cachedSummary?.batchId ?? (readTrimmedStringProperty(metadata, 'batchId') ?? sessionId);
      const tags = cachedSummary?.tags ?? getStringArrayMetadata(metadata, 'tags');

      const envelopeId = getEnvelopeId(
        eventIds,
        i,
        event.generationId ? String(event.generationId) : `response-${i}`
      );

      const costDetails = buildLangfuseCostDetails(event.usage);

      spans.push({
        traceIdHex: deriveOtlpTraceIdHex(String(event.traceId)),
        spanIdHex: deriveOtlpSpanIdHex(String(event.generationId || envelopeId)),
        name: DEFAULT_SPAN_NAME,
        startTimeIso: cachedSummary?.startTimeIso ? String(cachedSummary.startTimeIso) : deriveStartTimeIso(event),
        endTimeIso: eventTimestampToIso(event),
        status: event.error
          ? { code: 'ERROR', message: String(event.error.message || 'error') }
          : { code: 'OK' },
        attributes: {
          'llm.adapter.trace_id': String(event.traceId || ''),
          ...(sessionId ? { 'langfuse.session.id': sessionId, 'llm.adapter.session_id': sessionId } : {}),
          ...(correlationId ? { 'langfuse.trace.name': correlationId } : {}),
          ...(tags ? { 'langfuse.trace.tags': tags } : {}),
          ...(correlationId ? { 'llm.adapter.correlation_id': correlationId } : {}),
          ...(batchId ? { 'llm.adapter.batch_id': batchId } : {}),
          'llm.adapter.provider': String(event.provider || cachedSummary?.provider || ''),
          'llm.adapter.input_text': cachedSummary?.inputText ?? '',
          'llm.adapter.output_text': flattenPrimitiveStrings(
            { content: event.content, toolCalls: event.toolCalls ?? [] },
            { maxBytes }
          ),
          'langfuse.observation.type': 'generation',
          'langfuse.observation.input': cachedSummary?.observationInput ?? safeJsonStringify(buildInputJson(undefined), { maxBytes }),
          'langfuse.observation.output': safeJsonStringify(buildOutputJson(event), { maxBytes }),
          'langfuse.observation.model.name': String(event.model || cachedSummary?.model || ''),
          'langfuse.observation.model.parameters': cachedSummary?.modelParameters ?? safeJsonStringify({}, { maxBytes }),
          'langfuse.observation.usage_details': safeJsonStringify(buildLangfuseUsageDetails(event.usage), { maxBytes }),
          ...(costDetails
            ? {
                'langfuse.observation.cost_details': safeJsonStringify(costDetails, { maxBytes }),
                'gen_ai.usage.cost': costDetails.total
              }
            : {})
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

  private pruneRequestCache(nowMs: number): void {
    for (const [key, entry] of this.requestCache.entries()) {
      if (nowMs - entry.createdAtMs > REQUEST_CACHE_TTL_MS) {
        this.requestCache.delete(key);
      }
    }
  }

  async sendBatch(
    payload: unknown,
    manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): Promise<ObservabilityBatchResult> {
    const spans = Array.isArray((payload as any)?.spans) ? ((payload as any).spans as OtlpSpanSpec[]) : [];
    if (spans.length === 0) {
      return { success: true, outcomes: [] };
    }

    const url = resolveIngestionUrl(manifest, context);
    const headers: Record<string, string> = {
      ...(manifest.endpoint.headers ?? {}),
      Authorization: buildBasicAuthHeader(manifest),
      'Content-Type': 'application/x-protobuf'
    };

    const { sendOtlpTraceSpans } = await import('../../../../modules/observability/index.js');
    return await sendOtlpTraceSpans({
      spans,
      url,
      headers,
      timeoutMs: context?.timeoutMs,
      maxBatchBytes: manifest.limits?.maxBatchBytes,
      signal: context?.signal
    });
  }
}

export default LangfuseCompat;
