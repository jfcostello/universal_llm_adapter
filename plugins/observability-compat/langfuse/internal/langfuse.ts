import type {
  IObservabilityCompat,
  ObservabilityProviderManifest,
  ObservabilityBatchResult,
  ObservabilityCompatContext,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent
} from '../../../../modules/kernel/index.js';
import { substituteEnv } from '../../../../modules/kernel/index.js';
import type { OtlpSpanSpec } from '../../../../modules/observability/index.js';
import { deriveOtlpSpanIdHex, deriveOtlpTraceIdHex } from '../../../../modules/observability/index.js';

const DEFAULT_SPAN_NAME = 'llm.generation';
const OTLP_TRACES_PATH = '/api/public/otel/v1/traces';

const ALLOW_BASEURL_OVERRIDE_ENV = 'LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE';
const BASEURL_OVERRIDE_ALLOWLIST_ENV = 'LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST';

const REQUEST_CACHE_TTL_MS = 10 * 60_000;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
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
  const endMs = Date.parse(String(response.timestamp));
  const durationMs = typeof response.durationMs === 'number' ? response.durationMs : NaN;
  if (!Number.isFinite(endMs) || !Number.isFinite(durationMs) || durationMs < 0) {
    return String(response.timestamp);
  }
  return new Date(endMs - durationMs).toISOString();
}

type CachedRequest = {
  event: ObservabilityLLMRequestEvent;
  createdAtMs: number;
};

function cacheKey(traceId: string, generationId?: string): string {
  const trace = String(traceId || '');
  const gen = String(generationId || '');
  return gen ? `${trace}:${gen}` : trace;
}

function buildInputJson(request?: ObservabilityLLMRequestEvent): string {
  if (!request) return safeJson({ messages: [] });
  return safeJson({
    messages: request.messages,
    tools: request.tools ?? [],
    ...(request.requestPayload !== undefined ? { requestPayload: request.requestPayload } : {})
  });
}

function buildOutputJson(response: ObservabilityLLMResponseEvent): string {
  return safeJson({
    content: response.content,
    toolCalls: response.toolCalls ?? [],
    ...(response.rawResponse !== undefined ? { rawResponse: response.rawResponse } : {}),
    error: response.error ?? null
  });
}

function collectPrimitiveStrings(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPrimitiveStrings(entry, out);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectPrimitiveStrings(v, out);
    }
  }
}

function flattenPrimitiveStrings(value: unknown): string {
  const out: string[] = [];
  collectPrimitiveStrings(value, out);
  return out.filter(s => String(s).trim() !== '').join('\n');
}

export class LangfuseCompat implements IObservabilityCompat {
  private requestCache = new Map<string, CachedRequest>();

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
        this.requestCache.set(key, { event, createdAtMs: now });
        continue;
      }

      if (!isResponseEvent(event)) {
        continue;
      }

      const key = cacheKey(event.traceId, event.generationId);
      const cached = this.requestCache.get(key);

      const envelopeId = getEnvelopeId(
        eventIds,
        i,
        event.generationId ? String(event.generationId) : `response-${i}`
      );

      spans.push({
        traceIdHex: deriveOtlpTraceIdHex(String(event.traceId)),
        spanIdHex: deriveOtlpSpanIdHex(String(event.generationId || envelopeId)),
        name: DEFAULT_SPAN_NAME,
        startTimeIso: cached?.event?.timestamp ? String(cached.event.timestamp) : deriveStartTimeIso(event),
        endTimeIso: String(event.timestamp),
        status: event.error
          ? { code: 'ERROR', message: String(event.error.message || 'error') }
          : { code: 'OK' },
        attributes: {
          ...(cached?.event?.sessionId ? { 'langfuse.session.id': String(cached.event.sessionId) } : {}),
          'llm.adapter.provider': String(event.provider || cached?.event?.provider || ''),
          'llm.adapter.input_text': cached?.event ? flattenPrimitiveStrings(cached.event.messages) : '',
          'llm.adapter.output_text': flattenPrimitiveStrings({
            content: event.content,
            toolCalls: event.toolCalls ?? []
          }),
          'langfuse.observation.input': buildInputJson(cached?.event),
          'langfuse.observation.output': buildOutputJson(event),
          'langfuse.observation.model.name': String(event.model || cached?.event?.model || ''),
          'langfuse.observation.model.parameters': safeJson(cached?.event?.settings ?? {}),
          'langfuse.observation.usage_details': safeJson(event.usage ?? {})
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
      maxBatchBytes: manifest.limits?.maxBatchBytes
    });
  }
}

export default LangfuseCompat;
