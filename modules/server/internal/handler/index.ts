import type http from 'http';

import { createHandlerContext, type HandlerContextOptions } from './internal/context.js';
import { handleRequest } from './internal/router.js';

export function createServerHandler(options: HandlerContextOptions): http.RequestListener {
  const ctx = createHandlerContext(options);
  return async (req, res) => handleRequest(ctx, req, res);
}
