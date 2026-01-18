import type http from 'http';

import type { VoiceServerContext } from './context.js';
import { writeJson } from './utils-http.js';

export async function handleVoiceMetrics(
  ctx: VoiceServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/voice/metrics') return false;

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
    return true;
  }

  if (!ctx.metrics.enabled) {
    writeJson(res, 404, { type: 'error', error: { message: 'Not found', code: 'not_found' } });
    return true;
  }

  if (!ctx.authConfig || ctx.authConfig.mode === 'none') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice metrics endpoint requires server auth to be enabled', code: 'not_implemented' } });
    return true;
  }

  await ctx.assertAuthorizedAndRateLimited(req);

  const snapshot = ctx.metrics.snapshot();
  writeJson(res, 200, { ok: true, enabled: snapshot.enabled, metrics: snapshot.metrics });
  return true;
}

