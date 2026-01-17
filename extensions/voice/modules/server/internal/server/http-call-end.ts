import type http from 'http';

import { readJsonBody } from '../../../../../../modules/server/index.js';
import { mapErrorToHttp } from '../../../../../../modules/transport/index.js';

import { scheduleDeferredAction } from '../../../deferred-action/index.js';
import {
  validateCancelOnUserSpeechServer,
  validateEndMode,
  validateMaxWaitMs,
  type GracefulEndMode
} from '../../../graceful-mode-validation/index.js';

import type { VoiceServerContext } from './context.js';
import { asPlainObject } from './utils-ws.js';
import { writeJson } from './utils-http.js';

export async function handleVoiceCallEnd(
  ctx: VoiceServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  const callPathParts = url.pathname.split('/').filter(Boolean);

  if (
    !(
      callPathParts.length === 4 &&
      callPathParts[0] === 'voice' &&
      callPathParts[1] === 'calls' &&
      callPathParts[2] &&
      callPathParts[3] === 'end'
    )
  ) {
    return false;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
    return true;
  }

  if (!ctx.authConfig || ctx.authConfig.mode === 'none') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice call end endpoint requires server auth to be enabled', code: 'not_implemented' } });
    return true;
  }

  await ctx.assertAuthorizedAndRateLimited(req);

  const callConfigId = String(callPathParts[2]).trim();
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

  const providerCallId = String((callConfig as any)?.providerCallId ?? '').trim();
  if (!providerCallId) {
    writeJson(res, 409, { type: 'error', error: { message: 'Call is missing providerCallId', code: 'not_ready' } });
    return true;
  }

  const endDefaults = asPlainObject((ctx.voiceDefaults as any)?.end) ?? {};
  const defaultMode: GracefulEndMode = (() => {
    const raw = String((endDefaults as any)?.defaultMode ?? '').trim();
    if (raw === 'after_playback') return 'after_playback';
    if (raw === 'after_assistant_audio') return 'after_assistant_audio';
    if (raw === 'immediate') return 'immediate';
    return 'immediate';
  })();
  const defaultMaxWaitMs = (() => {
    const raw = (endDefaults as any)?.defaultMaxWaitMs;
    if (raw === undefined || raw === null || raw === '') return 5000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 5000;
    const out = Math.floor(n);
    if (out < 0) return 5000;
    return out;
  })();
  const defaultCancelOnUserSpeech = validateCancelOnUserSpeechServer((endDefaults as any)?.defaultCancelOnUserSpeech, false);

  const maxWaitMsLimit = 60000;
  const body = await readJsonBody(req, { maxBytes: ctx.maxRequestBytes, timeoutMs: ctx.bodyReadTimeoutMs });

  let mode: GracefulEndMode;
  let maxWaitMs: number;
  let cancelOnUserSpeech: boolean;

  try {
    const modeRaw = body?.mode !== undefined && body?.mode !== null ? String(body.mode).trim() : '';
    mode = validateEndMode(modeRaw || undefined, defaultMode);
    maxWaitMs = validateMaxWaitMs(body?.maxWaitMs, defaultMaxWaitMs, maxWaitMsLimit);
    cancelOnUserSpeech = validateCancelOnUserSpeechServer(body?.cancelOnUserSpeech, defaultCancelOnUserSpeech);
  } catch (err: any) {
    const mapped = mapErrorToHttp(err);
    writeJson(res, mapped.status, mapped.body);
    return true;
  }

  let providerDefaults: any | undefined;
  try {
    const manifest = await ctx.providerPlugins.getManifest(voiceProvider);
    providerDefaults = (manifest as any)?.defaults;
  } catch {
    writeJson(res, 400, { type: 'error', error: { message: 'Unknown voiceProvider', code: 'validation_error' } });
    return true;
  }

  const compat = await ctx.providerPlugins.getCompat(voiceProvider);
  const endCall = (compat as any)?.endCall;
  if (typeof endCall !== 'function') {
    writeJson(res, 501, { type: 'error', error: { message: 'Voice provider does not support call termination', code: 'not_implemented' } });
    return true;
  }

  if (mode === 'immediate') {
    // Cancel any pending graceful request for this call before immediate execution
    const pending = ctx.pendingEndRequests.get(callConfigId);
    if (pending) {
      pending.cancel();
      ctx.pendingEndRequests.delete(callConfigId);
    }
    try {
      await endCall({ callConfigId, callConfig, voiceProvider, providerCallId, providerDefaults });
    } catch (err: any) {
      const mapped = mapErrorToHttp(err);
      writeJson(res, mapped.status, mapped.body);
      return true;
    }
    ctx.emitCallEvent(callConfigId, { type: 'voice.call.end_requested', reason: 'client_request', providerCallId });
    writeJson(res, 200, { ok: true, result: 'ended', mode, maxWaitMs, cancelOnUserSpeech, fallback: false });
    return true;
  }

  const eventTypes = (() => {
    const types: string[] = [];
    if (mode === 'after_playback') types.push('voice.playback.drained');
    if (mode === 'after_assistant_audio') types.push('voice.assistant_audio.ended');
    if (cancelOnUserSpeech) types.push('user_speech.started');
    return types;
  })();

  const triggerEvents = (() => {
    const types: string[] = [];
    if (mode === 'after_playback') types.push('voice.playback.drained');
    if (mode === 'after_assistant_audio') types.push('voice.assistant_audio.ended');
    return types;
  })();

  let deferredResult: 'scheduled' | 'noop' | 'executed';
  try {
    deferredResult = await scheduleDeferredAction({
      callConfigId,
      providerCallId,
      voiceProvider,
      eventTypes,
      maxWaitMs,
      cancelOnUserSpeech,
      triggerEvents,
      pendingRequests: ctx.pendingEndRequests,
      eventsHub: ctx.eventsHub,
      execute: async () => {
        await endCall({ callConfigId, callConfig, voiceProvider, providerCallId, providerDefaults });
      },
      onScheduled: () => {
        ctx.emitCallEvent(callConfigId, { type: 'voice.call.end_scheduled', mode, maxWaitMs, cancelOnUserSpeech, providerCallId });
      },
      onExecuted: (reason) => {
        ctx.emitCallEvent(callConfigId, { type: 'voice.call.end_requested', reason, providerCallId });
      },
      onCanceled: (reason) => {
        ctx.emitCallEvent(callConfigId, { type: 'voice.call.end_canceled', reason, providerCallId });
      },
      onFailed: async (err, reason) => {
        const message = err?.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200);
        const code = err?.code !== undefined ? String(err.code).slice(0, 64) : undefined;
        const statusCode = Number(err?.statusCode ?? err?.status ?? 0) || undefined;
        const logger = await ctx.resolveLogger(callConfigId);
        ctx.safeLog(logger, 'error', 'voice.calls.end_failed', {
          callConfigId,
          voiceProvider,
          providerCallId,
          reason,
          message,
          ...(code ? { code } : {}),
          ...(statusCode ? { statusCode } : {})
        });
        ctx.emitCallEvent(callConfigId, {
          type: 'voice.call.end_failed',
          reason,
          providerCallId,
          message,
          ...(code ? { code } : {}),
          ...(statusCode ? { statusCode } : {})
        });
      }
    });
  } catch (err: any) {
    // Execution failed when subscription was rejected - return error to client
    const mapped = mapErrorToHttp(err);
    writeJson(res, mapped.status, mapped.body);
    return true;
  }

  if (deferredResult === 'noop') {
    writeJson(res, 200, { ok: true, result: 'noop', mode, maxWaitMs, cancelOnUserSpeech });
    return true;
  }

  if (deferredResult === 'executed') {
    writeJson(res, 200, { ok: true, result: 'ended', mode, maxWaitMs, cancelOnUserSpeech, fallback: true });
    return true;
  }

  writeJson(res, 200, { ok: true, result: 'scheduled', mode, maxWaitMs, cancelOnUserSpeech, fallback: false });
  return true;
}

