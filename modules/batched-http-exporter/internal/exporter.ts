import { randomUUID } from 'crypto';

import type { AdapterLogger, HttpCompatContext, HttpExportProviderManifest, IHttpBatchCompat } from '../../../kernel/index.js';
import { getNoopLogger } from '../../../kernel/index.js';
import { calculateBackoffDelay, sleepWithSignal } from '../../shared/index.js';

import type { BatchedHttpExporterConfig, BatchedHttpExporterMetrics, QueuedExportEvent } from './types.js';
import { sendWithSizeLimit } from './send-with-size-limit.js';

const DROP_WARNING_THROTTLE_MS = 10_000;

export class BatchedHttpExporter<
  M extends HttpExportProviderManifest = HttpExportProviderManifest,
  EType extends string = string,
  EData = unknown
> {
  protected queue: QueuedExportEvent<EType, EData>[] = [];
  protected queueHead = 0;
  protected flushTimer: ReturnType<typeof setTimeout> | null = null;
  protected flushing = false;
  protected shuttingDown = false;
  protected flushPromise: Promise<void> | null = null;
  protected logger: AdapterLogger;
  protected droppedSinceLastWarning = 0;
  protected lastDropWarningMs: number | null = null;
  protected shutdownSummaryLogged = false;
  protected shutdownSignal: AbortSignal | undefined;
  protected metrics: BatchedHttpExporterMetrics = {
    enqueuedTotal: 0,
    droppedTotal: 0,
    flushCount: 0,
    flushMsTotal: 0,
    retryCount: 0,
    sentCount: 0,
    failedCount: 0
  };

  protected config: BatchedHttpExporterConfig;

  constructor(
    config: BatchedHttpExporterConfig,
    protected compat: IHttpBatchCompat<M>,
    protected manifest: M,
    protected label: string
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

  protected startFlushTimer(): void {
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

  protected stopFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  protected generateEventId(): string {
    return randomUUID();
  }

  protected getQueueSize(): number {
    return Math.max(0, this.queue.length - this.queueHead);
  }

  protected dropOldestEvent(): QueuedExportEvent<EType, EData> | null {
    if (this.getQueueSize() <= 0) return null;
    const dropped = this.queue[this.queueHead];
    this.queueHead++;

    if (this.queueHead > 50 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }

    return dropped;
  }

  protected warnOnQueueDrop(dropped: QueuedExportEvent<EType, EData>): void {
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

    this.logger.warning(`${this.label} queue full; dropped oldest event`, {
      provider: this.config.provider,
      droppedEventId: dropped.id,
      maxQueueSize: this.config.maxQueueSize,
      queueSize: this.getQueueSize(),
      metrics: this.getMetricsSnapshot(),
      ...(droppedEvents > 1 ? { droppedEvents } : {})
    });
  }

  protected getMetricsSnapshot(): Record<string, number> {
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
      this.logger.warning(`${this.label} exporter shutdown timed out`, payload);
      return;
    }

    this.logger.info(`${this.label} exporter shutdown summary`, payload);
  }

  protected enqueue(type: EType, data: EData): { eventId: string; queued: boolean; reason?: string } {
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

    const event: QueuedExportEvent<EType, EData> = {
      id: eventId,
      type,
      data,
      timestamp: Date.now(),
      attempts: 0
    };

    this.queue.push(event);
    this.metrics.enqueuedTotal += 1;

    if (this.getQueueSize() >= this.config.flushAt) {
      void this.flush();
    }

    return { eventId, queued: true };
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.getQueueSize() === 0) return Promise.resolve();

    this.flushing = true;
    const loop = (async () => {
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

  protected async doFlush(): Promise<void> {
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

    const compatContext: HttpCompatContext = {
      ...(this.config.providerConfig ? { providerConfig: this.config.providerConfig } : {}),
      timeoutMs: this.config.timeoutMs,
      ...(signal ? { signal } : {}),
      maxAttributeValueBytes: this.config.maxAttributeValueBytes
    };
    const maxBatchBytes = this.manifest.limits?.maxBatchBytes;

    let attempt = 0;
    let eventsToRetry: QueuedExportEvent[] = events;

    try {
      while (eventsToRetry.length > 0 && attempt < this.config.maxAttempts) {
        eventsToRetry = await sendWithSizeLimit({
          label: this.label,
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
        this.logger.warning(`${this.label} export failed after max attempts`, {
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
