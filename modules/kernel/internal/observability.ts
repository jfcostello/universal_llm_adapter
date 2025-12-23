/**
 * Kernel-level observability dependency injection.
 * Mirrors the LoggingDeps pattern for observability export.
 *
 * Observability is disabled by default. When disabled, noop implementations
 * are used that incur no overhead.
 */

import type { PluginRegistry } from './registry.js';
import type { ObservabilitySpec } from './observability-spec-types.js';

/**
 * Result of recording an observability event.
 */
export interface ObservabilityRecordResult {
  /** Unique ID for this event (for correlating with outcomes) */
  eventId: string;

  /** Whether the event was accepted into the queue */
  queued: boolean;

  /** If not queued, reason why (e.g., 'disabled', 'queue_full') */
  reason?: string;
}

/**
 * LLM request event data for observability.
 * Provider-agnostic representation of an LLM request.
 */
export interface ObservabilityLLMRequestEvent {
  /** Trace ID for grouping related events */
  traceId: string;

  /** Optional session ID */
  sessionId?: string;

  /** Request timestamp (ISO 8601) */
  timestamp: string;

  /** Provider ID */
  provider: string;

  /** Model ID */
  model: string;

  /** Messages sent to the model */
  messages: unknown[];

  /** Tools available to the model */
  tools?: unknown[];

  /** Settings/parameters */
  settings?: Record<string, unknown>;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * LLM response event data for observability.
 * Provider-agnostic representation of an LLM response.
 */
export interface ObservabilityLLMResponseEvent {
  /** Trace ID (must match the request) */
  traceId: string;

  /** Response timestamp (ISO 8601) */
  timestamp: string;

  /** Provider ID */
  provider: string;

  /** Model ID */
  model: string;

  /** Response content */
  content: unknown[];

  /** Tool calls in the response */
  toolCalls?: unknown[];

  /** Usage statistics */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };

  /** Duration in milliseconds */
  durationMs?: number;

  /** Error if the request failed */
  error?: {
    message: string;
    code?: string;
    retryable?: boolean;
  };

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Observability exporter interface.
 * Used internally by the observability module to manage the queue and export.
 */
export interface IObservabilityExporter {
  /**
   * Record an LLM request event.
   */
  recordLLMRequest(event: ObservabilityLLMRequestEvent): ObservabilityRecordResult;

  /**
   * Record an LLM response event.
   */
  recordLLMResponse(event: ObservabilityLLMResponseEvent): ObservabilityRecordResult;

  /**
   * Flush all pending events.
   * Returns when all events have been sent (or failed after retries).
   */
  flush(): Promise<void>;

  /**
   * Shutdown the exporter.
   * Flushes pending events and stops background processing.
   */
  shutdown(): Promise<void>;
}

/**
 * Observability dependency injection container.
 * Similar to LoggingDeps, provides factory functions for observability.
 */
export interface ObservabilityDeps {
  /**
   * Check if observability is enabled.
   * When false, all record methods are no-ops.
   */
  isEnabled: () => boolean;

  /**
   * Get the observability exporter.
   * Returns a noop exporter if observability is disabled.
   */
  getExporter: () => IObservabilityExporter;

  /**
   * Flush and shutdown observability.
   * Should be called during application shutdown.
   */
  shutdown: () => Promise<void>;
}

// ============================================================
// NOOP IMPLEMENTATIONS
// ============================================================

function createNoopRecordResult(): ObservabilityRecordResult {
  return {
    eventId: '',
    queued: false,
    reason: 'disabled'
  };
}

function createNoopExporter(): IObservabilityExporter {
  const noopResult = createNoopRecordResult();
  return {
    recordLLMRequest: () => noopResult,
    recordLLMResponse: () => noopResult,
    flush: async () => {},
    shutdown: async () => {}
  };
}

let cachedNoopExporter: IObservabilityExporter | null = null;

const noopObservabilityDeps: ObservabilityDeps = {
  isEnabled: () => false,
  getExporter: () => cachedNoopExporter ?? (cachedNoopExporter = createNoopExporter()),
  shutdown: async () => {
    cachedNoopExporter = null;
  }
};

/**
 * Get the noop observability deps.
 * Use this when observability is disabled.
 */
export function getNoopObservabilityDeps(): ObservabilityDeps {
  return noopObservabilityDeps;
}

/**
 * Resolve observability deps with optional overrides.
 * Falls back to noop for any missing overrides.
 *
 * @param overrides - Partial deps to override defaults
 * @returns Complete ObservabilityDeps
 */
export function resolveObservabilityDeps(overrides: Partial<ObservabilityDeps> = {}): ObservabilityDeps {
  return {
    isEnabled: overrides.isEnabled ?? noopObservabilityDeps.isEnabled,
    getExporter: overrides.getExporter ?? noopObservabilityDeps.getExporter,
    shutdown: overrides.shutdown ?? noopObservabilityDeps.shutdown
  };
}

/**
 * Configuration for creating observability deps.
 */
export interface CreateObservabilityDepsConfig {
  /** Plugin registry for loading observability providers/compats */
  registry: PluginRegistry;

  /** Per-call observability spec (overrides defaults) */
  spec?: ObservabilitySpec;
}
