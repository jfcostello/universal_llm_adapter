import type {
  AdapterLogger,
  HttpCompatContext,
  HttpExportProviderManifest,
  IHttpBatchCompat
} from '../../../kernel/index.js';

import type { BatchedHttpExporterConfig, BatchedHttpExporterMetrics, QueuedExportEvent } from './types.js';

export async function sendWithSizeLimit<M extends HttpExportProviderManifest>(options: {
  label: string;
  batchEvents: QueuedExportEvent[];
  attempt: number;
  maxBatchBytes: number | undefined;
  compatContext: HttpCompatContext;
  signal: AbortSignal | undefined;
  config: BatchedHttpExporterConfig;
  compat: IHttpBatchCompat<M>;
  manifest: M;
  logger: AdapterLogger;
  metrics: BatchedHttpExporterMetrics;
  getMetricsSnapshot: () => Record<string, number>;
}): Promise<QueuedExportEvent[]> {
  if (options.signal?.aborted) {
    return options.batchEvents;
  }

  const compatContextForBatch: HttpCompatContext = {
    ...options.compatContext,
    eventIds: options.batchEvents.map(e => e.id)
  };

  let payload: unknown;
  let eventIndexByEnvelopeId: Map<string, number>;
  try {
    ({ payload, eventIndexByEnvelopeId } = options.compat.buildBatch(
      options.batchEvents.map(e => e.data),
      options.manifest,
      compatContextForBatch
    ));
  } catch (error: any) {
    options.logger.warning(`${options.label} batch export failed`, {
      provider: options.config.provider,
      attempt: options.attempt + 1,
      maxAttempts: options.config.maxAttempts,
      error: (error as Error)?.message ?? String(error),
      metrics: options.getMetricsSnapshot()
    });
    return options.batchEvents;
  }

  if (typeof options.maxBatchBytes === 'number' && options.maxBatchBytes > 0) {
    const bytes =
      payload instanceof Uint8Array
        ? payload.byteLength
        : Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes > options.maxBatchBytes) {
      if (options.batchEvents.length <= 1) {
        options.metrics.droppedTotal += 1;
        options.logger.warning(`${options.label} event exceeds maxBatchBytes; dropping event`, {
          provider: options.config.provider,
          eventId: options.batchEvents[0].id,
          bytes,
          maxBatchBytes: options.maxBatchBytes,
          metrics: options.getMetricsSnapshot()
        });
        return [];
      }

      const mid = Math.floor(options.batchEvents.length / 2);
      const leftRetry = await sendWithSizeLimit({
        ...options,
        batchEvents: options.batchEvents.slice(0, mid)
      });
      const rightRetry = await sendWithSizeLimit({
        ...options,
        batchEvents: options.batchEvents.slice(mid)
      });
      return [...leftRetry, ...rightRetry];
    }
  }

  options.metrics.sentCount += 1;
  let result: Awaited<ReturnType<IHttpBatchCompat<M>['sendBatch']>>;
  try {
    result = await options.compat.sendBatch(payload, options.manifest, compatContextForBatch);
  } catch (error: any) {
    options.metrics.failedCount += 1;
    options.logger.warning(`${options.label} batch export failed`, {
      provider: options.config.provider,
      attempt: options.attempt + 1,
      maxAttempts: options.config.maxAttempts,
      error: (error as Error)?.message ?? String(error),
      metrics: options.getMetricsSnapshot()
    });
    return options.batchEvents;
  }

  if (result.success) {
    if (process.env.LLM_LIVE === '1') {
      options.logger.info(`${options.label} batch export succeeded`, {
        provider: options.config.provider,
        events: options.batchEvents.length,
        envelopes: result.outcomes.length,
        metrics: options.getMetricsSnapshot()
      });
    }
    return [];
  }

  options.metrics.failedCount += 1;

  for (const outcome of result.outcomes) {
    if (outcome.success) continue;
    if (outcome.retryable === true) continue;

    const eventIndex = eventIndexByEnvelopeId.get(outcome.envelopeId);
    const event = eventIndex !== undefined ? options.batchEvents[eventIndex] : undefined;
    options.logger.warning(`${options.label} envelope export failed (non-retryable)`, {
      provider: options.config.provider,
      envelopeId: outcome.envelopeId,
      eventId: event?.id,
      eventType: event?.type,
      status: outcome.status,
      error: typeof outcome.error === 'string' ? outcome.error.slice(0, 500) : undefined,
      attempt: options.attempt + 1,
      maxAttempts: options.config.maxAttempts,
      metrics: options.getMetricsSnapshot()
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
    options.logger.warning(`${options.label} retryable outcomes unmapped; retrying all events`, {
      provider: options.config.provider,
      metrics: options.getMetricsSnapshot()
    });
    return options.batchEvents;
  }

  return options.batchEvents.filter((_event, index) => retryableEventIndices.has(index));
}
