import type { AdapterLogger, IObservabilityCompat, ObservabilityCompatContext, ObservabilityProviderManifest } from '../../../../../kernel/index.js';

import type { ObservabilityExporterConfig } from './config.js';
import type { ObservabilityExporterMetrics, QueuedEvent } from './types.js';

export async function sendWithSizeLimit(options: {
  batchEvents: QueuedEvent[];
  attempt: number;
  maxBatchBytes: number | undefined;
  compatContext: ObservabilityCompatContext;
  signal: AbortSignal | undefined;
  config: ObservabilityExporterConfig;
  compat: IObservabilityCompat;
  manifest: ObservabilityProviderManifest;
  logger: AdapterLogger;
  metrics: ObservabilityExporterMetrics;
  getMetricsSnapshot: () => Record<string, number>;
}): Promise<QueuedEvent[]> {
  if (options.signal?.aborted) {
    return options.batchEvents;
  }

  const compatContextForBatch: ObservabilityCompatContext = {
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
    options.logger.warning('Observability batch export failed', {
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
        options.logger.warning('Observability event exceeds maxBatchBytes; dropping event', {
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
  let result: Awaited<ReturnType<IObservabilityCompat['sendBatch']>>;
  try {
    result = await options.compat.sendBatch(payload, options.manifest, compatContextForBatch);
  } catch (error: any) {
    options.metrics.failedCount += 1;
    options.logger.warning('Observability batch export failed', {
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
      options.logger.info('Observability batch export succeeded', {
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
    options.logger.warning('Observability envelope export failed (non-retryable)', {
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
    options.logger.warning('Observability retryable outcomes unmapped; retrying all events', {
      provider: options.config.provider,
      metrics: options.getMetricsSnapshot()
    });
    return options.batchEvents;
  }

  return options.batchEvents.filter((_event, index) => retryableEventIndices.has(index));
}
