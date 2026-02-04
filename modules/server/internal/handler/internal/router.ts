import type http from 'http';

import { applyCors } from '../../security/cors.js';
import { applySecurityHeaders } from '../../security/security-headers.js';
import { mapErrorToHttp } from '../../transport/error-mapper.js';
import { writeSseEvent } from '../../streaming/sse.js';

import type { HandlerContext } from './context.js';
import { writeJson } from './response.js';
import { applyErrorHeaders } from './security-helpers.js';
import { handleEmbeddingsRun } from './handlers/embeddings-run.js';
import { handleExtensionsList } from './handlers/extensions-list.js';
import { handleLlmRun } from './handlers/llm-run.js';
import { handleLlmStream } from './handlers/llm-stream.js';
import { handleRealtimeWebrtcClientSecret } from './handlers/realtime-client-secret.js';
import { handleSignalsReport } from './handlers/signals-report.js';
import { handleVectorRun } from './handlers/vector-run.js';
import { handleVectorStream } from './handlers/vector-stream.js';

export async function handleRequest(
  ctx: HandlerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    applySecurityHeaders(res, ctx.config.securityHeadersEnabled ?? true);
    if (applyCors(req, res, ctx.config.cors)) {
      return;
    }

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/health') {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/ready') {
      const ready = await ctx.checkReady();
      if (!ready) {
        writeJson(res, 503, { ok: false });
        return;
      }
      writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/extensions/list') {
      await handleExtensionsList(ctx, req, res);
      return;
    }

    if (method !== 'POST') {
      writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed' } });
      return;
    }

    if (url === '/realtime/webrtc/client-secret') {
      await handleRealtimeWebrtcClientSecret(ctx, req, res);
      return;
    }

    if (url === '/run') {
      await handleLlmRun(ctx, req, res);
      return;
    }

    if (url === '/stream') {
      await handleLlmStream(ctx, req, res);
      return;
    }

    if (url === '/vector/run') {
      await handleVectorRun(ctx, req, res);
      return;
    }

    if (url === '/vector/stream') {
      await handleVectorStream(ctx, req, res);
      return;
    }

    if (url === '/embeddings/run') {
      await handleEmbeddingsRun(ctx, req, res);
      return;
    }

    if (url === '/signals/report') {
      await handleSignalsReport(ctx, req, res);
      return;
    }

    writeJson(res, 404, { type: 'error', error: { message: 'Not found' } });
  } catch (error: any) {
    applyErrorHeaders(res, error);
    const mapped = mapErrorToHttp(error);

    if ((req.url === '/stream' || req.url === '/vector/stream') && res.headersSent) {
      writeSseEvent(res, mapped.body);
      res.end();
      return;
    }

    writeJson(res, mapped.status, mapped.body);
  }
}
