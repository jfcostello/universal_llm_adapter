import type { JsonObject } from './json.js';

/**
 * Authentication configuration for observability providers.
 */
export interface ObservabilityAuthConfig {
  /**
   * Authentication type.
   * - basic: HTTP Basic Auth (public key as username, secret key as password)
   * - bearer: Bearer token
   * - header: Custom header-based auth
   */
  type: 'basic' | 'bearer' | 'header';

  /**
   * Environment variable name for the public key (basic auth username).
   */
  publicKeyEnv?: string;

  /**
   * Environment variable name for the secret key (basic auth password or bearer token).
   */
  secretKeyEnv?: string;

  /**
   * Custom header name (for header-based auth).
   */
  headerName?: string;

  /**
   * Environment variable name for custom header value.
   */
  headerValueEnv?: string;
}

/**
 * Provider limits for observability batching.
 */
export interface ObservabilityProviderLimits {
  /**
   * Maximum bytes per batch request.
   * Batches exceeding this are split.
   */
  maxBatchBytes?: number;
}

/**
 * Observability provider manifest (loaded from JSON).
 * Configures how to send events to an observability platform.
 */
export interface ObservabilityProviderManifest {
  /** Unique provider ID */
  id: string;

  /** Compat module name to use for building/sending payloads */
  compat: string;

  /** Endpoint configuration for ingestion */
  endpoint: {
    /** URL template for the ingestion endpoint */
    urlTemplate: string;
    /** HTTP method (typically POST) */
    method: string;
    /** Optional headers to include */
    headers?: Record<string, string>;
  };

  /** Authentication configuration */
  auth?: ObservabilityAuthConfig;

  /** Provider-specific limits */
  limits?: ObservabilityProviderLimits;

  /** Optional provider-specific defaults */
  defaults?: JsonObject;

  /** Optional metadata */
  metadata?: JsonObject;
}

/**
 * Outcome of sending an individual envelope to the observability provider.
 */
export interface ObservabilityEnvelopeOutcome {
  /** Envelope ID that was sent */
  envelopeId: string;

  /** Whether this envelope was accepted */
  success: boolean;

  /** HTTP status code for this envelope (if provider returns per-envelope status) */
  status?: number;

  /** Error message if failed */
  error?: string;

  /** Whether this failure is retryable */
  retryable?: boolean;
}

/**
 * Result from sending a batch to the observability provider.
 */
export interface ObservabilityBatchResult {
  /** Overall success (all envelopes accepted) */
  success: boolean;

  /** Per-envelope outcomes (for partial success responses like 207 Multi-Status) */
  outcomes: ObservabilityEnvelopeOutcome[];
}

/**
 * Optional context passed to observability compat modules.
 * This enables provider-specific runtime overrides without leaking provider logic into core modules.
 */
export interface ObservabilityCompatContext {
  /**
   * Provider-specific configuration overrides (opaque to core).
   */
  providerConfig?: Record<string, unknown>;

  /**
   * Stable event IDs aligned with the `events[]` passed to `IObservabilityCompat.buildBatch()`.
   * Compat implementations can use these to generate deterministic envelope IDs for safe retries/deduping.
   */
  eventIds?: string[];

  /**
   * Timeout (ms) for provider export requests.
   * Compat implementations should enforce this via abort/timeout handling.
   */
  timeoutMs?: number;

  /**
   * Optional shutdown signal for exporters.
   * When provided and aborted, compat implementations should abort any in-flight
   * export requests and stop retry/backoff work as quickly as possible.
   *
   * This exists so `observability.shutdownTimeoutMs` can be a true hard cap that
   * does not keep the process alive under backpressure.
   */
  signal?: AbortSignal;

  /**
   * Maximum UTF-8 bytes for any exported attribute string value.
   * Compat implementations should truncate large fields to stay within ingestion limits.
   */
  maxAttributeValueBytes?: number;
}

/**
 * Interface for observability compat modules.
 * Implementations translate provider-agnostic events into provider-specific payloads.
 */
export interface IObservabilityCompat {
  /**
   * Build a batch payload from events for sending to the provider.
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
    payload: unknown;
    /**
     * Maps each provider envelope ID (returned in `ObservabilityBatchResult.outcomes`)
     * to the source event index in the `events` array passed to `buildBatch()`.
     *
     * This allows the exporter to retry the correct subset of events on partial failures.
     */
    eventIndexByEnvelopeId: Map<string, number>;
  };

  /**
   * Send a batch payload to the observability provider.
   *
   * @param payload - The built payload from buildBatch
   * @param manifest - The provider manifest for configuration
   * @returns Batch result with per-envelope outcomes
   */
  sendBatch(
    payload: unknown,
    manifest: ObservabilityProviderManifest,
    context?: ObservabilityCompatContext
  ): Promise<ObservabilityBatchResult>;
}
