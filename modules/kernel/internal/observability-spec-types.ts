/**
 * Observability specification types.
 * Provider-agnostic types for optional observability/tracing export.
 *
 * This module defines the per-call configuration for observability.
 * Observability is disabled by default and must be explicitly enabled.
 */

/**
 * Per-call observability configuration.
 * Can override global defaults from DefaultSettings.observability.
 *
 * @example
 * ```typescript
 * const spec: LLMCallSpec = {
 *   // ... other fields
 *   observability: {
 *     enabled: true,
 *     provider: 'example-observability-provider',
 *     traceId: 'custom-trace-123'
 *   }
 * };
 * ```
 */
/**
 * Context for observability during LLM execution.
 * Holds the exporter and trace information for the current call.
 */
export interface ObservabilityContext {
  /**
   * The observability exporter for recording events.
   */
  exporter: {
    recordLLMRequest: (event: import('./observability.js').ObservabilityLLMRequestEvent) =>
      import('./observability.js').ObservabilityRecordResult;
    recordLLMResponse: (event: import('./observability.js').ObservabilityLLMResponseEvent) =>
      import('./observability.js').ObservabilityRecordResult;
    flush: () => Promise<void>;
  };

  /**
   * Trace ID for the current call.
   */
  traceId: string;

  /**
   * Session ID for grouping related traces.
   */
  sessionId?: string;

  /**
   * Additional metadata to include in events.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Context passed through the LLM execution path.
 * Contains tool info, metadata, and optionally observability.
 */
export interface RunContext {
  /**
   * Names of available tools.
   */
  tools?: string[];

  /**
   * MCP server names being used.
   */
  mcpServers?: string[];

  /**
   * Mapping from sanitized tool names to original names.
   */
  toolNameMap?: Record<string, string>;

  /**
   * Call metadata (correlationId, etc.).
   */
  metadata?: Record<string, unknown>;

  /**
   * Observability context for recording LLM events.
   * Only present when observability is enabled.
   */
  observability?: ObservabilityContext;
}

export interface ObservabilitySpec {
  /**
   * Whether observability export is enabled for this call.
   * Overrides global default when specified.
   */
  enabled?: boolean;

  /**
   * Observability provider ID.
   * Must match an ID from plugins/observability-providers/*.json.
   * Overrides global default when specified.
   */
  provider?: string;

  /**
   * Custom trace ID for this call.
   * If not provided, uses spec.metadata.correlationId or generates a UUID.
   */
  traceId?: string;

  /**
   * Session ID to group related traces.
   * If not provided, uses runtime batch ID when available.
   */
  sessionId?: string;

  /**
   * Provider-specific configuration overrides.
   * Passed through to the observability compat layer.
   * Shape depends on the provider; opaque to core.
   */
  providerConfig?: Record<string, unknown>;

  // ========================================
  // Queue/export tuning (optional overrides)
  // ========================================

  /**
   * Number of events to accumulate before triggering a flush.
   * Lower values = more frequent exports, higher latency impact.
   */
  flushAt?: number;

  /**
   * Maximum interval (ms) between flushes.
   * Ensures events are exported even with low volume.
   */
  flushIntervalMs?: number;

  /**
   * Maximum number of events to hold in the queue.
   * When exceeded, oldest events are dropped with a warning.
   */
  maxQueueSize?: number;

  /**
   * Maximum retry attempts for failed exports.
   */
  maxAttempts?: number;

  /**
   * Base delay (ms) for exponential backoff on retries.
   */
  baseDelayMs?: number;

  /**
   * Maximum delay (ms) cap for exponential backoff.
   */
  maxDelayMs?: number;

  /**
   * HTTP request timeout (ms) for export requests.
   */
  timeoutMs?: number;

  /**
   * Maximum UTF-8 bytes for any exported attribute string value.
   * Provider compats should truncate large fields to stay within ingestion limits.
   */
  maxAttributeValueBytes?: number;
}
