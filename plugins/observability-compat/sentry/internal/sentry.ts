import type {
  IObservabilityCompat,
  ObservabilityProviderManifest,
  ObservabilityBatchResult,
  ObservabilityCompatContext,
  ObservabilitySignalEvent,
  ObservabilityToolExecutionEvent,
  ObservabilityTraceUpdateEvent
} from '../../../../kernel/index.js';
import { LruMap } from '../../../../kernel/index.js';

import { flattenPrimitiveStrings } from '../../../../modules/shared/index.js';
import type { CachedRequestSummary } from '../../../../modules/shared/index.js';
import {
  applyTraceUpdateToCachedRequests,
  buildCachedRequestSummary,
  cacheKey,
  deriveStartTimeIsoFromDuration,
  deriveStartTimeIso,
  eventTimestampToIso,
  getEnvelopeId,
  getEventIds,
  isRequestEvent,
  isResponseEvent,
  resolveMaxAttributeBytes,
  resolveTraceContext
} from '../../../../modules/shared/index.js';

import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '../../../../modules/observability/index.js';

import {
  buildSentryOtlpAuthHeader,
  buildSentrySignalEnvelope,
  isOtlpEnabled,
  parseSentryDsn,
  resolveSentryDsn
} from './sentry-helpers.js';

const DEFAULT_GENERATION_SPAN_NAME = 'llm.generation';
const DEFAULT_TOOL_SPAN_NAME = 'llm.tool';

const REQUEST_CACHE_TTL_MS = 10 * 60_000;
const REQUEST_CACHE_MAX_ENTRIES = 1000;

type CachedRequest = {
  summary: CachedRequestSummary;
  createdAtMs: number;
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && String((error as any).name) === 'AbortError';
}

function createAbortError(message = 'Aborted'): Error {
  const error = new Error(message);
  (error as any).name = 'AbortError';
  return error;
}

function buildCommonTraceAttributes(options: {
  traceId: string;
  sessionId?: string;
  traceName?: string;
  batchId?: string;
  tags?: string[];
}): Record<string, unknown> {
  const { traceId, sessionId, traceName, batchId, tags } = options;
  return {
    'llm.adapter.trace_id': String(traceId || ''),
    ...(sessionId ? { 'llm.adapter.session_id': sessionId } : {}),
    ...(traceName ? { 'llm.adapter.correlation_id': traceName } : {}),
    ...(batchId ? { 'llm.adapter.batch_id': batchId } : {}),
    ...(tags ? { 'llm.adapter.tags': tags } : {})
  };
}

export class SentryCompat implements IObservabilityCompat {
  private requestCache = new LruMap<string, CachedRequest>(REQUEST_CACHE_MAX_ENTRIES);

  buildBatch(
    events: unknown[],
    manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): { payload: { spans: OtlpSpanSpec[]; envelopes: Array<{ envelopeId: string; body: string }> }; eventIndexByEnvelopeId: Map<string, number> } {
    const now = Date.now();
    this.pruneRequestCache(now);

    const enableOtlp = isOtlpEnabled(context);
    const eventIds = getEventIds(context);
    const maxBytes = resolveMaxAttributeBytes(context);

    const spans: OtlpSpanSpec[] = [];
    const envelopes: Array<{ envelopeId: string; body: string }> = [];
    const eventIndexByEnvelopeId = new Map<string, number>();

    let resolvedDsn: string | null = null;

    for (let i = 0; i < events.length; i++) {
      const event = events[i] as any;

      if (isRequestEvent(event)) {
        const key = cacheKey(event.traceId, event.generationId);
        this.requestCache.set(key, { summary: buildCachedRequestSummary(event, context), createdAtMs: now });
        continue;
      }

      if (isResponseEvent(event)) {
        if (!enableOtlp) continue;

        const key = cacheKey(event.traceId, event.generationId);
        const cached = this.requestCache.get(key);
        const cachedSummary = cached?.summary as any;

        const { sessionId, traceName, batchId, tags } = resolveTraceContext({ event, cachedSummary });

        const envelopeId = getEnvelopeId(
          eventIds,
          i,
          event.generationId ? String(event.generationId) : `response-${i}`
        );

        spans.push({
          traceIdHex: deriveOtlpTraceIdHex(String(event.traceId)),
          spanIdHex: deriveOtlpSpanIdHex(String(event.generationId || envelopeId)),
          name: DEFAULT_GENERATION_SPAN_NAME,
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
              batchId,
              tags
            }),
            'llm.adapter.provider': String(event.provider || cachedSummary?.provider || ''),
            'llm.adapter.model': String(event.model || cachedSummary?.model || ''),
            'llm.adapter.input_text': cachedSummary?.inputText ?? '',
            'llm.adapter.output_text': flattenPrimitiveStrings(
              { content: event.content, toolCalls: event.toolCalls ?? [] },
              { maxBytes }
            )
          },
          envelopeId
        });

        eventIndexByEnvelopeId.set(envelopeId, i);
        continue;
      }

      const type = typeof event.type === 'string' ? event.type : '';

      if (type === 'tool_execution') {
        if (!enableOtlp) continue;
        const toolEvent = event as ObservabilityToolExecutionEvent;
        const key = cacheKey(toolEvent.traceId, toolEvent.generationId);
        const cachedSummary = (this.requestCache.get(key)?.summary as any) ?? undefined;

        const { sessionId, traceName, batchId, tags } = resolveTraceContext({ event: toolEvent, cachedSummary });

        const envelopeId = getEnvelopeId(
          eventIds,
          i,
          toolEvent.toolCallId ? `tool-${toolEvent.toolCallId}` : `tool-${i}`
        );

        const endTimeIso = eventTimestampToIso(toolEvent as any);
        const startTimeIso = deriveStartTimeIsoFromDuration(endTimeIso, toolEvent.durationMs);

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
              batchId,
              tags
            }),
            'llm.adapter.provider': String(toolEvent.provider || ''),
            'llm.adapter.model': String(toolEvent.model || ''),
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

        const traceContext = resolveTraceContext({ event: signalEvent, cachedSummary });
        const envelopeId = getEnvelopeId(eventIds, i, `signal-${i}`);

        if (resolvedDsn === null) {
          resolvedDsn = resolveSentryDsn(manifest);
        }

        const envelope = buildSentrySignalEnvelope({
          dsn: resolvedDsn,
          envelopeId,
          event: signalEvent,
          traceContext,
          context
        });

        envelopes.push(envelope);
        eventIndexByEnvelopeId.set(envelopeId, i);
        continue;
      }

      if (type === 'trace_update') {
        const updateEvent = event as ObservabilityTraceUpdateEvent;
        applyTraceUpdateToCachedRequests(updateEvent, this.requestCache.entries());
        continue;
      }

      continue;
    }

    return { payload: { spans, envelopes }, eventIndexByEnvelopeId };
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
    const envelopes = Array.isArray((payload as any)?.envelopes)
      ? ((payload as any).envelopes as Array<{ envelopeId: string; body: string }>)
      : [];

    if (spans.length === 0 && envelopes.length === 0) {
      return { success: true, outcomes: [] };
    }

    const dsn = resolveSentryDsn(manifest);
    const parsed = parseSentryDsn(dsn);

    const outcomes: ObservabilityBatchResult['outcomes'] = [];
    let overallSuccess = true;

    // Envelopes (signals/errors)
    for (const envelope of envelopes) {
      if (context?.signal?.aborted) {
        throw createAbortError();
      }

      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let cleanupSignal: (() => void) | undefined;

      const timeoutMs =
        typeof context?.timeoutMs === 'number' && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0
          ? Math.floor(context.timeoutMs)
          : undefined;

      if (timeoutMs !== undefined) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }

      try {
        if (context?.signal) {
          const onAbort = () => controller.abort();
          cleanupSignal = () => context.signal!.removeEventListener('abort', onAbort);
          context.signal.addEventListener('abort', onAbort, { once: true });
        }

        const res = await fetch(parsed.envelopeUrl, {
          method: 'POST',
          headers: {
            ...(manifest.endpoint.headers ?? {}),
            'Content-Type': 'application/x-sentry-envelope'
          },
          body: envelope.body,
          signal: controller.signal
        });

        if (res.ok) {
          outcomes.push({ envelopeId: envelope.envelopeId, success: true, status: res.status });
          continue;
        }

        overallSuccess = false;
        outcomes.push({
          envelopeId: envelope.envelopeId,
          success: false,
          status: res.status,
          error: typeof (res as any)?.statusText === 'string' && (res as any).statusText
            ? `HTTP ${res.status}: ${(res as any).statusText}`
            : `HTTP ${res.status}`,
          retryable: isRetryableStatus(res.status)
        });
      } catch (error: any) {
        if (context?.signal?.aborted || isAbortError(error)) {
          throw createAbortError();
        }
        overallSuccess = false;
        outcomes.push({
          envelopeId: envelope.envelopeId,
          success: false,
          error: (error as Error)?.message ?? String(error),
          retryable: true
        });
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        cleanupSignal?.();
      }
    }

    // OTLP traces/tools
    if (isOtlpEnabled(context) && spans.length > 0) {
      const { sendOtlpTraceSpans } = await import('../../../../modules/observability/index.js');
      const otlp = await sendOtlpTraceSpans({
        spans,
        url: parsed.otlpTracesUrl,
        headers: {
          ...(manifest.endpoint.headers ?? {}),
          'Content-Type': 'application/x-protobuf',
          'x-sentry-auth': buildSentryOtlpAuthHeader(parsed.publicKey)
        },
        timeoutMs: context?.timeoutMs,
        maxBatchBytes: manifest.limits?.maxBatchBytes,
        signal: context?.signal
      });

      outcomes.push(...otlp.outcomes);
      if (!otlp.success) overallSuccess = false;
    }

    return {
      success: overallSuccess && outcomes.every(o => o.success),
      outcomes
    };
  }
}

export default SentryCompat;

