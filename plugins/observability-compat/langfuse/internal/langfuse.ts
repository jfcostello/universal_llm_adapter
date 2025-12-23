/**
 * Langfuse observability compat implementation.
 * Transforms provider-agnostic events into Langfuse ingestion format.
 */

import type {
  IObservabilityCompat,
  ObservabilityProviderManifest,
  ObservabilityBatchResult,
  ObservabilityEnvelopeOutcome,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent
} from '../../../../modules/kernel/index.js';
import { randomUUID } from 'crypto';

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
  // istanbul ignore next - defensive fallback, unreachable with current buildUrl regex
  return template;
}

/**
 * Build URL from template with environment variable resolution.
 */
function buildUrl(urlTemplate: string): string {
  return urlTemplate.replace(/\$\{[^}]+\}/g, (match) => resolveEnvVar(match));
}

/**
 * Determine if an HTTP status code indicates a retryable error.
 */
function isRetryableStatus(status: number): boolean {
  // 429 Too Many Requests, 5xx Server Errors
  return status === 429 || (status >= 500 && status < 600);
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
    manifest: ObservabilityProviderManifest
  ): {
    payload: LangfuseBatchPayload;
    envelopeByEventId: Map<string, string>;
  } {
    const batch: LangfuseIngestionEvent[] = [];
    const envelopeByEventId = new Map<string, string>();

    for (const event of events) {
      const typedEvent = event as ObservabilityLLMRequestEvent | ObservabilityLLMResponseEvent;

      // Determine if this is a request or response
      const isRequest = 'messages' in typedEvent;

      if (isRequest) {
        const requestEvent = typedEvent as ObservabilityLLMRequestEvent;
        const ingestionEvents = this.buildRequestEvents(requestEvent);

        for (const ingestionEvent of ingestionEvents) {
          batch.push(ingestionEvent);
          // Map the original event's trace ID to the envelope ID for correlation
          envelopeByEventId.set(requestEvent.traceId, ingestionEvent.id);
        }
      } else {
        const responseEvent = typedEvent as ObservabilityLLMResponseEvent;
        const ingestionEvents = this.buildResponseEvents(responseEvent);

        for (const ingestionEvent of ingestionEvents) {
          batch.push(ingestionEvent);
          envelopeByEventId.set(responseEvent.traceId, ingestionEvent.id);
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

    return { payload, envelopeByEventId };
  }

  /**
   * Build Langfuse events for an LLM request.
   */
  private buildRequestEvents(event: ObservabilityLLMRequestEvent): LangfuseIngestionEvent[] {
    const events: LangfuseIngestionEvent[] = [];
    const traceEnvelopeId = randomUUID();
    const generationEnvelopeId = randomUUID();

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
          tools: event.tools
        }
      }
    });

    // Create generation-create event
    events.push({
      id: generationEnvelopeId,
      type: 'generation-create',
      timestamp: event.timestamp,
      body: {
        id: `${event.traceId}-gen`,
        traceId: event.traceId,
        name: 'llm-request',
        startTime: event.timestamp,
        model: event.model,
        input: event.messages,
        modelParameters: event.settings,
        metadata: {
          provider: event.provider
        }
      }
    });

    return events;
  }

  /**
   * Build Langfuse events for an LLM response.
   */
  private buildResponseEvents(event: ObservabilityLLMResponseEvent): LangfuseIngestionEvent[] {
    const events: LangfuseIngestionEvent[] = [];
    const envelopeId = randomUUID();

    // Create generation-update event
    const body: Record<string, unknown> = {
      id: `${event.traceId}-gen`,
      traceId: event.traceId,
      endTime: event.timestamp,
      output: event.content,
      metadata: {
        ...event.metadata,
        provider: event.provider,
        model: event.model,
        toolCalls: event.toolCalls
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
    manifest: ObservabilityProviderManifest
  ): Promise<ObservabilityBatchResult> {
    const batchPayload = payload as LangfuseBatchPayload;
    const url = buildUrl(manifest.endpoint.urlTemplate);

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
      const response = await fetch(url, {
        method: manifest.endpoint.method,
        headers,
        body: JSON.stringify(batchPayload)
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

// Default export for compat loading
export default new LangfuseCompat();
