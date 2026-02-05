import type {
  ObservabilityCompatContext,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilityTraceUpdateEvent
} from '../../../kernel/index.js';

import { safeJsonStringify, flattenPrimitiveStrings } from './serialization.js';
import { readTrimmedStringProperty } from './read-trimmed-string-property.js';

export function resolveMaxAttributeBytes(context?: ObservabilityCompatContext): number {
  return typeof context?.maxAttributeValueBytes === 'number' &&
    Number.isFinite(context.maxAttributeValueBytes) &&
    context.maxAttributeValueBytes > 0
    ? Math.floor(context.maxAttributeValueBytes)
    : 16384;
}

function readTimestampMs(event: { timestampMs?: unknown; timestamp?: unknown }): number | undefined {
  if (typeof event.timestampMs === 'number' && Number.isFinite(event.timestampMs)) {
    return event.timestampMs;
  }

  const raw = event.timestamp;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function eventTimestampToIso(event: { timestampMs?: unknown; timestamp?: unknown }): string {
  const ms = readTimestampMs(event);
  if (ms === undefined) return '1970-01-01T00:00:00.000Z';
  return new Date(ms).toISOString();
}

export function deriveStartTimeIsoFromDuration(endTimeIso: string, durationMs: unknown): string {
  const endMs = Date.parse(endTimeIso);
  const dur = typeof durationMs === 'number' ? durationMs : Number(durationMs);
  if (!Number.isFinite(endMs) || !Number.isFinite(dur) || dur < 0) {
    return endTimeIso;
  }
  return new Date(endMs - dur).toISOString();
}

export function getStringArrayMetadata(metadata: unknown, key: string): string[] | undefined {
  const value = (metadata as any)?.[key];
  if (!Array.isArray(value)) return undefined;
  const tags = value.map(v => String(v).trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

export function resolveTraceContext(options: {
  event: { sessionId?: unknown; metadata?: unknown };
  cachedSummary?: { sessionId?: unknown; correlationId?: unknown; batchId?: unknown; tags?: unknown };
}): { sessionId?: string; traceName?: string; batchId?: string; tags?: string[] } {
  const { event, cachedSummary } = options;
  const metadata = event.metadata;

  const sessionId = cachedSummary?.sessionId
    ? String(cachedSummary.sessionId)
    : event.sessionId
      ? String(event.sessionId)
      : undefined;

  const traceName =
    (cachedSummary?.correlationId ? String(cachedSummary.correlationId) : undefined) ??
    readTrimmedStringProperty(metadata, 'correlationId');

  const batchId =
    (cachedSummary?.batchId ? String(cachedSummary.batchId) : undefined) ??
    (readTrimmedStringProperty(metadata, 'batchId') ?? sessionId);

  const tags = (cachedSummary?.tags as any) ?? getStringArrayMetadata(metadata, 'tags');

  return { sessionId, traceName, batchId, tags };
}

export function getEventIds(context?: ObservabilityCompatContext): string[] {
  return Array.isArray(context?.eventIds) ? context!.eventIds!.map(String) : [];
}

export function getEnvelopeId(eventIds: string[], index: number, fallback: string): string {
  const raw = eventIds[index];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return fallback;
}

export function isRequestEvent(event: any): event is ObservabilityLLMRequestEvent {
  return !!event && typeof event === 'object' && Array.isArray((event as any).messages);
}

export function isResponseEvent(event: any): event is ObservabilityLLMResponseEvent {
  return !!event && typeof event === 'object' && Array.isArray((event as any).content);
}

export function deriveStartTimeIso(response: ObservabilityLLMResponseEvent): string {
  const endMs = readTimestampMs(response);
  const durationMs = typeof response.durationMs === 'number' ? response.durationMs : NaN;
  if (endMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return eventTimestampToIso(response);
  }
  return new Date(endMs - durationMs).toISOString();
}

export type CachedRequestSummary = {
  startTimeIso: string;
  sessionId?: string;
  provider: string;
  model: string;
  correlationId?: string;
  batchId?: string;
  tags?: string[];
  inputText: string;
  observationInput: string;
  modelParameters: string;
};

export function cacheKey(traceId: string, generationId?: string): string {
  const trace = String(traceId || '');
  const gen = String(generationId || '');
  return gen ? `${trace}:${gen}` : trace;
}

export function buildInputJson(request?: ObservabilityLLMRequestEvent): Record<string, unknown> {
  if (!request) return { messages: [] };
  return {
    messages: request.messages,
    tools: request.tools ?? [],
    ...(request.requestPayload !== undefined ? { requestPayload: request.requestPayload } : {})
  };
}

export function buildOutputJson(response: ObservabilityLLMResponseEvent): Record<string, unknown> {
  return {
    content: response.content,
    toolCalls: response.toolCalls ?? [],
    ...(response.rawResponse !== undefined ? { rawResponse: response.rawResponse } : {}),
    error: response.error ?? null
  };
}

export function buildCachedRequestSummary(
  request: ObservabilityLLMRequestEvent,
  context?: ObservabilityCompatContext
): CachedRequestSummary {
  const maxBytes = resolveMaxAttributeBytes(context);
  const metadata = request.metadata;
  const sessionId = request.sessionId ? String(request.sessionId) : undefined;
  const correlationId = readTrimmedStringProperty(metadata, 'correlationId');
  const batchId = readTrimmedStringProperty(metadata, 'batchId') ?? sessionId;
  const tags = getStringArrayMetadata(metadata, 'tags');

  return {
    startTimeIso: eventTimestampToIso(request),
    sessionId,
    provider: String(request.provider || ''),
    model: String(request.model || ''),
    correlationId,
    batchId,
    tags,
    inputText: flattenPrimitiveStrings(request.messages, { maxBytes }),
    observationInput: safeJsonStringify(buildInputJson(request), { maxBytes }),
    modelParameters: safeJsonStringify(request.settings ?? {}, { maxBytes })
  };
}

export function applyTraceUpdateToCachedRequests(
  update: ObservabilityTraceUpdateEvent,
  cacheEntries: Iterable<[string, { summary: any }]>
): void {
  const traceId = String(update.traceId || '').trim();
  if (!traceId) return;

  const nextTraceName = update.name ? String(update.name) : undefined;
  const nextTags = Array.isArray(update.tags) ? update.tags.map(t => String(t).trim()).filter(Boolean) : undefined;
  const nextSessionId = update.sessionId ? String(update.sessionId) : undefined;

  if (!nextTraceName && !nextTags && !nextSessionId) return;

  for (const [key, entry] of cacheEntries) {
    if (key !== traceId && !key.startsWith(`${traceId}:`)) continue;

    const summary = entry.summary as any;
    if (nextTraceName) summary.correlationId = nextTraceName;
    if (nextTags) summary.tags = nextTags;
    if (nextSessionId && !summary.sessionId) summary.sessionId = nextSessionId;
  }
}

