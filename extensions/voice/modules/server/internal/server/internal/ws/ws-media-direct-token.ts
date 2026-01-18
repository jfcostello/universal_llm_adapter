import type http from 'http';
import type net from 'net';

import { writeHttpUpgradeResponse } from '../../../../../../../../modules/server/index.js';
import { readTrimmedStringProperty } from '../../../../../../../../modules/shared/index.js';

import type { VoiceServerContext } from '../core/context.js';
import { normalizeRequestId } from '../http/utils-http.js';
import { verifyVoiceMediaToken } from './ws-token.js';
import { beginVoiceMediaSession, type VoiceMediaWsState } from './ws-media-session.js';

export async function handleVoiceMediaUpgradeWithUrlToken(options: {
  ctx: VoiceServerContext;
  req: http.IncomingMessage;
  socket: net.Socket;
  head: Buffer;
  wss: any;
  state: VoiceMediaWsState;
  maxConcurrentSessions: number;
  reservePending: () => void;
  releasePending: () => void;
  urlToken: string;
}): Promise<boolean> {
  const verified = verifyVoiceMediaToken(options.urlToken);
  if (!verified.ok) {
    writeHttpUpgradeResponse(options.socket, 401, 'Unauthorized', 'Unauthorized');
    options.socket.destroy();
    return true;
  }

  const { callConfigId, voiceProvider, nonce, exp } = verified.payload;

  if (options.state.activeMediaWs + options.state.pendingMediaWs >= options.maxConcurrentSessions) {
    const logger = await options.ctx.resolveLogger(callConfigId);
    options.ctx.safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'server_busy' });
    writeHttpUpgradeResponse(options.socket, 503, 'Service Unavailable', 'Service Unavailable');
    options.socket.destroy();
    return true;
  }

  options.reservePending();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(1, Math.ceil(exp - nowSeconds));
  const nonceOk = await options.ctx.store.consumeNonceOnce(nonce, { ttlSeconds });
  if (!nonceOk) {
    const logger = await options.ctx.resolveLogger(callConfigId);
    options.ctx.safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'nonce_replay' });
    writeHttpUpgradeResponse(options.socket, 401, 'Unauthorized', 'Unauthorized');
    options.socket.destroy();
    options.releasePending();
    return true;
  }

  const callConfig = await options.ctx.store.getConfig(callConfigId);
  if (!callConfig) {
    const logger = await options.ctx.resolveLogger(callConfigId);
    options.ctx.safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'unknown_call_config' });
    writeHttpUpgradeResponse(options.socket, 404, 'Not Found', 'Not Found');
    options.socket.destroy();
    options.releasePending();
    return true;
  }

  const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
  const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

  if (String((callConfig as any).voiceProvider ?? '') !== voiceProvider) {
    const logger = await options.ctx.resolveLogger(callConfigId);
    options.ctx.safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'voice_provider_mismatch' });
    writeHttpUpgradeResponse(options.socket, 401, 'Unauthorized', 'Unauthorized');
    options.socket.destroy();
    options.releasePending();
    return true;
  }

  const logger = await options.ctx.resolveLogger(callConfigId);
  const compat = await options.ctx.providerPlugins.getCompat(voiceProvider);
  let providerDefaults: any | undefined;
  try {
    const manifest = await options.ctx.providerPlugins.getManifest?.(voiceProvider);
    providerDefaults = (manifest as any)?.defaults;
  } catch {}

  options.wss.handleUpgrade(options.req, options.socket, options.head, (ws: any) => {
    beginVoiceMediaSession({
      state: options.state,
      releasePending: options.releasePending,
      wsReal: ws,
      wsForCompat: ws,
      req: options.req,
      callConfigId,
      callConfig,
      voiceProvider,
      requestId,
      logger,
      compat,
      providerDefaults,
      registry: options.ctx.registry,
      store: options.ctx.store,
      emitCallEvent: options.ctx.emitCallEvent,
      metrics: options.ctx.metrics,
      safeLog: options.ctx.safeLog
    });
  });

  return true;
}
