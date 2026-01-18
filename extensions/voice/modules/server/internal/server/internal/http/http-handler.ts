import type http from 'http';

import { applyCors, applySecurityHeaders } from '../../../../../../../../modules/server/index.js';
import { mapErrorToHttp } from '../../../../../../../../modules/transport/index.js';

import type { VoiceServerContext } from '../core/context.js';
import { handleVoiceCallEnd } from './http-call-end.js';
import { handleVoiceCallRecording } from './http-call-recording.js';
import { handleVoiceCallTransfer } from './http-call-transfer.js';
import { handleVoiceCallsEvents } from './http-calls-events.js';
import { handleVoiceCalls } from './http-calls.js';
import { handleVoiceMetrics } from './http-metrics.js';
import { handleVoiceRoot } from './http-root.js';
import { handleVoiceWebhook } from './http-webhook.js';
import { handleVoiceWebhookRecording } from './http-webhook-recording.js';
import { parseUrl, writeJson } from './utils-http.js';

export function createVoiceHttpHandler(ctx: VoiceServerContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = parseUrl(req.url);
    if (!url) return false;

    const pathname = url.pathname;
    if (pathname !== '/voice' && !pathname.startsWith('/voice/')) return false;

    applySecurityHeaders(res, Boolean(ctx.securityHeadersEnabled));
    const corsHandled = applyCors(req, res, ctx.corsConfig);
    if (corsHandled) return true;

    try {
      if (await handleVoiceWebhook(ctx, req, res, url)) return true;
      if (await handleVoiceWebhookRecording(ctx, req, res, url)) return true;
      if (await handleVoiceMetrics(ctx, req, res, url)) return true;
      if (await handleVoiceCallsEvents(ctx, req, res, url)) return true;
      if (await handleVoiceCallEnd(ctx, req, res, url)) return true;
      if (await handleVoiceCallTransfer(ctx, req, res, url)) return true;
      if (await handleVoiceCallRecording(ctx, req, res, url)) return true;
      if (await handleVoiceCalls(ctx, req, res, url)) return true;
      if (await handleVoiceRoot(ctx, req, res, url)) return true;

      writeJson(res, 404, { type: 'error', error: { message: 'Not found', code: 'not_found' } });
      return true;
    } catch (err: any) {
      const mapped = mapErrorToHttp(err);
      writeJson(res, mapped.status, mapped.body);
      return true;
    }
  };
}
