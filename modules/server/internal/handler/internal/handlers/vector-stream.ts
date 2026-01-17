import type http from 'http';

import { readJsonBody } from '../../../transport/body-parser.js';
import { mapErrorToHttp } from '../../../transport/error-mapper.js';
import { assertValidVectorSpec } from '../../../transport/spec-validator.js';
import { writeSseEventWithBackpressure } from '../../../streaming/sse.js';
import { monotonicElapsedMs, monotonicNowNs } from '../../../../../shared/index.js';

import type { VectorCallSpec, VectorStreamEvent } from '../../../../../../kernel/index.js';

import type { HandlerContext } from '../context.js';
import { writeSseHeaders } from '../response.js';
import { assertAuthorizedAndRateLimited, assertJsonContentType } from '../security-helpers.js';
import { handleSseStream } from '../sse-stream.js';

export async function handleVectorStream(
  ctx: HandlerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  await assertAuthorizedAndRateLimited(ctx, req);
  assertJsonContentType(req);

  const abortController = new AbortController();
  req.once('close', () => abortController.abort());
  const release = await ctx.vectorStreamLimiter.acquire(abortController.signal);

  try {
    const spec = (await readJsonBody(req, {
      maxBytes: ctx.config.maxRequestBytes,
      timeoutMs: ctx.config.bodyReadTimeoutMs
    })) as VectorCallSpec;

    assertValidVectorSpec(spec);

    const correlationId = spec.metadata?.correlationId as string | undefined;
    const { getVectorLogger } = await import('../../../../../logging/index.js');
    const logger = getVectorLogger(correlationId);
    const startTimeMs = Date.now();
    const startTimeMonoNs = monotonicNowNs();

    writeSseHeaders(res);

    const createVectorCoordinator = (ctx.deps as any).createVectorCoordinator as
      | (typeof ctx.deps)['createVectorCoordinator']
      | undefined;

    if (!createVectorCoordinator) {
      const error = new Error('Vector coordinator not available');
      (error as any).statusCode = 501;
      (error as any).code = 'not_implemented';
      throw error;
    }

    const lifecycleStream = ctx.streamWithCoordinatorLifecycleFn<
      VectorCallSpec,
      any,
      any,
      VectorStreamEvent
    >({
      spec,
      pluginsPath: ctx.pluginsPath,
      registry: ctx.registry,
      batchId: ctx.batchId,
      closeLoggerAfter: ctx.closeLoggerAfterRequest,
      deps: { ...ctx.deps, createCoordinator: createVectorCoordinator },
      stream: (coordinator: any, s) => coordinator.executeStream(s)
    });

    const iterator = lifecycleStream[Symbol.asyncIterator]();

    try {
      await handleSseStream({
        iterator,
        res,
        startTimeMs,
        requestTimeoutMs: ctx.config.requestTimeoutMs,
        idleTimeoutMs: ctx.config.streamIdleTimeoutMs
      });
    } catch (error: any) {
      const mapped = mapErrorToHttp(error);
      await writeSseEventWithBackpressure(res, mapped.body);
      res.end();
    }

    if (!res.writableEnded) {
      res.end();
    }

    logger.info('HTTP /vector/stream completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
  } finally {
    release();
  }
}
