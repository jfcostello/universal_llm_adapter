import type http from 'http';

import crypto from 'crypto';

import { readJsonBody } from '../../../../../../../../modules/server/index.js';
import { calculateBackoffDelay, makeHttpError, readTrimmedStringProperty, sleep } from '../../../../../../../../modules/shared/index.js';

import { normalizeAssistantFirstTurn, normalizeVoiceCallRecording, normalizeVoiceCallTimeouts } from '../config/config-normalize.js';
import type { VoiceServerContext } from '../core/context.js';
import { getPublicHttpBaseUrl, toWsUrl } from '../config/public-url.js';
import { mintVoiceMediaToken } from '../ws/ws-token.js';
import { asPlainObject } from '../ws/utils-ws.js';
import { normalizeIdempotencyKey, normalizeRequestId, readRequestId, writeJson } from './utils-http.js';

export async function handleVoiceCalls(
  ctx: VoiceServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/voice/calls') return false;

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
    return true;
  }

  await ctx.assertAuthorizedAndRateLimited(req);

  if (!ctx.authConfig || ctx.authConfig.mode === 'none') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice calls endpoint requires server auth to be enabled', code: 'not_implemented' } });
    return true;
  }

  const body = await readJsonBody(req, { maxBytes: ctx.maxRequestBytes, timeoutMs: ctx.bodyReadTimeoutMs });
  const to = String(body?.to ?? '').trim();
  const from = String(body?.from ?? '').trim();
  const systemPrompt = body?.systemPrompt !== undefined ? String(body.systemPrompt) : undefined;
  const realtimeSpec = body?.realtimeSpec;
  const voiceProvider = String(body?.voiceProvider ?? '').trim();
  const assistantFirstTurn = normalizeAssistantFirstTurn({
    raw: body?.assistantFirstTurn,
    defaults: (ctx.voiceDefaults as any)?.assistantFirstTurn
  });
  const timeouts = normalizeVoiceCallTimeouts({
    raw: body?.timeouts,
    defaults: (ctx.voiceDefaults as any)?.timeouts
  });
  const recording = normalizeVoiceCallRecording({
    raw: body?.recording,
    defaults: (ctx.voiceDefaults as any)?.recording
  });

  const ttlSecondsRaw = body?.ttlSeconds;
  const ttlSeconds = ttlSecondsRaw === undefined || ttlSecondsRaw === null ? 900 : Number(ttlSecondsRaw);

  const requestIdFromBodyRaw = readTrimmedStringProperty(body?.metadata, 'requestId');
  const requestIdFromBody = requestIdFromBodyRaw ? normalizeRequestId(requestIdFromBodyRaw) : undefined;
  const requestIdFromHeader = readRequestId(req);
  const requestId = requestIdFromBody ?? requestIdFromHeader;

  if (!to || !from || !voiceProvider || !realtimeSpec) {
    writeJson(res, 400, { type: 'error', error: { message: 'Missing required fields', code: 'validation_error' } });
    return true;
  }

  if (recording?.enabled && recording.mode === 'adapter') {
    writeJson(res, 501, { type: 'error', error: { message: 'Adapter-side recording is not implemented', code: 'not_implemented' } });
    return true;
  }

  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    writeJson(res, 400, { type: 'error', error: { message: 'Invalid ttlSeconds', code: 'validation_error' } });
    return true;
  }

  const idempotencyKeyHeader = req.headers?.['idempotency-key'];
  const idempotencyKey =
    (typeof idempotencyKeyHeader === 'string' ? idempotencyKeyHeader : undefined) ??
    (body?.idempotencyKey !== undefined ? String(body.idempotencyKey) : undefined);
  const idempotencyKeyTrimmed = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
  const idempotencyKeyNormalized = normalizeIdempotencyKey(idempotencyKeyTrimmed);

  let callConfigId: string | undefined;
  let logger: any | undefined;

  try {
    if (idempotencyKeyNormalized) {
      const existing = await ctx.store.getIdempotency(idempotencyKeyNormalized);
      if (existing) {
        callConfigId = String((existing as any)?.callConfigId ?? '').trim();
        const providerCallId = String((existing as any)?.providerCallId ?? '').trim();
        logger = await ctx.resolveLogger(callConfigId || undefined);
        ctx.safeLog(logger, 'info', 'voice.calls.idempotency_hit', {
          ...(callConfigId ? { callConfigId } : {}),
          voiceProvider,
          ...(providerCallId ? { providerCallId } : {})
        });
        writeJson(res, 200, existing);
        return true;
      }

      const lockTtlSeconds = Math.max(1, Math.min(ttlSeconds, ctx.idempotencyLockTtlSeconds));
      const lockOk = await ctx.store.consumeNonceOnce(`idem:${idempotencyKeyNormalized}`, { ttlSeconds: lockTtlSeconds });
      if (!lockOk) {
        const start = Date.now();
        let attempt = 0;
        while (Date.now() - start < ctx.idempotencyWaitMs) {
          const ready = await ctx.store.getIdempotency(idempotencyKeyNormalized);
          if (ready) {
            callConfigId = String((ready as any)?.callConfigId ?? '').trim();
            const providerCallId = String((ready as any)?.providerCallId ?? '').trim();
            logger = await ctx.resolveLogger(callConfigId || undefined);
            ctx.safeLog(logger, 'info', 'voice.calls.idempotency_hit', {
              ...(callConfigId ? { callConfigId } : {}),
              voiceProvider,
              ...(providerCallId ? { providerCallId } : {})
            });
            writeJson(res, 200, ready);
            return true;
          }

          const elapsed = Date.now() - start;
          const remainingMs = Math.max(0, ctx.idempotencyWaitMs - elapsed);
          if (remainingMs <= 0) break;

          const delayMs = Math.min(calculateBackoffDelay(attempt, 25, 250), remainingMs);
          attempt += 1;
          await sleep(delayMs);
        }

        logger = await ctx.resolveLogger();
        ctx.safeLog(logger, 'warning', 'voice.calls.idempotency_in_progress', { voiceProvider });
        writeJson(res, 409, {
          type: 'error',
          error: { message: 'Idempotency key is already in progress', code: 'idempotency_in_progress' }
        });
        return true;
      }
    }

    let providerDefaults: any | undefined;
    try {
      const manifest = await ctx.providerPlugins.getManifest(voiceProvider);
      providerDefaults = (manifest as any).defaults;
    } catch {
      writeJson(res, 400, { type: 'error', error: { message: 'Unknown voiceProvider', code: 'validation_error' } });
      return true;
    }

    callConfigId = `voice_cfg_${crypto.randomBytes(18).toString('base64url')}`;
    logger = logger ?? (await ctx.resolveLogger(callConfigId));
    ctx.safeLog(logger, 'info', 'voice.calls.accepted', {
      callConfigId,
      voiceProvider,
      hasIdempotencyKey: Boolean(idempotencyKeyNormalized),
      ...(requestId ? { requestId } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {})
    });

    const metadataRaw = (body as any)?.metadata;
    const metadataObj =
      metadataRaw === undefined || metadataRaw === null
        ? undefined
        : asPlainObject(metadataRaw);
    if (metadataRaw !== undefined && metadataRaw !== null && !metadataObj) {
      throw makeHttpError({ message: 'Invalid metadata', statusCode: 400, code: 'validation_error' });
    }

    const metadata = (() => {
      const out = metadataObj ? { ...(metadataObj as Record<string, any>) } : undefined;

      const existingRaw = readTrimmedStringProperty(out, 'requestId');
      const existing = existingRaw ? normalizeRequestId(existingRaw) : undefined;
      const requestIdToStore = existing ?? requestId;
      if (!requestIdToStore) return out;
      return { ...(out ?? {}), requestId: requestIdToStore };
    })();

    const providerConfigRaw = (body as any)?.providerConfig;
    const providerConfig =
      providerConfigRaw === undefined || providerConfigRaw === null
        ? undefined
        : asPlainObject(providerConfigRaw);
    if (providerConfigRaw !== undefined && providerConfigRaw !== null && !providerConfig) {
      throw makeHttpError({ message: 'Invalid providerConfig', statusCode: 400, code: 'validation_error' });
    }

    await ctx.store.putConfig(
      {
        version: 1,
        callConfigId,
        createdAtMs: 0,
        expiresAtMs: 0,
        to,
        from,
        direction: 'outbound',
        systemPrompt,
        realtimeSpec,
        voiceProvider,
        ...(metadata ? { metadata } : {}),
        ...(providerConfig ? { providerConfig } : {}),
        ...(assistantFirstTurn ? { assistantFirstTurn } : {}),
        ...(timeouts ? { timeouts } : {}),
        ...(recording ? { recording } : {})
      } as any,
      { ttlSeconds }
    );

    const httpBaseUrl = getPublicHttpBaseUrl(req);
    const token = mintVoiceMediaToken({ callConfigId, voiceProvider });
    const mediaWsUrl = toWsUrl(httpBaseUrl, '/voice/media', { token });
    const recordingStatusCallbackUrl =
      recording?.enabled && recording.mode === 'provider'
        ? new URL(`/voice/webhook/recording?callConfigId=${encodeURIComponent(callConfigId)}`, httpBaseUrl).toString()
        : undefined;

    const compat = await ctx.providerPlugins.getCompat(voiceProvider);
    const callConfig = await ctx.store.getConfig(callConfigId);
    if (!callConfig) {
      throw makeHttpError({ message: 'Failed to load stored call config', statusCode: 500 });
    }

    ctx.metrics.outboundCallAttempt(voiceProvider);

    const outbound = await (async () => {
      try {
        return await compat.createOutboundCall({
          to,
          from,
          callConfigId,
          callConfig,
          voiceProvider,
          mediaWsUrl,
          ...(recordingStatusCallbackUrl ? { recordingStatusCallbackUrl } : {}),
          providerDefaults
        });
      } catch (error: any) {
        ctx.metrics.compatError('outbound_call', voiceProvider);
        throw error;
      }
    })();
    const providerCallId = String(outbound?.providerCallId ?? '').trim();
    if (!providerCallId) {
      throw makeHttpError({ message: 'Voice provider did not return providerCallId', statusCode: 502, code: 'provider_error' });
    }

    ctx.safeLog(logger, 'info', 'voice.calls.queued', {
      callConfigId,
      voiceProvider,
      providerCallId,
      ...(requestId ? { requestId } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {})
    });

    try {
      const expiresAtMs = Number((callConfig as any)?.expiresAtMs);
      const ttlRemainingSeconds = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
        ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000))
        : ttlSeconds;

      await ctx.store.putConfig(
        { ...(callConfig as any), providerCallId } as any,
        { ttlSeconds: ttlRemainingSeconds }
      );
    } catch (error: any) {
      ctx.safeLog(logger, 'warning', 'voice.calls.persist_provider_call_id_failed', {
        callConfigId,
        voiceProvider,
        providerCallId,
        message: error?.message ?? String(error),
        ...(requestId ? { requestId } : {})
      });

      // This is a first-class reliability problem: without a persisted providerCallId, call control and
      // recording retrieval may be broken. Attempt best-effort cleanup and fail the request.
      try {
        const endCall = (compat as any)?.endCall;
        if (typeof endCall === 'function') {
          await endCall({ callConfigId, callConfig, voiceProvider, providerCallId, providerDefaults });
        }
      } catch (endErr: any) {
        ctx.safeLog(logger, 'error', 'voice.calls.cleanup_end_call_failed', {
          callConfigId,
          voiceProvider,
          providerCallId,
          message: endErr?.message ?? String(endErr),
          ...(requestId ? { requestId } : {})
        });
      }

      try {
        await ctx.store.deleteConfig(callConfigId);
      } catch {}

      throw makeHttpError({
        message: 'Failed to persist providerCallId for outbound call',
        statusCode: 500,
        code: 'provider_call_id_persist_failed'
      });
    }

    const response = { callConfigId, providerCallId, status: 'queued' };
    if (idempotencyKeyNormalized) {
      await ctx.store.putIdempotency(idempotencyKeyNormalized, response, { ttlSeconds });
    }

    writeJson(res, 200, response);
    return true;
  } catch (error: any) {
    const statusCode = Number(error?.statusCode ?? 500);
    const code = error?.code !== undefined ? String(error.code) : undefined;
    const fallbackLogger = logger ?? (await ctx.resolveLogger(callConfigId));
    ctx.safeLog(
      fallbackLogger,
      statusCode >= 500 ? 'error' : 'warning',
      'voice.calls.error',
      {
        ...(callConfigId ? { callConfigId } : {}),
        voiceProvider,
        statusCode,
        ...(code ? { code } : {}),
        ...(requestId ? { requestId } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {})
      }
    );
    throw error;
  }
}
