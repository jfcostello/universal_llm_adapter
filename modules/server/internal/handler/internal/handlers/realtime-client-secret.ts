import type http from 'http';

import { readJsonBody } from '../../../transport/body-parser.js';

import type { HandlerContext } from '../context.js';
import { writeJson } from '../response.js';
import { assertAuthorizedAndRateLimited, assertJsonContentType } from '../security-helpers.js';

export async function handleRealtimeWebrtcClientSecret(
  ctx: HandlerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!ctx.config.auth || ctx.config.auth.mode === 'none') {
    const error = new Error('Realtime client-secret endpoint requires server auth to be enabled');
    (error as any).statusCode = 501;
    (error as any).code = 'not_implemented';
    throw error;
  }

  await assertAuthorizedAndRateLimited(ctx, req);
  assertJsonContentType(req);

  const body = await readJsonBody(req, {
    maxBytes: ctx.config.maxRequestBytes,
    timeoutMs: ctx.config.bodyReadTimeoutMs
  });

  const providerId = String(body?.provider ?? '').trim();
  const model = body?.model !== undefined ? String(body.model) : undefined;
  const systemPrompt = body?.systemPrompt !== undefined ? String(body.systemPrompt) : undefined;
  const expiresAfterSecondsRaw = body?.expiresAfterSeconds;
  const expiresAfterSeconds =
    expiresAfterSecondsRaw === undefined || expiresAfterSecondsRaw === null
      ? undefined
      : Number(expiresAfterSecondsRaw);

  const MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS = 30;
  const MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS = 600;

  if (!providerId) {
    const error = new Error('Missing provider');
    (error as any).statusCode = 400;
    (error as any).code = 'validation_error';
    throw error;
  }

  if (expiresAfterSeconds !== undefined) {
    if (!Number.isFinite(expiresAfterSeconds)) {
      const error = new Error('Invalid expiresAfterSeconds');
      (error as any).statusCode = 400;
      (error as any).code = 'validation_error';
      throw error;
    }

    if (!Number.isInteger(expiresAfterSeconds)) {
      const error = new Error('expiresAfterSeconds must be an integer');
      (error as any).statusCode = 400;
      (error as any).code = 'validation_error';
      throw error;
    }

    if (
      expiresAfterSeconds < MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS ||
      expiresAfterSeconds > MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS
    ) {
      const error = new Error(
        `expiresAfterSeconds must be between ${MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS} and ${MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS}`
      );
      (error as any).statusCode = 400;
      (error as any).code = 'validation_error';
      throw error;
    }
  }

  const reg = ctx.registry as any;
  if (typeof reg.getRealtimeProvider !== 'function' || typeof reg.getRealtimeCompat !== 'function') {
    const error = new Error('Registry does not support realtime client-secret minting');
    (error as any).statusCode = 501;
    (error as any).code = 'not_implemented';
    throw error;
  }

  const provider = await reg.getRealtimeProvider(providerId);
  const compatKind = provider?.compat;
  if (!compatKind) {
    const error = new Error(`Realtime client-secret minting not supported for provider '${providerId}'`);
    (error as any).statusCode = 501;
    (error as any).code = 'not_implemented';
    throw error;
  }

  const compat = await reg.getRealtimeCompat(compatKind);
  if (!compat || typeof compat.mintClientSecret !== 'function') {
    const error = new Error(`Realtime client-secret minting not supported for provider '${providerId}'`);
    (error as any).statusCode = 501;
    (error as any).code = 'not_implemented';
    throw error;
  }

  const result = await compat.mintClientSecret({
    provider,
    spec: {
      provider: providerId,
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      transport: { type: 'webrtc' }
    },
    ...(expiresAfterSeconds !== undefined ? { expiresAfterSeconds } : {})
  });

  writeJson(res, 200, {
    clientSecret: String(result?.clientSecret ?? ''),
    ...(result?.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {})
  });
}
