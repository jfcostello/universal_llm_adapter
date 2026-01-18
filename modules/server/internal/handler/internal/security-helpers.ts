import type http from 'http';

import type { AuthContext, AuthErrorLike } from '../../../../auth/index.js';
import { getClientIp } from '../../security/rate-limiter.js';

import type { HandlerContext } from './context.js';

export function applyErrorHeaders(res: http.ServerResponse, error: any): void {
  const headers = (error as AuthErrorLike | undefined)?.headers;
  if (!headers || typeof headers !== 'object') return;
  if (res.headersSent) return;
  for (const [key, value] of Object.entries(headers)) {
    try {
      res.setHeader(key, value);
    } catch {
      // ignore invalid header sets
    }
  }
}

export function makeForbiddenError(): Error {
  const error = new Error('Forbidden');
  (error as any).statusCode = 403;
  (error as any).code = 'forbidden';
  return error;
}

export async function assertAuthorizedAndRateLimited(
  ctx: HandlerContext,
  req: http.IncomingMessage
): Promise<AuthContext> {
  const authContext = await ctx.authenticator.authenticate(req);
  if (ctx.authorize) {
    const allowed = await ctx.authorize(authContext, req);
    if (!allowed) {
      throw makeForbiddenError();
    }
  }
  if (ctx.config.rateLimit?.enabled) {
    const key =
      authContext.subject ??
      getClientIp(req, Boolean(ctx.config.rateLimit?.trustProxyHeaders)) ??
      'unknown';
    ctx.rateLimiter.check(key);
  }
  return authContext;
}

export function assertJsonContentType(req: http.IncomingMessage): void {
  const contentType = req.headers['content-type'];
  if (contentType && !String(contentType).includes('application/json')) {
    const error = new Error('Unsupported Content-Type');
    (error as any).statusCode = 415;
    (error as any).code = 'unsupported_media_type';
    throw error;
  }
}
