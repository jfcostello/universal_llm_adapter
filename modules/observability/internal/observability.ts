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
  ObservabilityCompatContext,
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
  const jitter = 0.75 + Math.random() * 0.5; // 0.75 to 1.25
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

  /** Provider-specific configuration overrides (opaque to core) */
  providerConfig?: Record<string, unknown>;

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

    const timer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.shuttingDown && this.queue.length > 0) {
        // flush() handles errors internally in doFlush(), so it never rejects
        void this.flush();
      }
      this.startFlushTimer();
    }, this.config.flushIntervalMs);
    // Do not keep the process alive just for the periodic flush timer.
    // When there are pending exports, in-flight async work should keep the event loop alive.
    (timer as any)?.unref?.();
    this.flushTimer = timer;
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
      // flush() handles errors internally in doFlush(), so it never rejects
      void this.flush();
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
    // Take all events from queue (caller guarantees queue is non-empty)
    const events = [...this.queue];
    this.queue = [];

    const compatContext: ObservabilityCompatContext = {
      ...(this.config.providerConfig ? { providerConfig: this.config.providerConfig } : {}),
      timeoutMs: this.config.timeoutMs
    };
    const maxBatchBytes = this.manifest.limits?.maxBatchBytes;

    let attempt = 0;
    let eventsToRetry = events;

    while (eventsToRetry.length > 0 && attempt < this.config.maxAttempts) {
      const sendWithSizeLimit = async (batchEvents: QueuedEvent[]): Promise<QueuedEvent[]> => {
        try {
          const { payload, eventIndexByEnvelopeId } = this.compat.buildBatch(
            batchEvents.map(e => e.data),
            this.manifest,
            compatContext
          );

          if (typeof maxBatchBytes === 'number' && maxBatchBytes > 0) {
            const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
            if (bytes > maxBatchBytes) {
              if (batchEvents.length <= 1) {
                console.warn(
                  `[observability] Dropping event ${batchEvents[0].id}: batch payload ${bytes} bytes exceeds maxBatchBytes=${maxBatchBytes}`
                );
                return [];
              }

              const mid = Math.floor(batchEvents.length / 2);
              const leftRetry = await sendWithSizeLimit(batchEvents.slice(0, mid));
              const rightRetry = await sendWithSizeLimit(batchEvents.slice(mid));
              return [...leftRetry, ...rightRetry];
            }
          }

          const result = await this.compat.sendBatch(payload, this.manifest, compatContext);
          if (result.success) {
            return [];
          }

          const retryableEventIndices = new Set<number>();
          let hasUnmappedRetryableOutcome = false;

          for (const outcome of result.outcomes) {
            if (!outcome.success && outcome.retryable) {
              const eventIndex = eventIndexByEnvelopeId.get(outcome.envelopeId);
              if (eventIndex === undefined) {
                hasUnmappedRetryableOutcome = true;
                continue;
              }
              retryableEventIndices.add(eventIndex);
            }
          }

          if (hasUnmappedRetryableOutcome) {
            console.warn(
              '[observability] Retryable envelope outcome could not be mapped to an event index; retrying all events'
            );
            return batchEvents;
          }

          return batchEvents.filter((_event, index) => retryableEventIndices.has(index));
        } catch (error: any) {
          console.warn(
            `[observability] Batch export failed (attempt ${attempt + 1}/${this.config.maxAttempts}): ${error.message}`
          );
          return batchEvents;
        }
      };

      eventsToRetry = await sendWithSizeLimit(eventsToRetry);

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
    providerConfig: spec?.providerConfig,
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
