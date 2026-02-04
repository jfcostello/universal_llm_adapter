import type http from 'http';

import { readJsonBody } from '../../../transport/body-parser.js';
import { mapErrorToHttp } from '../../../transport/error-mapper.js';

import type { HandlerContext } from '../context.js';
import { writeJson } from '../response.js';
import { applyErrorHeaders, assertAuthorizedAndRateLimited, assertJsonContentType } from '../security-helpers.js';

export async function handleSignalsReport(
  ctx: HandlerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  await assertAuthorizedAndRateLimited(ctx, req);
  assertJsonContentType(req);

  try {
    const payload = await readJsonBody(req, {
      maxBytes: ctx.config.maxRequestBytes,
      timeoutMs: ctx.config.bodyReadTimeoutMs
    });

    const correlationId = (payload as any)?.metadata?.correlationId as string | undefined;
    const { getLogger } = await import('../../../../../logging/index.js');
    const { reportSignal } = await import('../../../../../signals/index.js');

    const logger = getLogger(correlationId);
    const result = await reportSignal({ registry: ctx.registry as any, event: payload, logger });

    writeJson(res, 200, { type: 'response', data: result });
  } catch (error: any) {
    applyErrorHeaders(res, error);
    const mapped = mapErrorToHttp(error);
    writeJson(res, mapped.status, mapped.body);
  }
}

