import type { JsonObject } from './json.js';

/**
 * Shared batched HTTP exporter types.
 *
 * These types support multiple modules (e.g. observability, signals) that export
 * provider-agnostic events via plugin compats and provider manifests.
 */

/**
 * Authentication configuration for HTTP exporters.
 */
export interface HttpAuthConfig {
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
 * Provider limits for batching.
 */
export interface HttpProviderLimits {
  /**
   * Maximum bytes per batch request.
   * Batches exceeding this are split.
   */
  maxBatchBytes?: number;
}

/**
 * Generic HTTP exporter provider manifest (loaded from JSON).
 */
export interface HttpExportProviderManifest {
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
  auth?: HttpAuthConfig;

  /** Provider-specific limits */
  limits?: HttpProviderLimits;

  /** Optional provider-specific defaults */
  defaults?: JsonObject;

  /** Optional metadata */
  metadata?: JsonObject;
}

/**
 * Outcome of sending an individual envelope to the provider.
 */
export interface HttpEnvelopeOutcome {
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
 * Result from sending a batch to the provider.
 */
export interface HttpBatchResult {
  /** Overall success (all envelopes accepted) */
  success: boolean;

  /** Per-envelope outcomes (for partial success responses like 207 Multi-Status) */
  outcomes: HttpEnvelopeOutcome[];
}

/**
 * Optional context passed to compat modules.
 */
export interface HttpCompatContext {
  /**
   * Provider-specific configuration overrides (opaque to core).
   */
  providerConfig?: Record<string, unknown>;

  /**
   * Stable event IDs aligned with the `events[]` passed to `buildBatch()`.
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
   */
  signal?: AbortSignal;

  /**
   * Maximum UTF-8 bytes for any exported attribute string value.
   * Compat implementations should truncate large fields to stay within ingestion limits.
   */
  maxAttributeValueBytes?: number;
}

/**
 * Interface for batched HTTP exporter compat modules.
 */
export interface IHttpBatchCompat<M extends HttpExportProviderManifest = HttpExportProviderManifest> {
  /**
   * Build a batch payload from events for sending to the provider.
   */
  buildBatch(
    events: unknown[],
    manifest: M,
    context?: HttpCompatContext
  ): {
    payload: unknown;
    eventIndexByEnvelopeId: Map<string, number>;
  };

  /**
   * Send a batch payload to the provider.
   */
  sendBatch(
    payload: unknown,
    manifest: M,
    context?: HttpCompatContext
  ): Promise<HttpBatchResult>;
}

