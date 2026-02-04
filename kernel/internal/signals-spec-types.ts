/**
 * Signals specification types.
 * Provider-agnostic types for optional signals export (errors/warnings/info).
 *
 * Signals are exported via plugin providers/compats, similar to observability, but support
 * multi-target fanout (multiple providers enabled simultaneously).
 */

export interface SignalsTargetSpec {
  /** Signals provider ID (must match plugins/signals-providers/*.json id) */
  provider: string;

  /** Provider-specific configuration overrides (opaque to core) */
  providerConfig?: Record<string, unknown>;
}

export interface SignalsSpec {
  /** Whether signals export is enabled for this call */
  enabled?: boolean;

  /** Multi-target configuration */
  targets?: SignalsTargetSpec[];

  /** Queue/export tuning overrides (optional) */
  flushAt?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  maxAttributeValueBytes?: number;
}

