import type http from 'http';

import type { VoiceLogger } from '../core/types.js';

export type VoiceMediaWsState = {
  activeMediaWs: number;
  pendingMediaWs: number;
};

export function beginVoiceMediaSession(options: {
  state: VoiceMediaWsState;
  releasePending: () => void;

  wsReal: any;
  wsForCompat: any;

  req: http.IncomingMessage;

  callConfigId: string;
  callConfig: any;
  voiceProvider: string;

  requestId?: string;
  logger: VoiceLogger | undefined;

  compat: any;
  providerDefaults?: any;

  registry: any;
  store: any;

  emitCallEvent: (callConfigId: string, event: any) => void;
  metrics: any;
  safeLog: (
    logger: VoiceLogger | undefined,
    level: 'debug' | 'info' | 'warning' | 'error',
    message: string,
    data?: any
  ) => void;
}): void {
  options.releasePending();
  options.state.activeMediaWs += 1;

  const releaseActive = () => {
    options.state.activeMediaWs = Math.max(0, options.state.activeMediaWs - 1);
  };

  options.metrics.mediaWsConnected(options.voiceProvider);
  options.safeLog(options.logger, 'info', 'voice.media.connected', {
    callConfigId: options.callConfigId,
    voiceProvider: options.voiceProvider,
    ...(options.requestId ? { requestId: options.requestId } : {})
  });
  try {
    options.wsReal.on?.('close', (code: number) => {
      releaseActive();
      options.metrics.mediaWsClosed(options.voiceProvider);
      options.safeLog(options.logger, 'info', 'voice.media.closed', {
        callConfigId: options.callConfigId,
        voiceProvider: options.voiceProvider,
        code: Number(code),
        ...(options.requestId ? { requestId: options.requestId } : {})
      });
    });
    options.wsReal.on?.('error', (err: any) => {
      options.metrics.mediaWsError(options.voiceProvider);
      options.safeLog(options.logger, 'error', 'voice.media.ws_error', {
        callConfigId: options.callConfigId,
        voiceProvider: options.voiceProvider,
        message: err?.message ?? String(err),
        ...(options.requestId ? { requestId: options.requestId } : {})
      });
    });
  } catch {}

  void Promise.resolve()
    .then(() =>
      options.compat.handleMediaConnection({
        ws: options.wsForCompat,
        req: options.req,
        callConfigId: options.callConfigId,
        callConfig: options.callConfig,
        voiceProvider: options.voiceProvider,
        registry: options.registry,
        providerDefaults: options.providerDefaults,
        store: options.store,
        logger: options.logger,
        events: {
          emit: (event: any) => options.emitCallEvent(options.callConfigId, event)
        },
        metrics: options.metrics
      })
    )
    .catch((err: any) => {
      options.metrics.compatError('media_connection', options.voiceProvider);
      options.safeLog(options.logger, 'error', 'voice.media.error', {
        callConfigId: options.callConfigId,
        voiceProvider: options.voiceProvider,
        ...(options.requestId ? { requestId: options.requestId } : {}),
        code: err?.code !== undefined ? String(err.code) : undefined,
        message: err?.message ?? 'Media handler failed'
      });
      try { options.wsReal.close(); } catch {}
    });
}
