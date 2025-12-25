/**
 * Core observability module implementation.
 * Provides event queue, batch exporter, and exponential backoff retry logic.
 */

import type {
  PluginRegistry,
  ObservabilitySpec,
  ObservabilityDeps,
  AdapterLogger,
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
  getDefaults,
  getNoopLogger
} from '../../kernel/index.js';
import { randomUUID, createHash } from 'crypto';
import { calculateBackoffDelay, sleep } from '../../shared/index.js';

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

// Exponential backoff + sleep helpers live in modules/shared.

// ============================================================
// OBSERVABILITY EXPORTER
// ============================================================

const DROP_WARNING_THROTTLE_MS = 10_000;

/**
 * Configuration for the observability exporter.
 */
export interface ObservabilityExporterConfig {
  /** Observability provider ID */
  provider: string;

  /** Structured logger (no-op when omitted) */
  logger?: AdapterLogger;

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

  /** Maximum UTF-8 bytes for any exported attribute string value */
  maxAttributeValueBytes?: number;
}

/**
 * Observability exporter implementation.
 * Manages event queue and exports to observability providers.
 */
export class ObservabilityExporter implements IObservabilityExporter {
  private queue: QueuedEvent[] = [];
  private queueHead = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private shuttingDown = false;
  private flushPromise: Promise<void> | null = null;
  private logger: AdapterLogger;
  private droppedSinceLastWarning = 0;
  private lastDropWarningMs: number | null = null;

  constructor(
    private config: ObservabilityExporterConfig,
    private compat: IObservabilityCompat,
    private manifest: ObservabilityProviderManifest
  ) {
    const maxAttributeValueBytes = typeof config.maxAttributeValueBytes === 'number' && Number.isFinite(config.maxAttributeValueBytes)
      ? Math.max(0, Math.floor(config.maxAttributeValueBytes))
      : 16384;
    this.config = { ...config, maxAttributeValueBytes };

    this.logger = config.logger ?? getNoopLogger();
    this.startFlushTimer();
  }

  /**
   * Start the periodic flush timer.
   */
  private startFlushTimer(): void {
    if (this.flushTimer || this.shuttingDown) return;

    const timer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.shuttingDown && this.getQueueSize() > 0) {
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

  private getQueueSize(): number {
    return Math.max(0, this.queue.length - this.queueHead);
  }

  private dropOldestEvent(): QueuedEvent | null {
    if (this.getQueueSize() <= 0) return null;
    const dropped = this.queue[this.queueHead];
    this.queueHead++;

    // Compact periodically to avoid unbounded backing-array growth.
    if (this.queueHead > 50 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }

    return dropped;
  }

  private warnOnQueueDrop(dropped: QueuedEvent): void {
    this.droppedSinceLastWarning += 1;
    const now = Date.now();

    const shouldLog =
      this.lastDropWarningMs === null || now - this.lastDropWarningMs >= DROP_WARNING_THROTTLE_MS;
    if (!shouldLog) {
      return;
    }

    const droppedEvents = this.droppedSinceLastWarning;
    this.droppedSinceLastWarning = 0;
    this.lastDropWarningMs = now;

    this.logger.warning('Observability queue full; dropped oldest event', {
      provider: this.config.provider,
      droppedEventId: dropped.id,
      maxQueueSize: this.config.maxQueueSize,
      ...(droppedEvents > 1 ? { droppedEvents } : {})
    });
  }

  /**
   * Enqueue an event.
   */
  private enqueue(type: QueuedEvent['type'], data: QueuedEvent['data']): ObservabilityRecordResult {
    const eventId = this.generateEventId();

    if (this.shuttingDown) {
      return { eventId, queued: false, reason: 'shutdown' };
    }

    if (this.getQueueSize() >= this.config.maxQueueSize) {
      // Drop oldest events to make room
      const dropped = this.dropOldestEvent();
      if (dropped) {
        this.warnOnQueueDrop(dropped);
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
    if (this.getQueueSize() >= this.config.flushAt) {
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

  flush(): Promise<void> {
    // If already flushing, wait for the active flush loop to drain.
    if (this.flushPromise) return this.flushPromise;

    if (this.getQueueSize() === 0) return Promise.resolve();

    this.flushing = true;
    const loop = (async () => {
      // Drain the queue completely. Events may be enqueued while a flush is in-flight;
      // keep flushing until the queue is empty.
      while (this.getQueueSize() > 0) {
        await this.doFlush();
      }
    })();

    this.flushPromise = loop.finally(() => {
      this.flushing = false;
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    // Take all events from queue (caller guarantees queue is non-empty)
    const events = this.queue.slice(this.queueHead);
    this.queue = [];
    this.queueHead = 0;

    const compatContext: ObservabilityCompatContext = {
      ...(this.config.providerConfig ? { providerConfig: this.config.providerConfig } : {}),
      timeoutMs: this.config.timeoutMs,
      maxAttributeValueBytes: this.config.maxAttributeValueBytes
    };
    const maxBatchBytes = this.manifest.limits?.maxBatchBytes;

    let attempt = 0;
    let eventsToRetry = events;

    while (eventsToRetry.length > 0 && attempt < this.config.maxAttempts) {
      const sendWithSizeLimit = async (batchEvents: QueuedEvent[]): Promise<QueuedEvent[]> => {
        try {
          const compatContextForBatch: ObservabilityCompatContext = {
            ...compatContext,
            eventIds: batchEvents.map(e => e.id)
          };

          const { payload, eventIndexByEnvelopeId } = this.compat.buildBatch(
            batchEvents.map(e => e.data),
            this.manifest,
            compatContextForBatch
          );

          if (typeof maxBatchBytes === 'number' && maxBatchBytes > 0) {
            const bytes =
              payload instanceof Uint8Array
                ? payload.byteLength
                : Buffer.byteLength(JSON.stringify(payload), 'utf8');
            if (bytes > maxBatchBytes) {
              if (batchEvents.length <= 1) {
                this.logger.warning('Observability event exceeds maxBatchBytes; dropping event', {
                  provider: this.config.provider,
                  eventId: batchEvents[0].id,
                  bytes,
                  maxBatchBytes
                });
                return [];
              }

              const mid = Math.floor(batchEvents.length / 2);
              const leftRetry = await sendWithSizeLimit(batchEvents.slice(0, mid));
              const rightRetry = await sendWithSizeLimit(batchEvents.slice(mid));
              return [...leftRetry, ...rightRetry];
            }
          }

          const result = await this.compat.sendBatch(payload, this.manifest, compatContextForBatch);
          if (result.success) {
            if (process.env.LLM_LIVE === '1') {
              this.logger.info('Observability batch export succeeded', {
                provider: this.config.provider,
                events: batchEvents.length,
                envelopes: result.outcomes.length
              });
            }
            return [];
          }

          for (const outcome of result.outcomes) {
            if (outcome.success) continue;
            if (outcome.retryable === true) continue;

            const eventIndex = eventIndexByEnvelopeId.get(outcome.envelopeId);
            const event = eventIndex !== undefined ? batchEvents[eventIndex] : undefined;
            this.logger.warning('Observability envelope export failed (non-retryable)', {
              provider: this.config.provider,
              envelopeId: outcome.envelopeId,
              eventId: event?.id,
              eventType: event?.type,
              status: outcome.status,
              error: typeof outcome.error === 'string' ? outcome.error.slice(0, 500) : undefined,
              attempt: attempt + 1,
              maxAttempts: this.config.maxAttempts
            });
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
            this.logger.warning('Observability retryable outcomes unmapped; retrying all events', {
              provider: this.config.provider
            });
            return batchEvents;
          }

          return batchEvents.filter((_event, index) => retryableEventIndices.has(index));
        } catch (error: any) {
          this.logger.warning('Observability batch export failed', {
            provider: this.config.provider,
            attempt: attempt + 1,
            maxAttempts: this.config.maxAttempts,
            error: (error as Error)?.message ?? String(error)
          });
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
      this.logger.warning('Observability export failed after max attempts', {
        provider: this.config.provider,
        failedEvents: eventsToRetry.length,
        maxAttempts: this.config.maxAttempts
      });
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopFlushTimer();

    // Final flush (also waits for any in-flight flush)
    await this.flush();
  }
}

// ============================================================
// FACTORY FUNCTIONS
// ============================================================

const OBSERVABILITY_RUNTIME_SYMBOL = Symbol.for('llm_adapter_observability_runtime');
const DEFAULT_MAX_EXPORTERS_PER_REGISTRY = 10;

type RegistryRuntime = {
  exportersByKey: Map<string, ObservabilityExporter>;
  inflightByKey: Map<string, Promise<ObservabilityExporter>>;
  maxExporters: number;
};

const runtimeByRegistry = new WeakMap<object, RegistryRuntime>();
const runtimeRegistries = new Set<object>();

let shutdownAllPromise: Promise<void> | null = null;

function ensureRuntimeHookInstalled(): void {
  const globalAny = globalThis as any;
  if (globalAny[OBSERVABILITY_RUNTIME_SYMBOL]) return;
  globalAny[OBSERVABILITY_RUNTIME_SYMBOL] = { shutdownAll: shutdownAllExporters };
}

function getOrCreateRegistryRuntime(registry: object): RegistryRuntime {
  const existing = runtimeByRegistry.get(registry);
  if (existing) {
    runtimeRegistries.add(registry);
    return existing;
  }

  const created: RegistryRuntime = {
    exportersByKey: new Map(),
    inflightByKey: new Map(),
    maxExporters: DEFAULT_MAX_EXPORTERS_PER_REGISTRY
  };

  runtimeByRegistry.set(registry, created);
  runtimeRegistries.add(registry);
  return created;
}

function stableSortForKey(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return '[function]';

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map(entry => stableSortForKey(entry, seen));
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = stableSortForKey(record[key], seen);
  }
  return out;
}

function stableStringifyForKey(value: unknown): string {
  try {
    return JSON.stringify(stableSortForKey(value, new WeakSet()));
  } catch {
    return JSON.stringify(String(value));
  }
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function buildExporterCacheKey(config: ObservabilityExporterConfig): string {
  const providerConfigHash = hashKey(stableStringifyForKey(config.providerConfig ?? null));
  return [
    String(config.provider),
    String(config.flushAt),
    String(config.flushIntervalMs),
    String(config.maxQueueSize),
    String(config.maxAttempts),
    String(config.baseDelayMs),
    String(config.maxDelayMs),
    String(config.timeoutMs),
    String(config.maxAttributeValueBytes),
    providerConfigHash
  ].join('|');
}

function enforceExporterCacheBound(runtime: RegistryRuntime): void {
  while (runtime.exportersByKey.size > runtime.maxExporters) {
    const oldestKey = runtime.exportersByKey.keys().next().value as string;

    const exporter = runtime.exportersByKey.get(oldestKey);
    runtime.exportersByKey.delete(oldestKey);

    // Best-effort shutdown; never block the caller.
    void exporter?.shutdown().catch(() => {});
  }
}

async function getOrCreateSharedExporter(
  registry: PluginRegistry,
  config: ObservabilityExporterConfig
): Promise<ObservabilityExporter> {
  const runtime = getOrCreateRegistryRuntime(registry as unknown as object);
  const key = buildExporterCacheKey(config);

  const cached = runtime.exportersByKey.get(key);
  if (cached) {
    // Touch for LRU order.
    runtime.exportersByKey.delete(key);
    runtime.exportersByKey.set(key, cached);
    return cached;
  }

  const inflight = runtime.inflightByKey.get(key);
  if (inflight) return inflight;

  const createPromise = (async () => {
    const manifest = await registry.getObservabilityProvider(config.provider);
    const compat = await registry.getObservabilityCompat(manifest.compat);

    const exporter = new ObservabilityExporter(config, compat, manifest);
    runtime.exportersByKey.set(key, exporter);
    runtime.inflightByKey.delete(key);
    enforceExporterCacheBound(runtime);
    return exporter;
  })();

  runtime.inflightByKey.set(key, createPromise);

  try {
    return await createPromise;
  } finally {
    // Ensure inflight is cleared on any thrown value.
    runtime.inflightByKey.delete(key);
  }
}

async function shutdownAllExporters(): Promise<void> {
  if (shutdownAllPromise) return shutdownAllPromise;

  shutdownAllPromise = (async () => {
    const exporters: ObservabilityExporter[] = [];
    for (const registry of runtimeRegistries) {
      const runtime = runtimeByRegistry.get(registry)!;
      for (const exporter of runtime.exportersByKey.values()) {
        exporters.push(exporter);
      }
      runtime.exportersByKey.clear();
      runtime.inflightByKey.clear();
    }

    await Promise.all(exporters.map(exp => exp.shutdown().catch(() => {})));
    runtimeRegistries.clear();
  })().finally(() => {
    shutdownAllPromise = null;
  });

  return shutdownAllPromise;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const normalized = normalizeNumber(value);
  const asInt = Number.isFinite(normalized as any) ? Math.floor(normalized as number) : Math.floor(fallback);
  return Math.min(max, Math.max(min, asInt));
}

/**
 * Resolve observability configuration from spec and defaults.
 */
function resolveConfig(
  spec: ObservabilitySpec | undefined,
  defaults: DefaultSettings['observability'],
  logger: AdapterLogger
): ObservabilityExporterConfig | null {
  const enabled = spec?.enabled ?? defaults.enabled;

  if (!enabled) {
    return null;
  }

  const provider = spec?.provider ?? defaults.provider;

  if (!provider) {
    logger.warning('Observability disabled: no provider configured', { provider: null });
    return null;
  }

  const maxQueueSize = clampInt(spec?.maxQueueSize, defaults.maxQueueSize, 1, 100_000);
  const flushAt = clampInt(spec?.flushAt, defaults.flushAt, 1, maxQueueSize);
  const flushIntervalMs = clampInt(spec?.flushIntervalMs, defaults.flushIntervalMs, 250, 3_600_000);
  const maxAttempts = clampInt(spec?.maxAttempts, defaults.maxAttempts, 1, 20);
  const baseDelayMs = clampInt(spec?.baseDelayMs, defaults.baseDelayMs, 0, 300_000);
  const maxDelayMs = clampInt(spec?.maxDelayMs, defaults.maxDelayMs, 0, 300_000);
  const timeoutMs = clampInt(spec?.timeoutMs, defaults.timeoutMs, 250, 300_000);
  const maxAttributeValueBytes = clampInt(
    spec?.maxAttributeValueBytes,
    (defaults as any).maxAttributeValueBytes ?? 16384,
    256,
    1_000_000
  );

  return {
    provider,
    logger,
    providerConfig: spec?.providerConfig,
    flushAt,
    flushIntervalMs,
    maxQueueSize,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    timeoutMs,
    maxAttributeValueBytes
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
  spec?: ObservabilitySpec,
  logger: AdapterLogger = getNoopLogger()
): Promise<ObservabilityDeps> {
  const defaults = getDefaults().observability;
  const config = resolveConfig(spec, defaults, logger);

  if (!config) {
    return getNoopObservabilityDeps();
  }

  try {
    ensureRuntimeHookInstalled();

    // Process-level shared exporter (per registry + effective config)
    const exporter = await getOrCreateSharedExporter(registry, config);

    return {
      isEnabled: () => true,
      getExporter: () => exporter,
      shutdown: async () => {
        await shutdownAllExporters();
      }
    };
  } catch (error: any) {
    logger.warning('Observability failed to initialize', {
      provider: config.provider,
      error: (error as Error)?.message ?? String(error)
    });
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
