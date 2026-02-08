import type {
  IObservabilityCompat,
  ObservabilityProviderManifest,
  ObservabilityBatchResult,
  ObservabilityCompatContext,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilitySignalEvent,
  ObservabilityToolExecutionEvent,
  ObservabilityTraceUpdateEvent
} from '../../../../kernel/index.js';
import { LruMap } from '../../../../kernel/index.js';
import { safeJsonStringify, flattenPrimitiveStrings } from '../../../../modules/shared/index.js';
import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '../../../../modules/observability/index.js';

import {
  applyTraceUpdateToCachedRequests,
  buildBasicAuthHeader,
  buildCachedRequestSummary,
  buildCommonTraceAttributes,
  buildInputJson,
  buildLangfuseCostDetails,
  buildLangfuseUsageDetails,
  buildOutputJson,
  cacheKey,
  deriveStartTimeIsoFromDuration,
  deriveStartTimeIso,
  eventTimestampToIso,
  getEnvelopeId,
  getEventIds,
  isRequestEvent,
  isResponseEvent,
  normalizeLangfuseObservationLevel,
  resolveMaxAttributeBytes,
  resolveTraceContext,
  resolveIngestionUrl
} from './langfuse-helpers.js';
import type { CachedRequest } from './langfuse-helpers.js';

const DEFAULT_SPAN_NAME = 'llm.generation';
const DEFAULT_EVENT_SPAN_NAME = 'llm.telemetry.event';
const DEFAULT_TOOL_SPAN_NAME = 'llm.tool';

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
    const maxBytes = resolveMaxAttributeBytes(context);
    const jsonOptions = {
      maxBytes,
      maxDepth: 25,
      maxArrayLength: 1000,
      maxObjectKeys: 2000,
      maxStringBytes: maxBytes
    } as const;
    const spans: OtlpSpanSpec[] = [];
    const eventIndexByEnvelopeId = new Map<string, number>();

    for (let i = 0; i < events.length; i++) {
      const event = events[i] as any;

      if (isRequestEvent(event)) {
        const key = cacheKey(event.traceId, event.generationId);
        this.requestCache.set(key, { summary: buildCachedRequestSummary(event, context), createdAtMs: now });
        continue;
      }

      if (isResponseEvent(event)) {
        const key = cacheKey(event.traceId, event.generationId);
        const cached = this.requestCache.get(key);
        const cachedSummary = cached?.summary as any;

        const { sessionId, traceName, correlationId, batchId, tags } = resolveTraceContext({
          event,
          cachedSummary
        });
        const step = typeof (event as any)?.metadata?.step === 'string'
          ? String((event as any).metadata.step).trim()
          : '';
        const spanName = step || DEFAULT_SPAN_NAME;

        const envelopeId = getEnvelopeId(
          eventIds,
          i,
          event.generationId ? String(event.generationId) : `response-${i}`
        );
        const parentGenerationId = typeof (event as any)?.parentGenerationId === 'string'
          ? String((event as any).parentGenerationId).trim()
          : '';
        const childGenerationId = typeof event.generationId === 'string'
          ? String(event.generationId).trim()
          : '';

        const costDetails = buildLangfuseCostDetails(event.usage);

        spans.push({
          traceIdHex: deriveOtlpTraceIdHex(String(event.traceId)),
          spanIdHex: deriveOtlpSpanIdHex(String(event.generationId || envelopeId)),
          ...(parentGenerationId && parentGenerationId !== childGenerationId
            ? { parentSpanIdHex: deriveOtlpSpanIdHex(parentGenerationId) }
            : {}),
          name: spanName,
          startTimeIso: cachedSummary?.startTimeIso ? String(cachedSummary.startTimeIso) : deriveStartTimeIso(event),
          endTimeIso: eventTimestampToIso(event),
          status: event.error
            ? { code: 'ERROR', message: String(event.error.message || 'error') }
            : { code: 'OK' },
          attributes: {
            ...buildCommonTraceAttributes({
              traceId: String(event.traceId || ''),
              sessionId,
              traceName,
              correlationId,
              tags,
              batchId
            }),
            'llm.adapter.provider': String(event.provider || cachedSummary?.provider || ''),
            'llm.adapter.input_text': cachedSummary?.inputText ?? '',
            'llm.adapter.output_text': flattenPrimitiveStrings(
              { content: event.content, toolCalls: event.toolCalls ?? [] },
              { maxBytes }
            ),
            'langfuse.observation.type': 'generation',
            'langfuse.observation.input': cachedSummary?.observationInput ?? safeJsonStringify(buildInputJson(undefined), jsonOptions),
            'langfuse.observation.output': safeJsonStringify(buildOutputJson(event), jsonOptions),
            'langfuse.observation.model.name': String(event.model || cachedSummary?.model || ''),
            'langfuse.observation.model.parameters': cachedSummary?.modelParameters ?? safeJsonStringify({}, jsonOptions),
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
        continue;
      }

      const type = typeof event.type === 'string' ? event.type : '';

      if (type === 'tool_execution') {
        const toolEvent = event as ObservabilityToolExecutionEvent;
        const key = cacheKey(toolEvent.traceId, toolEvent.generationId);
        const cachedSummary = (this.requestCache.get(key)?.summary as any) ?? undefined;

        const { sessionId, traceName, correlationId, batchId, tags } = resolveTraceContext({
          event: toolEvent,
          cachedSummary
        });

        const envelopeId = getEnvelopeId(eventIds, i, toolEvent.toolCallId ? `tool-${toolEvent.toolCallId}` : `tool-${i}`);
        const endTimeIso = eventTimestampToIso(toolEvent as any);
        const startTimeIso = deriveStartTimeIsoFromDuration(endTimeIso, toolEvent.durationMs);

        const level = toolEvent.error ? 'ERROR' : toolEvent.skipped ? 'WARNING' : 'DEFAULT';
        const statusMessage =
          toolEvent.error?.message
            ? String(toolEvent.error.message)
            : toolEvent.skipped && toolEvent.skipReason
              ? String(toolEvent.skipReason)
              : undefined;

        spans.push({
          traceIdHex: deriveOtlpTraceIdHex(String(toolEvent.traceId)),
          spanIdHex: deriveOtlpSpanIdHex(String(toolEvent.toolCallId || envelopeId)),
          ...(toolEvent.generationId ? { parentSpanIdHex: deriveOtlpSpanIdHex(String(toolEvent.generationId)) } : {}),
          name: `${DEFAULT_TOOL_SPAN_NAME}:${String(toolEvent.toolName || 'tool')}`,
          startTimeIso,
          endTimeIso,
          status: toolEvent.error
            ? { code: 'ERROR', message: String(toolEvent.error.message || 'error') }
            : { code: 'OK' },
          attributes: {
            ...buildCommonTraceAttributes({
              traceId: String(toolEvent.traceId || ''),
              sessionId,
              traceName,
              correlationId,
              tags,
              batchId
            }),
            'llm.adapter.provider': String(toolEvent.provider || ''),
            'llm.adapter.tool_name': String(toolEvent.toolName || ''),
            'llm.adapter.tool_call_id': String(toolEvent.toolCallId || ''),
            ...(toolEvent.skipped ? { 'llm.adapter.tool_skipped': true } : {}),
            ...(toolEvent.skipReason ? { 'llm.adapter.tool_skip_reason': String(toolEvent.skipReason) } : {}),
            'llm.adapter.input_text': toolEvent.args !== undefined ? flattenPrimitiveStrings(toolEvent.args, { maxBytes }) : '',
            'llm.adapter.output_text': String(
              toolEvent.resultText ??
                toolEvent.error?.message ??
                (toolEvent.skipped ? toolEvent.skipReason : '') ??
                ''
            ),
            'langfuse.observation.type': 'span',
            ...(statusMessage ? { 'langfuse.observation.status_message': statusMessage } : {}),
            'langfuse.observation.level': level,
            'langfuse.observation.input': safeJsonStringify(
              { toolName: toolEvent.toolName, toolCallId: toolEvent.toolCallId, ...(toolEvent.args !== undefined ? { args: toolEvent.args } : {}) },
              jsonOptions
            ),
            'langfuse.observation.output': safeJsonStringify(
              {
                ...(toolEvent.resultText !== undefined ? { resultText: toolEvent.resultText } : {}),
                ...(toolEvent.result !== undefined ? { result: toolEvent.result } : {}),
                ...(toolEvent.skipped ? { skipped: true } : {}),
                ...(toolEvent.skipReason ? { skipReason: toolEvent.skipReason } : {}),
                ...(toolEvent.error ? { error: toolEvent.error } : {})
              },
              jsonOptions
            )
          },
          envelopeId
        });

        eventIndexByEnvelopeId.set(envelopeId, i);
        continue;
      }

      if (type === 'signal') {
        const signalEvent = event as ObservabilitySignalEvent;
        const key = cacheKey(signalEvent.traceId, signalEvent.generationId);
        const cachedSummary = (this.requestCache.get(key)?.summary as any) ?? undefined;

        const { sessionId, traceName, correlationId, batchId, tags } = resolveTraceContext({
          event: signalEvent,
          cachedSummary
        });

        const envelopeId = getEnvelopeId(eventIds, i, `signal-${i}`);
        const endTimeIso = eventTimestampToIso(signalEvent as any);

        spans.push({
          traceIdHex: deriveOtlpTraceIdHex(String(signalEvent.traceId)),
          spanIdHex: deriveOtlpSpanIdHex(String(envelopeId)),
          ...(signalEvent.generationId ? { parentSpanIdHex: deriveOtlpSpanIdHex(String(signalEvent.generationId)) } : {}),
          name: DEFAULT_EVENT_SPAN_NAME,
          startTimeIso: endTimeIso,
          endTimeIso,
          status: signalEvent.level === 'error'
            ? { code: 'ERROR', message: String(signalEvent.message || 'error') }
            : { code: 'OK' },
          attributes: {
            ...buildCommonTraceAttributes({
              traceId: String(signalEvent.traceId || ''),
              sessionId,
              traceName,
              correlationId,
              tags,
              batchId
            }),
            'langfuse.observation.type': 'event',
            'langfuse.observation.level': normalizeLangfuseObservationLevel(signalEvent.level),
            ...(signalEvent.message ? { 'langfuse.observation.status_message': String(signalEvent.message) } : {}),
            'langfuse.observation.output': safeJsonStringify(
              {
                level: signalEvent.level,
                message: signalEvent.message,
                ...(signalEvent.source ? { source: signalEvent.source } : {}),
                ...(signalEvent.code ? { code: signalEvent.code } : {}),
                ...(signalEvent.stack ? { stack: signalEvent.stack } : {}),
                ...(signalEvent.tags ? { tags: signalEvent.tags } : {}),
                ...(signalEvent.metadata ? { metadata: signalEvent.metadata } : {})
              },
              jsonOptions
            )
          },
          envelopeId
        });

        eventIndexByEnvelopeId.set(envelopeId, i);
        continue;
      }

      if (type === 'trace_update') {
        const updateEvent = event as ObservabilityTraceUpdateEvent;
        applyTraceUpdateToCachedRequests(updateEvent, this.requestCache.entries());

        const key = cacheKey(updateEvent.traceId, updateEvent.generationId);
        const cachedSummary = (this.requestCache.get(key)?.summary as any) ?? undefined;

        const { sessionId, traceName, correlationId, batchId, tags } = resolveTraceContext({
          event: updateEvent,
          cachedSummary: {
            ...(cachedSummary ?? {}),
            ...(updateEvent.name ? { correlationId: updateEvent.name } : {}),
            ...(updateEvent.tags ? { tags: updateEvent.tags } : {})
          }
        });

        const envelopeId = getEnvelopeId(eventIds, i, `trace_update-${i}`);
        const endTimeIso = eventTimestampToIso(updateEvent as any);

        spans.push({
          traceIdHex: deriveOtlpTraceIdHex(String(updateEvent.traceId)),
          spanIdHex: deriveOtlpSpanIdHex(String(envelopeId)),
          ...(updateEvent.generationId ? { parentSpanIdHex: deriveOtlpSpanIdHex(String(updateEvent.generationId)) } : {}),
          name: DEFAULT_EVENT_SPAN_NAME,
          startTimeIso: endTimeIso,
          endTimeIso,
          status: { code: 'OK' },
          attributes: {
            ...buildCommonTraceAttributes({
              traceId: String(updateEvent.traceId || ''),
              sessionId,
              traceName,
              correlationId,
              tags,
              batchId
            }),
            ...(updateEvent.metadata
              ? {
                  'langfuse.trace.metadata.payload': safeJsonStringify(updateEvent.metadata, jsonOptions)
                }
              : {}),
            'langfuse.observation.type': 'event',
            'langfuse.observation.level': 'DEFAULT',
            'langfuse.observation.status_message': 'trace_update'
          },
          envelopeId
        });

        eventIndexByEnvelopeId.set(envelopeId, i);
        continue;
      }

      continue;
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
