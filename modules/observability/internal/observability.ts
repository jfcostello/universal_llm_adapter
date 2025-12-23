/**
 * Core observability module implementation.
 * Provides event queue, batch exporter, and exponential backoff retry logic.
 */

import type {
  PluginRegistry,
  ObservabilitySpec,
  ObservabilityDeps,
  IObservabilityExporter,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilityRecordResult,
  IObservabilityCompat,
  ObservabilityProviderManifest,
  DefaultSettings
} from '../../kernel/index.js';
import {
  getNoopObservabilityDeps,
  resolveObservabilityDeps,
  getDefaults
} from '../../kernel/index.js';
import { randomUUID } from 'crypto';

// ============================================================
// EVENT TYPES
// ============================================================

/**
 * Internal event wrapper with ID and metadata.
 */
interface QueuedEvent {
  id: string;
  type: 'llm_request' | 'llm_response';
  data: ObservabilityLLMRequestEvent | ObservabilityLLMResponseEvent;
  timestamp: number;
  attempts: number;
}

// ============================================================
// EXPONENTIAL BACKOFF
// ============================================================

/**
 * Calculate delay with exponential backoff and jitter.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @returns Delay in milliseconds with jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap at maxDelayMs
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: +/- 25% randomness
  const jitter = 0.5 + Math.random(); // 0.5 to 1.5
  return Math.floor(cappedDelay * jitter);
}

/**
 * Sleep for a specified duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// OBSERVABILITY EXPORTER
// ============================================================

/**
 * Configuration for the observability exporter.
 */
export interface ObservabilityExporterConfig {
  /** Observability provider ID */
  provider: string;

  /** Flush when queue reaches this size */
  flushAt: number;

  /** Flush interval in milliseconds */
  flushIntervalMs: number;

  /** Maximum queue size (events dropped if exceeded) */
  maxQueueSize: number;

  /** Maximum retry attempts per batch */
  maxAttempts: number;

  /** Base delay for exponential backoff */
  baseDelayMs: number;

  /** Maximum delay cap for backoff */
  maxDelayMs: number;

  /** HTTP timeout for export requests */
  timeoutMs: number;
}

/**
 * Observability exporter implementation.
 * Manages event queue and exports to observability providers.
 */
export class ObservabilityExporter implements IObservabilityExporter {
  private queue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private shuttingDown = false;
  private flushPromise: Promise<void> | null = null;

  constructor(
    private config: ObservabilityExporterConfig,
    private compat: IObservabilityCompat,
    private manifest: ObservabilityProviderManifest
  ) {
    this.startFlushTimer();
  }

  /**
   * Start the periodic flush timer.
   */
  private startFlushTimer(): void {
    if (this.flushTimer || this.shuttingDown) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.shuttingDown && this.queue.length > 0) {
        this.flush().catch(() => {});
      }
      this.startFlushTimer();
    }, this.config.flushIntervalMs);
  }

  /**
   * Stop the flush timer.
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Generate a unique event ID.
   */
  private generateEventId(): string {
    return randomUUID();
  }

  /**
   * Enqueue an event.
   */
  private enqueue(type: QueuedEvent['type'], data: QueuedEvent['data']): ObservabilityRecordResult {
    const eventId = this.generateEventId();

    if (this.shuttingDown) {
      return { eventId, queued: false, reason: 'shutdown' };
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      // Drop oldest events to make room
      const dropped = this.queue.shift();
      if (dropped) {
        console.warn(`[observability] Queue full, dropped event ${dropped.id}`);
      }
    }

    const event: QueuedEvent = {
      id: eventId,
      type,
      data,
      timestamp: Date.now(),
      attempts: 0
    };

    this.queue.push(event);

    // Trigger flush if queue reaches threshold
    if (this.queue.length >= this.config.flushAt) {
      this.flush().catch(() => {});
    }

    return { eventId, queued: true };
  }

  recordLLMRequest(event: ObservabilityLLMRequestEvent): ObservabilityRecordResult {
    return this.enqueue('llm_request', event);
  }

  recordLLMResponse(event: ObservabilityLLMResponseEvent): ObservabilityRecordResult {
    return this.enqueue('llm_response', event);
  }

  async flush(): Promise<void> {
    // If already flushing, wait for current flush
    if (this.flushing && this.flushPromise) {
      return this.flushPromise;
    }

    if (this.queue.length === 0) {
      return;
    }

    this.flushing = true;
    this.flushPromise = this.doFlush();

    try {
      await this.flushPromise;
    } finally {
      this.flushing = false;
      this.flushPromise = null;
    }
  }

  private async doFlush(): Promise<void> {
    // Take all events from queue
    const events = [...this.queue];
    this.queue = [];

    if (events.length === 0) {
      return;
    }

    let attempt = 0;
    let eventsToRetry = events;

    while (eventsToRetry.length > 0 && attempt < this.config.maxAttempts) {
      try {
        // Build batch
        const { payload, envelopeByEventId } = this.compat.buildBatch(
          eventsToRetry.map(e => e.data),
          this.manifest
        );

        // Send batch
        const result = await this.compat.sendBatch(payload, this.manifest);

        if (result.success) {
          // All events sent successfully
          eventsToRetry = [];
        } else {
          // Check per-envelope outcomes for retryable failures
          const retryableEventIds = new Set<string>();

          for (const outcome of result.outcomes) {
            if (!outcome.success && outcome.retryable) {
              // Find event IDs that map to this envelope
              for (const event of eventsToRetry) {
                if (envelopeByEventId.get(event.id) === outcome.envelopeId) {
                  retryableEventIds.add(event.id);
                }
              }
            }
          }

          // Keep only retryable events
          eventsToRetry = eventsToRetry.filter(e => retryableEventIds.has(e.id));
        }
      } catch (error: any) {
        // Network error or unexpected failure - retry all
        console.warn(`[observability] Batch export failed (attempt ${attempt + 1}/${this.config.maxAttempts}): ${error.message}`);
      }

      if (eventsToRetry.length > 0 && attempt < this.config.maxAttempts - 1) {
        // Wait before retry
        const delay = calculateBackoffDelay(attempt, this.config.baseDelayMs, this.config.maxDelayMs);
        await sleep(delay);
      }

      attempt++;
    }

    if (eventsToRetry.length > 0) {
      console.warn(`[observability] Failed to export ${eventsToRetry.length} events after ${this.config.maxAttempts} attempts`);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopFlushTimer();

    // Final flush
    if (this.queue.length > 0) {
      await this.flush();
    }
  }
}

// ============================================================
// FACTORY FUNCTIONS
// ============================================================

/**
 * Resolve observability configuration from spec and defaults.
 */
function resolveConfig(
  spec: ObservabilitySpec | undefined,
  defaults: DefaultSettings['observability']
): ObservabilityExporterConfig | null {
  const enabled = spec?.enabled ?? defaults.enabled;

  if (!enabled) {
    return null;
  }

  const provider = spec?.provider ?? defaults.provider;

  if (!provider) {
    console.warn('[observability] No provider specified, disabling');
    return null;
  }

  return {
    provider,
    flushAt: spec?.flushAt ?? defaults.flushAt,
    flushIntervalMs: spec?.flushIntervalMs ?? defaults.flushIntervalMs,
    maxQueueSize: spec?.maxQueueSize ?? defaults.maxQueueSize,
    maxAttempts: spec?.maxAttempts ?? defaults.maxAttempts,
    baseDelayMs: spec?.baseDelayMs ?? defaults.baseDelayMs,
    maxDelayMs: spec?.maxDelayMs ?? defaults.maxDelayMs,
    timeoutMs: spec?.timeoutMs ?? defaults.timeoutMs
  };
}

/**
 * Create observability deps for a given configuration.
 *
 * @param registry - Plugin registry for loading providers/compats
 * @param spec - Optional per-call observability spec
 * @returns ObservabilityDeps (noop if disabled)
 */
export async function createObservabilityDeps(
  registry: PluginRegistry,
  spec?: ObservabilitySpec
): Promise<ObservabilityDeps> {
  const defaults = getDefaults().observability;
  const config = resolveConfig(spec, defaults);

  if (!config) {
    return getNoopObservabilityDeps();
  }

  try {
    // Load provider manifest and compat
    const manifest = await registry.getObservabilityProvider(config.provider);
    const compat = await registry.getObservabilityCompat(manifest.compat);

    // Create exporter
    const exporter = new ObservabilityExporter(config, compat, manifest);

    return {
      isEnabled: () => true,
      getExporter: () => exporter,
      shutdown: async () => {
        await exporter.shutdown();
      }
    };
  } catch (error: any) {
    console.warn(`[observability] Failed to initialize: ${error.message}`);
    return getNoopObservabilityDeps();
  }
}

// Re-export kernel types and functions
export {
  getNoopObservabilityDeps,
  resolveObservabilityDeps,
  type ObservabilityDeps,
  type IObservabilityExporter,
  type ObservabilityLLMRequestEvent,
  type ObservabilityLLMResponseEvent,
  type ObservabilityRecordResult
};
