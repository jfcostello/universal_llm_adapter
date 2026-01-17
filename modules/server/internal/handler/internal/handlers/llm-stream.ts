import type http from 'http';

import { readJsonBody } from '../../../transport/body-parser.js';
import { mapErrorToHttp } from '../../../transport/error-mapper.js';
import { assertValidSpec } from '../../../transport/spec-validator.js';
import { assertLlmSpecAllowedByPolicy } from '../../../security/policy.js';
import { writeSseEventWithBackpressure } from '../../../streaming/sse.js';
import { monotonicElapsedMs, monotonicNowNs } from '../../../../../shared/index.js';

import type { LLMCallSpec, LLMStreamEvent } from '../../../../../../kernel/index.js';

import type { HandlerContext } from '../context.js';
import { writeSseHeaders } from '../response.js';
import { assertAuthorizedAndRateLimited, assertJsonContentType } from '../security-helpers.js';
import { handleSseStream } from '../sse-stream.js';

export async function handleLlmStream(
  ctx: HandlerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  await assertAuthorizedAndRateLimited(ctx, req);
  assertJsonContentType(req);

  const abortController = new AbortController();
  req.once('close', () => abortController.abort());
  const release = await ctx.llmStreamLimiter.acquire(abortController.signal);

  try {
    const spec = (await readJsonBody(req, {
      maxBytes: ctx.config.maxRequestBytes,
      timeoutMs: ctx.config.bodyReadTimeoutMs
    })) as LLMCallSpec;

    assertValidSpec(spec);
    assertLlmSpecAllowedByPolicy(spec, ctx.policy);
    const correlationId = spec.metadata?.correlationId as string | undefined;
    const { getLogger } = await import('../../../../../logging/index.js');
    const logger = getLogger(correlationId);
    const startTimeMs = Date.now();
    const startTimeMonoNs = monotonicNowNs();

    writeSseHeaders(res);

    const lifecycleStream = ctx.streamWithCoordinatorLifecycleFn<
      LLMCallSpec,
      any,
      any,
      LLMStreamEvent
    >({
      spec,
      pluginsPath: ctx.pluginsPath,
      registry: ctx.registry,
      batchId: ctx.batchId,
      closeLoggerAfter: ctx.closeLoggerAfterRequest,
      deps: ctx.deps,
      stream: (coordinator: any, s) => coordinator.runStream(s)
    });

    const iterator = lifecycleStream[Symbol.asyncIterator]();
    const idleTimeoutMs = ctx.config.streamIdleTimeoutMs;
    const requestTimeoutMs = ctx.config.requestTimeoutMs;

    try {
      await handleSseStream({
        iterator,
        res,
        startTimeMs,
        requestTimeoutMs,
        idleTimeoutMs
      });
    } catch (error: any) {
      const mapped = mapErrorToHttp(error);
      await writeSseEventWithBackpressure(res, mapped.body);
      res.end();
    }

    if (!res.writableEnded) {
      res.end();
    }

    logger.info('HTTP /stream completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
  } finally {
    release();
  }
}
