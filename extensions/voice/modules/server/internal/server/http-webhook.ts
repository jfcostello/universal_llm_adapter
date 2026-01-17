import type http from 'http';

import { makeHttpError, readTrimmedStringProperty } from '../../../../../../modules/shared/index.js';

import { getPublicHttpBaseUrl, toWsUrl } from './public-url.js';
import { getWebhookValidationRequired, mintVoiceMediaToken } from './ws-token.js';
import { normalizeRequestId, readTextBody, writeJson } from './utils-http.js';

export async function handleVoiceWebhook(ctx: any, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/voice/webhook') return false;

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
    return true;
  }

  const callConfigId = String(url.searchParams.get('callConfigId') ?? '').trim();
  if (!callConfigId) {
    writeJson(res, 400, { type: 'error', error: { message: 'Missing callConfigId', code: 'validation_error' } });
    return true;
  }

  const callConfig = await ctx.store.getConfig(callConfigId);
  if (!callConfig) {
    writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
    return true;
  }

  const voiceProvider = String((callConfig as any).voiceProvider ?? '').trim();
  if (!voiceProvider) {
    writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
    return true;
  }

  const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
  const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

  const logger = await ctx.resolveLogger(callConfigId);
  ctx.safeLog(logger, 'info', 'voice.webhook.request', { callConfigId, voiceProvider, method, ...(requestId ? { requestId } : {}) });

  const compat = await ctx.providerPlugins.getCompat(voiceProvider);
  const params: Record<string, string> = {};
  let webhookBodyText: string | undefined;
  let webhookBody: any | undefined;
  if (method === 'POST') {
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
    if (contentType.includes('application/x-www-form-urlencoded')) {
      webhookBodyText = await readTextBody(req, { maxBytes: ctx.maxRequestBytes, timeoutMs: ctx.bodyReadTimeoutMs });
      if (webhookBodyText) {
        const form = new URLSearchParams(webhookBodyText);
        for (const [k, v] of form.entries()) {
          params[String(k)] = String(v);
        }
      }
    } else if (contentType.includes('application/json') || contentType.includes('+json')) {
      const bodyText = await readTextBody(req, { maxBytes: ctx.maxRequestBytes, timeoutMs: ctx.bodyReadTimeoutMs });
      webhookBodyText = bodyText;
      const raw = bodyText.trim();
      if (!raw) {
        webhookBody = {};
      } else {
        try {
          webhookBody = JSON.parse(raw);
        } catch {}
      }
    }
  }

  try {
    const validateWebhookRequest = (compat as any)?.validateWebhookRequest;
    if (typeof validateWebhookRequest !== 'function') {
      if (getWebhookValidationRequired()) {
        throw makeHttpError({
          message: 'Voice compat missing validateWebhookRequest()',
          statusCode: 501,
          code: 'webhook_validation_unavailable'
        });
      }
    } else {
      const httpBaseUrl = getPublicHttpBaseUrl(req);
      const publicUrl = new URL(req.url ?? '/voice/webhook', httpBaseUrl).toString();

      let providerDefaults: any | undefined;
      try {
        const manifest = await ctx.providerPlugins.getManifest?.(voiceProvider);
        providerDefaults = (manifest as any)?.defaults;
      } catch {
        // ignore and allow compat to decide whether defaults are required
      }

      try {
        await validateWebhookRequest({
          req,
          method,
          url: publicUrl,
          params,
          ...(webhookBody !== undefined ? { body: webhookBody } : {}),
          ...(webhookBodyText !== undefined ? { bodyText: webhookBodyText } : {}),
          callConfigId,
          callConfig,
          voiceProvider,
          providerDefaults,
          store: ctx.store,
          logger,
          metrics: ctx.metrics
        });
      } catch (error: any) {
        ctx.metrics.compatError('webhook_validate', voiceProvider);
        const statusCode = Number(error?.statusCode ?? 500);
        const code = error?.code !== undefined ? String(error.code) : undefined;
        ctx.safeLog(
          logger,
          statusCode >= 500 ? 'error' : 'warning',
          'voice.webhook.validation_failed',
          { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
        );
        throw error;
      }
    }

    const httpBaseUrl = getPublicHttpBaseUrl(req);
    const token = mintVoiceMediaToken({ callConfigId, voiceProvider });
    const mediaWsUrl = toWsUrl(httpBaseUrl, '/voice/media', { token });

    const response = await (async () => {
      try {
        return await compat.createWebhookResponse({
          req,
          callConfigId,
          callConfig,
          voiceProvider,
          mediaWsUrl,
          params,
          ...(webhookBody !== undefined ? { body: webhookBody } : {}),
          ...(webhookBodyText !== undefined ? { bodyText: webhookBodyText } : {}),
          registry: ctx.registry,
          store: ctx.store,
          logger,
          events: { emit: (event: any) => ctx.emitCallEvent(callConfigId, event) },
          metrics: ctx.metrics
        });
      } catch (error: any) {
        ctx.metrics.compatError('webhook_response', voiceProvider);
        throw error;
      }
    })();
    const status = Number(response?.status ?? 200);
    const headers = (response?.headers && typeof response.headers === 'object') ? response.headers : {};
    const responseBody = String(response?.body ?? '');

    ctx.safeLog(logger, 'info', 'voice.webhook.response', { callConfigId, voiceProvider, status, ...(requestId ? { requestId } : {}) });

    res.writeHead(status, headers);
    res.end(responseBody);
    return true;
  } catch (error: any) {
    const statusCode = Number(error?.statusCode ?? 500);
    const code = error?.code !== undefined ? String(error.code) : undefined;
    if (!(statusCode === 401 && code === 'unauthorized')) {
      ctx.safeLog(
        logger,
        statusCode >= 500 ? 'error' : 'warning',
        'voice.webhook.error',
        { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
      );
    }
    throw error;
  }
}
