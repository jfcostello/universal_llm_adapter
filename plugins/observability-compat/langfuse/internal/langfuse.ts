import type {
  IObservabilityCompat,
  ObservabilityProviderManifest,
  ObservabilityBatchResult,
  ObservabilityCompatContext,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent
} from '../../../../kernel/index.js';
import { LruMap, substituteEnv } from '../../../../kernel/index.js';
import { safeJsonStringify, flattenPrimitiveStrings, readTrimmedStringProperty } from '../../../../modules/shared/index.js';
import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '../../../../modules/observability/index.js';

const DEFAULT_SPAN_NAME = 'llm.generation';

const ALLOW_BASEURL_OVERRIDE_ENV = 'LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE';
const BASEURL_OVERRIDE_ALLOWLIST_ENV = 'LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST';

const REQUEST_CACHE_TTL_MS = 10 * 60_000;
const REQUEST_CACHE_MAX_ENTRIES = 1000;

function getStringArrayMetadata(metadata: unknown, key: string): string[] | undefined {
  const value = (metadata as any)?.[key];
  if (!Array.isArray(value)) return undefined;
  const tags = value.map(v => String(v).trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function readUsageNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
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

function eventTimestampToIso(event: { timestampMs?: unknown; timestamp?: unknown }): string {
  const ms = readTimestampMs(event);
  if (ms === undefined) return '1970-01-01T00:00:00.000Z';
  return new Date(ms).toISOString();
}

function buildLangfuseUsageDetails(usage: unknown): Record<string, number> {
  if (!usage || typeof usage !== 'object') return {};
  const u = usage as any;

  const input =
    readUsageNumber(u.input) ??
    readUsageNumber(u.input_tokens) ??
    readUsageNumber(u.promptTokens) ??
    readUsageNumber(u.prompt_tokens);
  const output =
    readUsageNumber(u.output) ??
    readUsageNumber(u.output_tokens) ??
    readUsageNumber(u.completionTokens) ??
    readUsageNumber(u.completion_tokens);
  const total =
    readUsageNumber(u.total) ??
    readUsageNumber(u.total_tokens) ??
    readUsageNumber(u.totalTokens);

  const cached =
    readUsageNumber(u.cached_tokens) ??
    readUsageNumber(u.cachedTokens);
  const reasoning =
    readUsageNumber(u.reasoning_tokens) ??
    readUsageNumber(u.reasoningTokens);
  const audio =
    readUsageNumber(u.audio_tokens) ??
    readUsageNumber(u.audioTokens);
  const cost =
    readUsageNumber(u.cost);

  const details: Record<string, number> = {};
  if (input !== undefined) details.input = input;
  if (output !== undefined) details.output = output;
  if (total !== undefined) {
    details.total = total;
  } else if (input !== undefined || output !== undefined) {
    details.total = (input ?? 0) + (output ?? 0);
  }

  if (cached !== undefined) details.cached_tokens = cached;
  if (reasoning !== undefined) details.reasoning_tokens = reasoning;
  if (audio !== undefined) details.audio_tokens = audio;
  if (cost !== undefined) details.cost = cost;

  return details;
}

function buildUrl(urlTemplate: string): string {
  const normalized = String(urlTemplate).replace(/\$\{([A-Z0-9_]+)\}/g, '${$1?}');
  return String(substituteEnv(normalized));
}

function isBaseUrlOverrideEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLM_LIVE === '1' || env[ALLOW_BASEURL_OVERRIDE_ENV] === '1';
}

function getBaseUrlOverrideAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  if (env.LLM_LIVE === '1') return null;

  const raw = String(env[BASEURL_OVERRIDE_ALLOWLIST_ENV] || '').trim();
  if (!raw) return null;

  const entries = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  return entries.length > 0 ? new Set(entries) : null;
}

function isUrlHostAllowlisted(url: URL, allowlist: Set<string> | null): boolean {
  if (!allowlist) return true;
  return allowlist.has(url.host.toLowerCase()) || allowlist.has(url.hostname.toLowerCase());
}

function resolveIngestionUrl(
  manifest: ObservabilityProviderManifest,
  context?: ObservabilityCompatContext
): string {
  const resolved = buildUrl(manifest.endpoint.urlTemplate);

  const baseUrl = String((context?.providerConfig as any)?.baseUrl || '').trim();
  if (!baseUrl) return resolved;
  if (!isBaseUrlOverrideEnabled()) return resolved;

  let overrideUrl: URL;
  try {
    overrideUrl = new URL(baseUrl);
  } catch {
    return resolved;
  }

  if (overrideUrl.username || overrideUrl.password) return resolved;
  if (overrideUrl.protocol !== 'http:' && overrideUrl.protocol !== 'https:') return resolved;

  const allowlist = getBaseUrlOverrideAllowlist();
  if (process.env.LLM_LIVE !== '1' && !allowlist) return resolved;
  if (!isUrlHostAllowlisted(overrideUrl, allowlist)) return resolved;

  let pathnameAndSearch = '';
  try {
    const parsed = new URL(resolved);
    pathnameAndSearch = `${parsed.pathname}${parsed.search}`;
  } catch {
    pathnameAndSearch = resolved.startsWith('/') ? resolved : `/${resolved}`;
  }

  const overridePathnameAndSearch = `${overrideUrl.pathname}${overrideUrl.search}`;
  if (overridePathnameAndSearch !== '/' && overridePathnameAndSearch !== '') {
    if (overridePathnameAndSearch !== pathnameAndSearch) return resolved;
  }

  return `${overrideUrl.origin}${pathnameAndSearch}`;
}

function buildBasicAuthHeader(manifest: ObservabilityProviderManifest): string {
  const cfg = manifest.auth;
  if (!cfg || cfg.type !== 'basic') {
    throw new Error('Langfuse compat requires basic auth configuration');
  }

  if (!cfg.publicKeyEnv || !cfg.secretKeyEnv) {
    throw new Error('Langfuse basic auth requires publicKeyEnv and secretKeyEnv');
  }

  const publicKey = String(process.env[cfg.publicKeyEnv] || '').trim();
  const secretKey = String(process.env[cfg.secretKeyEnv] || '').trim();
  if (!publicKey || !secretKey) {
    const missing = [
      !publicKey ? cfg.publicKeyEnv : null,
      !secretKey ? cfg.secretKeyEnv : null
    ].filter(Boolean);
    throw new Error(`Missing required env var(s) for Langfuse auth: ${missing.join(', ')}`);
  }

  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}

function getEventIds(context?: ObservabilityCompatContext): string[] {
  return Array.isArray(context?.eventIds) ? context!.eventIds!.map(String) : [];
}

function getEnvelopeId(eventIds: string[], index: number, fallback: string): string {
  const raw = eventIds[index];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return fallback;
}

function isRequestEvent(event: any): event is ObservabilityLLMRequestEvent {
  return !!event && typeof event === 'object' && Array.isArray((event as any).messages);
}

function isResponseEvent(event: any): event is ObservabilityLLMResponseEvent {
  return !!event && typeof event === 'object' && Array.isArray((event as any).content);
}

function deriveStartTimeIso(response: ObservabilityLLMResponseEvent): string {
  const endMs = readTimestampMs(response);
  const durationMs = typeof response.durationMs === 'number' ? response.durationMs : NaN;
  if (endMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return eventTimestampToIso(response);
  }
  return new Date(endMs - durationMs).toISOString();
}

type CachedRequest = {
  summary: CachedRequestSummary;
  createdAtMs: number;
};

type CachedRequestSummary = {
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

function cacheKey(traceId: string, generationId?: string): string {
  const trace = String(traceId || '');
  const gen = String(generationId || '');
  return gen ? `${trace}:${gen}` : trace;
}

function buildInputJson(request?: ObservabilityLLMRequestEvent): Record<string, unknown> {
  if (!request) return { messages: [] };
  return {
    messages: request.messages,
    tools: request.tools ?? [],
    ...(request.requestPayload !== undefined ? { requestPayload: request.requestPayload } : {})
  };
}

function buildOutputJson(response: ObservabilityLLMResponseEvent): Record<string, unknown> {
  return {
    content: response.content,
    toolCalls: response.toolCalls ?? [],
    ...(response.rawResponse !== undefined ? { rawResponse: response.rawResponse } : {}),
    error: response.error ?? null
  };
}

function buildCachedRequestSummary(
  request: ObservabilityLLMRequestEvent,
  context?: ObservabilityCompatContext
): CachedRequestSummary {
  const maxBytes = typeof context?.maxAttributeValueBytes === 'number' && Number.isFinite(context.maxAttributeValueBytes) && context.maxAttributeValueBytes > 0
    ? Math.floor(context.maxAttributeValueBytes)
    : 16384;
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
          'langfuse.observation.usage_details': safeJsonStringify(buildLangfuseUsageDetails(event.usage), { maxBytes })
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
