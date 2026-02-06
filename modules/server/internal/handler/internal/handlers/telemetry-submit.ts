import type http from 'http';

import { readJsonBody } from '../../../transport/body-parser.js';
import { mapErrorToHttp } from '../../../transport/error-mapper.js';
import { assertValidTelemetrySubmission } from '../../../transport/spec-validator.js';

import type { HandlerContext } from '../context.js';
import { writeJson } from '../response.js';
import { applyErrorHeaders, assertAuthorizedAndRateLimited, assertJsonContentType } from '../security-helpers.js';

export async function handleTelemetrySubmit(
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

    const telemetryPolicy = ctx.policy.telemetry.observabilityOverride;
    assertValidTelemetrySubmission(payload, {
      observabilityOverrideAllowlist: telemetryPolicy.enabled ? telemetryPolicy.allowlist : undefined
    });
    const { submitTelemetry } = await import('../../../../../observability/index.js');
    const result = await submitTelemetry(ctx.registry as any, payload as any, { runtime: { batchId: ctx.batchId } });
    writeJson(res, 200, { type: 'response', data: result });
  } catch (error: any) {
    applyErrorHeaders(res, error);
    const mapped = mapErrorToHttp(error);
    writeJson(res, mapped.status, mapped.body);
  }
}
