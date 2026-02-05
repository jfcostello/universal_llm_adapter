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
  exporter: Pick<
    import('./observability.js').IObservabilityExporter,
    | 'recordLLMRequest'
    | 'recordLLMResponse'
    | 'recordToolExecution'
    | 'recordSignal'
    | 'recordTraceUpdate'
    | 'flush'
  >;

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

  /**
   * Capture level for message/content bodies.
   * - none: do not export prompt/response bodies
   * - text: export only text content parts (exclude tool results/doc blobs)
   * - full: export full structured message/content payloads
   */
  captureMessages: 'none' | 'text' | 'full';

  /**
   * Whether to export tool-call arguments/metadata.
   * Defaults to false for safety/performance.
   */
  captureToolArgs: boolean;

  /**
   * Whether to export the final provider request payload (`requestPayload`).
   * Defaults to false for safety/performance.
   */
  captureRequestPayload: boolean;

  /**
   * Whether to export raw provider response payloads when available (`rawResponse`).
   * Defaults to false for safety/performance.
   */
  captureRawResponse: boolean;

  /**
   * Sampling rate (0..1). When < 1, calls may be skipped entirely.
   */
  sampleRate: number;

  /**
   * Maximum UTF-8 bytes for aggregated input text exported by providers/compats.
   * Provider compats may apply stricter truncation.
   */
  maxInputTextBytes: number;

  /**
   * Maximum UTF-8 bytes for aggregated output text exported by providers/compats.
   * Provider compats may apply stricter truncation.
   */
  maxOutputTextBytes: number;

  /**
   * Maximum UTF-8 bytes for JSON-like serialized attributes (e.g. observation input/output).
   * Provider compats may apply stricter truncation.
   */
  maxJsonBytes: number;
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
   * Tool calls executed so far in this run (for observability enrichment).
   * When present, may be used to include tool call metadata even if the final model
   * response does not contain tool calls.
   */
  toolCallsSoFar?: import('./types.js').ToolCall[];

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

export interface ObservabilityTargetExportSpec {
  traces?: boolean;
  tools?: boolean;
  signals?: boolean;
  traceUpdates?: boolean;
}

export interface ObservabilityTargetSpec {
  /**
   * Observability provider ID.
   * Must match an ID from plugins/observability-providers/*.json.
   */
  provider: string;

  /**
   * Provider-specific configuration overrides.
   * Passed through to the observability compat layer.
   * Shape depends on the provider; opaque to core.
   */
  providerConfig?: Record<string, unknown>;

  /**
   * Per-target export routing configuration.
   * When omitted, all event categories are exported.
   */
  export?: ObservabilityTargetExportSpec;

  // ========================================
  // Queue/export tuning (optional overrides)
  // ========================================

  flushAt?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  maxAttributeValueBytes?: number;
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

  /**
   * Multi-target observability configuration.
   * When provided, overrides single-provider `provider` config.
   */
  targets?: ObservabilityTargetSpec[];

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

  // ========================================
  // Capture controls (safety/performance)
  // ========================================

  /**
   * Capture level for message/content bodies.
   * Defaults to `DefaultSettings.observability.captureMessages`.
   */
  captureMessages?: 'none' | 'text' | 'full';

  /**
   * Whether to capture tool-call arguments/metadata.
   * Defaults to `DefaultSettings.observability.captureToolArgs`.
   */
  captureToolArgs?: boolean;

  /**
   * Whether to capture the final provider request payload (`requestPayload`).
   * Defaults to `DefaultSettings.observability.captureRequestPayload`.
   */
  captureRequestPayload?: boolean;

  /**
   * Whether to capture raw provider response payloads when available (`rawResponse`).
   * Defaults to `DefaultSettings.observability.captureRawResponse`.
   */
  captureRawResponse?: boolean;

  /**
   * Sampling rate (0..1). When < 1, calls may be skipped entirely.
   * Defaults to `DefaultSettings.observability.sampleRate`.
   */
  sampleRate?: number;

  /**
   * Maximum UTF-8 bytes for aggregated input text exported by providers/compats.
   * Defaults to `DefaultSettings.observability.maxInputTextBytes`.
   */
  maxInputTextBytes?: number;

  /**
   * Maximum UTF-8 bytes for aggregated output text exported by providers/compats.
   * Defaults to `DefaultSettings.observability.maxOutputTextBytes`.
   */
  maxOutputTextBytes?: number;

  /**
   * Maximum UTF-8 bytes for JSON-like serialized attributes (e.g. observation input/output).
   * Defaults to `DefaultSettings.observability.maxJsonBytes`.
   */
  maxJsonBytes?: number;
}
