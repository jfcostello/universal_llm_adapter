import type http from 'http';

import { readJsonBody } from '../../../transport/body-parser.js';
import { mapErrorToHttp } from '../../../transport/error-mapper.js';
import { assertValidSpec } from '../../../transport/spec-validator.js';
import { assertLlmSpecAllowedByPolicy } from '../../../security/policy.js';
import { monotonicElapsedMs, monotonicNowNs } from '../../../../../shared/index.js';

import type { LLMCallSpec } from '../../../../../../kernel/index.js';

import type { HandlerContext } from '../context.js';
import { writeJson } from '../response.js';
import { applyErrorHeaders, assertAuthorizedAndRateLimited, assertJsonContentType } from '../security-helpers.js';

export async function handleLlmRun(ctx: HandlerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  await assertAuthorizedAndRateLimited(ctx, req);
  assertJsonContentType(req);

  const abortController = new AbortController();
  req.once('close', () => abortController.abort());
  const release = await ctx.llmRunLimiter.acquire(abortController.signal);
  let releaseDeferred = false;

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
    const startTimeMonoNs = monotonicNowNs();

    const callPromise = ctx.runWithCoordinatorLifecycleFn<LLMCallSpec, any, any, any>({
      spec,
      pluginsPath: ctx.pluginsPath,
      registry: ctx.registry,
      batchId: ctx.batchId,
      closeLoggerAfter: ctx.closeLoggerAfterRequest,
      deps: ctx.deps,
      run: (coordinator: any, s) => coordinator.run(s)
    });

    if (ctx.config.requestTimeoutMs > 0) {
      let timedOut = false;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          const error = new Error('Request timed out');
          (error as any).statusCode = 504;
          (error as any).code = 'timeout';
          reject(error);
        }, ctx.config.requestTimeoutMs);
      });

      try {
        const response = await Promise.race([callPromise, timeoutPromise]);
        writeJson(res, 200, { type: 'response', data: response });
        logger.info('HTTP /run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
      } catch (error: any) {
        if (timedOut) {
          const mapped = mapErrorToHttp(error);
          writeJson(res, mapped.status, mapped.body);
          logger.warning('HTTP /run timed out', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
          releaseDeferred = true;
          callPromise
            .catch(err => logger.error('Coordinator finished after timeout', { error: err }))
            .finally(() => release());
          return;
        }

        const mapped = mapErrorToHttp(error);
        writeJson(res, mapped.status, mapped.body);
        logger.error('HTTP /run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      return;
    }

    try {
      const response = await callPromise;
      writeJson(res, 200, { type: 'response', data: response });
      logger.info('HTTP /run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
    } catch (error: any) {
      const mapped = mapErrorToHttp(error);
      writeJson(res, mapped.status, mapped.body);
      logger.error('HTTP /run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
    }
  } catch (error: any) {
    applyErrorHeaders(res, error);
    const mapped = mapErrorToHttp(error);
    writeJson(res, mapped.status, mapped.body);
  } finally {
    if (!releaseDeferred) release();
  }
}
