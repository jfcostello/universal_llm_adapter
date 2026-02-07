import { randomUUID } from 'crypto';

import type {
  AdapterLogger,
  IObservabilityCompat,
  IObservabilityExporter,
  ObservabilityCompatContext,
  ObservabilityLLMRequestEvent,
  ObservabilityLLMResponseEvent,
  ObservabilitySignalEvent,
  ObservabilityToolExecutionEvent,
  ObservabilityTraceUpdateEvent,
  ObservabilityProviderManifest,
  ObservabilityRecordResult
} from '../../../../../kernel/index.js';
import { getNoopLogger } from '../../../../../kernel/index.js';
import { redactJsonCredentials } from '../../../../security/index.js';
import { calculateBackoffDelay, sleepWithSignal } from '../../../../shared/index.js';

import type { ObservabilityExporterConfig } from './config.js';
import type { ObservabilityExporterMetrics, QueuedEvent } from './types.js';
import { sendWithSizeLimit } from './send-with-size-limit.js';

const DROP_WARNING_THROTTLE_MS = 10_000;

function redactEventMetadata<T extends { metadata?: Record<string, unknown> }>(event: T): T {
  if (!event.metadata || typeof event.metadata !== 'object') {
    return event;
  }

  return {
    ...event,
    metadata: redactJsonCredentials(event.metadata) as Record<string, unknown>
  };
}

export class ObservabilityExporter implements IObservabilityExporter {
  private queue: QueuedEvent[] = [];
  private queueHead = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private flushPromise: Promise<void> | null = null;
  private logger: AdapterLogger;
  private droppedSinceLastWarning = 0;
  private lastDropWarningMs: number | null = null;
  private shutdownSummaryLogged = false;
  private shutdownSignal: AbortSignal | undefined;
  private metrics: ObservabilityExporterMetrics = {
    enqueuedTotal: 0,
    droppedTotal: 0,
    flushCount: 0,
    flushMsTotal: 0,
    retryCount: 0,
    sentCount: 0,
    failedCount: 0
  };

  constructor(
    private config: ObservabilityExporterConfig,
    private compat: IObservabilityCompat,
    private manifest: ObservabilityProviderManifest
  ) {
    const maxAttributeValueBytes =
      typeof config.maxAttributeValueBytes === 'number' && Number.isFinite(config.maxAttributeValueBytes)
        ? Math.max(0, Math.floor(config.maxAttributeValueBytes))
        : 16384;
    this.config = { ...config, maxAttributeValueBytes };

    this.logger = config.logger ?? getNoopLogger();
    this.startFlushTimer();
  }

  setShutdownSignal(signal?: AbortSignal): void {
    this.shutdownSignal = signal;
  }

  private startFlushTimer(): void {
    if (this.flushTimer || this.shuttingDown) return;

    const timer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.shuttingDown && this.getQueueSize() > 0) {
        void this.flush();
      }
      this.startFlushTimer();
    }, this.config.flushIntervalMs);
    (timer as any)?.unref?.();
    this.flushTimer = timer;
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

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
      queueSize: this.getQueueSize(),
      metrics: this.getMetricsSnapshot(),
      ...(droppedEvents > 1 ? { droppedEvents } : {})
    });
  }

  private getMetricsSnapshot(): Record<string, number> {
    return {
      enqueuedTotal: this.metrics.enqueuedTotal,
      droppedTotal: this.metrics.droppedTotal,
      flushCount: this.metrics.flushCount,
      flushMsTotal: this.metrics.flushMsTotal,
      retryCount: this.metrics.retryCount,
      sentCount: this.metrics.sentCount,
      failedCount: this.metrics.failedCount
    };
  }

  logShutdownSummary(options: { timedOut?: boolean; shutdownTimeoutMs?: number } = {}): void {
    if (this.shutdownSummaryLogged) return;
    this.shutdownSummaryLogged = true;

    const timedOut = options.timedOut === true;
    const shutdownTimeoutMs =
      typeof options.shutdownTimeoutMs === 'number' && Number.isFinite(options.shutdownTimeoutMs)
        ? Math.floor(options.shutdownTimeoutMs)
        : undefined;

    const payload = {
      provider: this.config.provider,
      queueSize: this.getQueueSize(),
      ...(shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs } : {}),
      timedOut,
      ...this.getMetricsSnapshot(),
      flushMsAvg:
        this.metrics.flushCount > 0 ? Math.floor(this.metrics.flushMsTotal / this.metrics.flushCount) : 0
    };

    if (timedOut) {
      this.logger.warning('Observability exporter shutdown timed out', payload);
      return;
    }

    this.logger.info('Observability exporter shutdown summary', payload);
  }

  private enqueue(type: QueuedEvent['type'], data: any): ObservabilityRecordResult {
    const eventId = this.generateEventId();

    if (this.shuttingDown) {
      return { eventId, queued: false, reason: 'shutdown' };
    }

    if (this.getQueueSize() >= this.config.maxQueueSize) {
      const dropped = this.dropOldestEvent();
      if (dropped) {
        this.metrics.droppedTotal += 1;
        this.warnOnQueueDrop(dropped);
      }
    }

    const event: QueuedEvent = {
      id: eventId,
      type,
      data: { ...(data as any), type },
      timestamp: Date.now()
    };

    this.queue.push(event);
    this.metrics.enqueuedTotal += 1;

    if (this.getQueueSize() >= this.config.flushAt) {
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

  recordToolExecution(event: ObservabilityToolExecutionEvent): ObservabilityRecordResult {
    return this.enqueue('tool_execution', redactEventMetadata(event));
  }

  recordSignal(event: ObservabilitySignalEvent): ObservabilityRecordResult {
    return this.enqueue('signal', redactEventMetadata(event));
  }

  recordTraceUpdate(event: ObservabilityTraceUpdateEvent): ObservabilityRecordResult {
    return this.enqueue('trace_update', redactEventMetadata(event));
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.getQueueSize() === 0) return Promise.resolve();

    const loop = (async () => {
      while (this.getQueueSize() > 0) {
        await this.doFlush();
      }
    })();

    this.flushPromise = loop.finally(() => {
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    const signal = this.shuttingDown ? this.shutdownSignal : undefined;
    if (signal?.aborted) {
      this.queue = [];
      this.queueHead = 0;
      return;
    }

    const flushStartMs = Date.now();
    this.metrics.flushCount += 1;

    const events = this.queue.slice(this.queueHead);
    this.queue = [];
    this.queueHead = 0;

    const compatContext: ObservabilityCompatContext = {
      ...(this.config.providerConfig ? { providerConfig: this.config.providerConfig } : {}),
      timeoutMs: this.config.timeoutMs,
      ...(signal ? { signal } : {}),
      maxAttributeValueBytes: this.config.maxAttributeValueBytes
    };
    const maxBatchBytes = this.manifest.limits?.maxBatchBytes;

    let attempt = 0;
    let eventsToRetry = events;

    try {
      while (eventsToRetry.length > 0 && attempt < this.config.maxAttempts) {
        eventsToRetry = await sendWithSizeLimit({
          batchEvents: eventsToRetry,
          attempt,
          maxBatchBytes,
          compatContext,
          signal,
          config: this.config,
          compat: this.compat,
          manifest: this.manifest,
          logger: this.logger,
          metrics: this.metrics,
          getMetricsSnapshot: () => this.getMetricsSnapshot()
        });

        if (eventsToRetry.length > 0 && attempt < this.config.maxAttempts - 1) {
          this.metrics.retryCount += 1;
          const delay = calculateBackoffDelay(attempt, this.config.baseDelayMs, this.config.maxDelayMs);
          const slept = await sleepWithSignal(delay, signal);
          if (!slept) {
            return;
          }
        }

        attempt++;
      }

      if (eventsToRetry.length > 0) {
        this.logger.warning('Observability export failed after max attempts', {
          provider: this.config.provider,
          failedEvents: eventsToRetry.length,
          maxAttempts: this.config.maxAttempts,
          metrics: this.getMetricsSnapshot()
        });
      }
    } finally {
      this.metrics.flushMsTotal += Date.now() - flushStartMs;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopFlushTimer();

    try {
      await this.flush();
    } finally {
      this.logShutdownSummary();
    }
  }
}
