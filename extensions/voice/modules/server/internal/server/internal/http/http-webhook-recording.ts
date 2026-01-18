import type http from 'http';

import { makeHttpError, readTrimmedStringProperty } from '../../../../../../../../modules/shared/index.js';

import type { VoiceServerContext } from '../core/context.js';
import { getPublicHttpBaseUrl } from '../config/public-url.js';
import { getWebhookValidationRequired } from '../ws/ws-token.js';
import { normalizeRequestId, readTextBody, writeJson } from './utils-http.js';

export async function handleVoiceWebhookRecording(
  ctx: VoiceServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/voice/webhook/recording') return false;

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
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

  const voiceProvider = String((callConfig as any)?.voiceProvider ?? '').trim();
  if (!voiceProvider) {
    writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
    return true;
  }

  const logger = await ctx.resolveLogger(callConfigId);
  const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
  const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    writeJson(res, 400, { type: 'error', error: { message: 'Unsupported content-type', code: 'validation_error' } });
    return true;
  }

  const rawBody = await readTextBody(req, { maxBytes: ctx.maxRequestBytes, timeoutMs: ctx.bodyReadTimeoutMs });
  const params: Record<string, string> = {};
  if (rawBody) {
    const form = new URLSearchParams(rawBody);
    for (const [k, v] of form.entries()) {
      params[String(k)] = String(v);
    }
  }

  let providerDefaults: any | undefined;
  try {
    const manifest = await ctx.providerPlugins.getManifest?.(voiceProvider);
    providerDefaults = (manifest as any)?.defaults;
  } catch {}

  const compat = await ctx.providerPlugins.getCompat(voiceProvider);
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
      const publicUrl = new URL(`${url.pathname}${url.search}`, httpBaseUrl).toString();

      await validateWebhookRequest({
        req,
        method,
        url: publicUrl,
        params,
        callConfigId,
        callConfig,
        voiceProvider,
        providerDefaults
      });
    }
  } catch (error: any) {
    const statusCode = Number(error?.statusCode ?? 500);
    const code = error?.code !== undefined ? String(error.code) : undefined;
    ctx.safeLog(
      logger,
      statusCode >= 500 ? 'error' : 'warning',
      'voice.webhook.recording.error',
      { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
    );
    throw error;
  }

  const recordingCfg = (callConfig as any)?.recording;
  if (!(recordingCfg && typeof recordingCfg === 'object' && (recordingCfg as any).enabled === true)) {
    writeJson(res, 409, { type: 'error', error: { message: 'Recording is not enabled for this call', code: 'recording_not_enabled' } });
    return true;
  }

  const parseRecordingWebhook = (compat as any)?.parseRecordingWebhook;
  if (typeof parseRecordingWebhook !== 'function') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice compat missing parseRecordingWebhook()', code: 'recording_parse_unavailable' } });
    return true;
  }

  let parsed: any;
  try {
    parsed = await parseRecordingWebhook({ params, callConfigId, callConfig, voiceProvider, providerDefaults });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode ?? 500);
    const code = error?.code !== undefined ? String(error.code) : undefined;
    ctx.safeLog(
      logger,
      statusCode >= 500 ? 'error' : 'warning',
      'voice.webhook.recording.parse_failed',
      { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
    );
    throw error;
  }

  const recordingId = String(parsed?.recordingId ?? '').trim();
  const recordingUrl = String(parsed?.recordingUrl ?? '').trim();
  const recordingStatus = String(parsed?.recordingStatus ?? '').trim();
  const providerCallId = String(parsed?.providerCallId ?? (callConfig as any)?.providerCallId ?? '').trim();
  if (!recordingId || !recordingUrl) {
    writeJson(res, 400, { type: 'error', error: { message: 'Missing recording fields', code: 'validation_error' } });
    return true;
  }

  const updatedRecording = {
    ...(recordingCfg as any),
    providerRecording: {
      id: recordingId,
      url: recordingUrl,
      ...(recordingStatus ? { status: recordingStatus } : {})
    }
  };

  const expiresAtMs = Number((callConfig as any)?.expiresAtMs);
  const ttlRemainingSeconds = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
    ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000))
    : 60;
  await ctx.store.putConfig({ ...(callConfig as any), recording: updatedRecording } as any, { ttlSeconds: ttlRemainingSeconds });

  ctx.emitCallEvent(callConfigId, { type: 'voice.recording.ready', recordingId, ...(providerCallId ? { providerCallId } : {}) });

  ctx.safeLog(logger, 'info', 'voice.webhook.recording.received', {
    callConfigId,
    voiceProvider,
    recordingId,
    ...(providerCallId ? { providerCallId } : {}),
    ...(requestId ? { requestId } : {})
  });

  writeJson(res, 200, { ok: true });
  return true;
}
