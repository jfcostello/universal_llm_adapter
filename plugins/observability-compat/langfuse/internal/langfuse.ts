/**
 * Langfuse observability compat implementation.
 * Transforms provider-agnostic events into Langfuse ingestion format.
 */

import type {
  IObservabilityCompat,
  ObservabilityProviderManifest,
  ObservabilityBatchResult,
  ObservabilityEnvelopeOutcome,
  ObservabilityCompatContext,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent
} from '../../../../modules/kernel/index.js';
import { createHash, randomUUID } from 'crypto';

// ============================================================
// LANGFUSE INGESTION TYPES
// ============================================================

/**
 * Langfuse ingestion event types.
 */
type LangfuseEventType =
  | 'trace-create'
  | 'generation-create'
  | 'generation-update'
  | 'span-create'
  | 'span-update';

/**
 * Base Langfuse ingestion event structure.
 */
interface LangfuseIngestionEvent {
  id: string;
  type: LangfuseEventType;
  timestamp: string;
  body: Record<string, unknown>;
}

/**
 * Langfuse batch request payload.
 */
interface LangfuseBatchPayload {
  batch: LangfuseIngestionEvent[];
  metadata?: {
    sdk_name?: string;
    sdk_version?: string;
  };
}

/**
 * Langfuse API error response item.
 */
interface LangfuseIngestionError {
  id: string;
  status: number;
  message: string;
  error?: string;
}

/**
 * Langfuse API response.
 */
interface LangfuseIngestionResponse {
  successes: Array<{ id: string; status: number }>;
  errors: LangfuseIngestionError[];
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Build Authorization header for Basic auth.
 */
function buildBasicAuth(publicKey: string, secretKey: string): string {
  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Resolve environment variable value, with optional default.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
function resolveEnvVar(template: string): string {
  // Handle ${VAR:-default} or ${VAR} syntax
  const match = template.match(/^\$\{([^:}]+)(?::-([^}]*))?\}$/);
  if (match) {
    const [, varName, defaultValue] = match;
    return process.env[varName] || defaultValue || '';
  }
  return template;
}

/**
 * Build URL from template with environment variable resolution.
 */
function buildUrl(urlTemplate: string): string {
  return urlTemplate.replace(/\$\{[^}]+\}/g, (match) => resolveEnvVar(match));
}

const ALLOW_BASEURL_OVERRIDE_ENV = 'LLM_ADAPTER_ALLOW_OBSERVABILITY_BASEURL_OVERRIDE';
const BASEURL_OVERRIDE_ALLOWLIST_ENV = 'LLM_ADAPTER_OBSERVABILITY_BASEURL_ALLOWLIST';

function isBaseUrlOverrideEnabled(): boolean {
  return process.env[ALLOW_BASEURL_OVERRIDE_ENV] === '1';
}

function getBaseUrlOverrideAllowlist(): Set<string> | null {
  const raw = process.env[BASEURL_OVERRIDE_ALLOWLIST_ENV];
  if (!raw) return null;
  const entries = raw
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

function isUrlHostAllowlisted(url: URL, allowlist: Set<string> | null): boolean {
  if (!allowlist) return true;
  const host = url.host.toLowerCase(); // includes port
  const hostname = url.hostname.toLowerCase(); // excludes port
  return allowlist.has(host) || allowlist.has(hostname);
}

/**
 * Resolve the final ingestion URL, with optional per-call overrides.
 * Provider-specific overrides are passed via `context.providerConfig`.
 */
function resolveIngestionUrl(
  manifest: ObservabilityProviderManifest,
  context?: ObservabilityCompatContext
): string {
  const resolvedFromTemplate = buildUrl(manifest.endpoint.urlTemplate);

  const providerConfig = context?.providerConfig as Record<string, unknown> | undefined;
  const baseUrl = typeof (providerConfig as any)?.baseUrl === 'string'
    ? String((providerConfig as any).baseUrl).trim()
    : '';

  if (!baseUrl) {
    return resolvedFromTemplate;
  }

  // For security, ignore per-call baseUrl overrides unless explicitly enabled.
  // Per-call overrides are untrusted in server environments and can lead to SSRF / secret exfiltration.
  if (!isBaseUrlOverrideEnabled()) {
    return resolvedFromTemplate;
  }

  let overrideUrl: URL;
  try {
    overrideUrl = new URL(baseUrl);
  } catch {
    return resolvedFromTemplate;
  }

  if (overrideUrl.username || overrideUrl.password) {
    return resolvedFromTemplate;
  }

  if (overrideUrl.protocol !== 'http:' && overrideUrl.protocol !== 'https:') {
    return resolvedFromTemplate;
  }

  const allowlist = getBaseUrlOverrideAllowlist();
  if (!isUrlHostAllowlisted(overrideUrl, allowlist)) {
    return resolvedFromTemplate;
  }

  let pathnameAndSearch = '';
  try {
    const parsed = new URL(resolvedFromTemplate);
    pathnameAndSearch = `${parsed.pathname}${parsed.search}`;
  } catch {
    // If the template is relative (e.g. missing env var), fall back to simple concatenation.
    pathnameAndSearch = resolvedFromTemplate.startsWith('/')
      ? resolvedFromTemplate
      : `/${resolvedFromTemplate}`;
  }

  // If a full URL was provided, only accept it if it matches the ingestion path.
  const overridePathnameAndSearch = `${overrideUrl.pathname}${overrideUrl.search}`;
  if (overridePathnameAndSearch !== '/' && overridePathnameAndSearch !== '') {
    if (overridePathnameAndSearch !== pathnameAndSearch) {
      return resolvedFromTemplate;
    }
  }

  return `${overrideUrl.origin}${pathnameAndSearch}`;
}

/**
 * Determine if an HTTP status code indicates a retryable error.
 */
function isRetryableStatus(status: number): boolean {
  // 429 Too Many Requests, 5xx Server Errors
  return status === 429 || (status >= 500 && status < 600);
}

function stableUuidV4(seed: string): string {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));

  // Force UUIDv4 bits for maximum compatibility with systems that validate UUID versions.
  // - version (byte 6 high nibble) = 4
  // - variant (byte 8 high bits) = 10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stableEnvelopeId(eventId: string, kind: string): string {
  return stableUuidV4(`${eventId}:${kind}`);
}

// ============================================================
// LANGFUSE COMPAT CLASS
// ============================================================

/**
 * Langfuse observability compat implementation.
 */
export class LangfuseCompat implements IObservabilityCompat {
  /**
   * Build a batch payload from events for sending to Langfuse.
   *
   * @param events - Provider-agnostic observability events
   * @param manifest - The provider manifest for configuration
   * @returns Object containing the payload and a mapping from event IDs to envelope IDs
   */
  buildBatch(
    events: unknown[],
    manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): {
    payload: LangfuseBatchPayload;
    eventIndexByEnvelopeId: Map<string, number>;
  } {
    const batch: LangfuseIngestionEvent[] = [];
    const eventIndexByEnvelopeId = new Map<string, number>();
    const eventIds = context?.eventIds ?? [];

    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const event = events[eventIndex];
      const typedEvent = event as ObservabilityLLMRequestEvent | ObservabilityLLMResponseEvent;
      const eventId = typeof eventIds[eventIndex] === 'string' && eventIds[eventIndex].trim() !== ''
        ? eventIds[eventIndex].trim()
        : undefined;

      // Determine if this is a request or response
      const isRequest = 'messages' in typedEvent;

      if (isRequest) {
        const requestEvent = typedEvent as ObservabilityLLMRequestEvent;
        const ingestionEvents = this.buildRequestEvents(requestEvent, eventId);

        for (const ingestionEvent of ingestionEvents) {
          batch.push(ingestionEvent);
          // Map each envelope ID back to the source event index for retry correlation
          eventIndexByEnvelopeId.set(ingestionEvent.id, eventIndex);
        }
      } else {
        const responseEvent = typedEvent as ObservabilityLLMResponseEvent;
        const ingestionEvents = this.buildResponseEvents(responseEvent, eventId);

        for (const ingestionEvent of ingestionEvents) {
          batch.push(ingestionEvent);
          eventIndexByEnvelopeId.set(ingestionEvent.id, eventIndex);
        }
      }
    }

    const payload: LangfuseBatchPayload = {
      batch,
      metadata: {
        sdk_name: 'universal-llm-adapter',
        sdk_version: '1.0.0'
      }
    };

    return { payload, eventIndexByEnvelopeId };
  }

  /**
   * Build Langfuse events for an LLM request.
   */
  private buildRequestEvents(
    event: ObservabilityLLMRequestEvent,
    eventId?: string
  ): LangfuseIngestionEvent[] {
    const events: LangfuseIngestionEvent[] = [];
    const traceEnvelopeId = eventId ? stableEnvelopeId(eventId, 'trace-create') : randomUUID();
    const generationEnvelopeId = eventId ? stableEnvelopeId(eventId, 'generation-create') : randomUUID();
    const generationId = event.generationId ?? `${event.traceId}-gen`;

    // Create trace event
    events.push({
      id: traceEnvelopeId,
      type: 'trace-create',
      timestamp: event.timestamp,
      body: {
        id: event.traceId,
        timestamp: event.timestamp,
        name: `${event.provider}/${event.model}`,
        sessionId: event.sessionId,
        input: event.messages,
        metadata: {
          ...event.metadata,
          provider: event.provider,
          model: event.model,
          tools: event.tools,
          requestPayload: event.requestPayload
        }
      }
    });

    // Create generation-create event
    events.push({
      id: generationEnvelopeId,
      type: 'generation-create',
      timestamp: event.timestamp,
      body: {
        id: generationId,
        traceId: event.traceId,
        name: 'llm-request',
        startTime: event.timestamp,
        model: event.model,
        input: event.messages,
        modelParameters: event.settings,
        metadata: {
          provider: event.provider,
          requestPayload: event.requestPayload
        }
      }
    });

    return events;
  }

  /**
   * Build Langfuse events for an LLM response.
   */
  private buildResponseEvents(
    event: ObservabilityLLMResponseEvent,
    eventId?: string
  ): LangfuseIngestionEvent[] {
    const events: LangfuseIngestionEvent[] = [];
    const envelopeId = eventId ? stableEnvelopeId(eventId, 'generation-update') : randomUUID();
    const generationId = event.generationId ?? `${event.traceId}-gen`;

    // Create generation-update event
    const body: Record<string, unknown> = {
      id: generationId,
      traceId: event.traceId,
      endTime: event.timestamp,
      output: event.content,
      metadata: {
        ...event.metadata,
        provider: event.provider,
        model: event.model,
        toolCalls: event.toolCalls,
        rawResponse: event.rawResponse
      }
    };

    // Add usage if present
    if (event.usage) {
      body.usage = {
        input: event.usage.promptTokens,
        output: event.usage.completionTokens,
        total: event.usage.totalTokens,
        unit: 'TOKENS'
      };
    }

    // Add duration as calculated cost placeholder
    if (event.durationMs !== undefined) {
      body.metadata = {
        ...(body.metadata as Record<string, unknown>),
        durationMs: event.durationMs
      };
    }

    // Add error level if present
    if (event.error) {
      body.level = 'ERROR';
      body.statusMessage = event.error.message;
      body.metadata = {
        ...(body.metadata as Record<string, unknown>),
        errorCode: event.error.code,
        retryable: event.error.retryable
      };
    }

    events.push({
      id: envelopeId,
      type: 'generation-update',
      timestamp: event.timestamp,
      body
    });

    return events;
  }

  /**
   * Send a batch payload to Langfuse.
   *
   * @param payload - The built payload from buildBatch
   * @param manifest - The provider manifest for configuration
   * @returns Batch result with per-envelope outcomes
   */
  async sendBatch(
    payload: unknown,
    manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): Promise<ObservabilityBatchResult> {
    const batchPayload = payload as LangfuseBatchPayload;
    const url = resolveIngestionUrl(manifest, context);
    const timeoutMs = context?.timeoutMs;

    // Build headers
    const headers: Record<string, string> = {
      ...manifest.endpoint.headers
    };

    // Add auth if configured
    if (manifest.auth) {
      if (manifest.auth.type === 'basic') {
        const publicKey = manifest.auth.publicKeyEnv
          ? process.env[manifest.auth.publicKeyEnv] || ''
          : '';
        const secretKey = manifest.auth.secretKeyEnv
          ? process.env[manifest.auth.secretKeyEnv] || ''
          : '';

        if (publicKey && secretKey) {
          headers['Authorization'] = buildBasicAuth(publicKey, secretKey);
        }
      }
    }

    try {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }

      const response = await fetch(url, {
        method: manifest.endpoint.method,
        headers,
        body: JSON.stringify(batchPayload),
        signal: controller.signal
      }).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });

      // Handle response
      if (response.status === 200 || response.status === 207) {
        // Parse response for per-event outcomes
        const result = await response.json() as LangfuseIngestionResponse;
        const outcomes: ObservabilityEnvelopeOutcome[] = [];

        // Process successes
        for (const success of result.successes || []) {
          outcomes.push({
            envelopeId: success.id,
            success: true,
            status: success.status
          });
        }

        // Process errors
        for (const error of result.errors || []) {
          outcomes.push({
            envelopeId: error.id,
            success: false,
            status: error.status,
            error: error.message || error.error,
            retryable: isRetryableStatus(error.status)
          });
        }

        // If no outcomes parsed, assume all success for 200
        if (outcomes.length === 0 && response.status === 200) {
          for (const event of batchPayload.batch) {
            outcomes.push({
              envelopeId: event.id,
              success: true,
              status: 200
            });
          }
        }

        // Overall success if no errors array or empty errors array
        const hasErrors = result.errors && result.errors.length > 0;
        return {
          success: !hasErrors,
          outcomes
        };
      }

      // Handle error responses
      const retryable = isRetryableStatus(response.status);
      const outcomes: ObservabilityEnvelopeOutcome[] = batchPayload.batch.map(event => ({
        envelopeId: event.id,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}: ${response.statusText}`,
        retryable
      }));

      return { success: false, outcomes };
    } catch (error: any) {
      // Network or other errors - mark all as retryable
      const outcomes: ObservabilityEnvelopeOutcome[] = batchPayload.batch.map(event => ({
        envelopeId: event.id,
        success: false,
        error: error.message,
        retryable: true
      }));

      return { success: false, outcomes };
    }
  }
}

// Default export for compat loading (PluginRegistry expects a constructor export)
export default LangfuseCompat;
