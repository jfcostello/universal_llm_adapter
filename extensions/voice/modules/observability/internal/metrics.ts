export type VoiceCompatErrorStage =
  | 'webhook_validate'
  | 'webhook_response'
  | 'outbound_call'
  | 'media_connection'
  | 'media_bridge';

export type VoiceMetricSample = {
  name: string;
  type: 'counter' | 'gauge';
  value: number;
  labels?: Record<string, string>;
};

export type VoiceMetricsSnapshot = {
  enabled: boolean;
  metrics: VoiceMetricSample[];
};

export type VoiceMetrics = {
  enabled: boolean;
  outboundCallAttempt: (voiceProvider: string) => void;
  compatError: (stage: VoiceCompatErrorStage, voiceProvider: string) => void;
  mediaWsConnected: (voiceProvider: string) => void;
  mediaWsClosed: (voiceProvider: string) => void;
  mediaWsError: (voiceProvider: string) => void;
  snapshot: () => VoiceMetricsSnapshot;
};

function incByKey(map: Map<string, number>, key: string, delta: number) {
  const current = map.get(key) ?? 0;
  map.set(key, current + delta);
}

function clampMin0(n: number): number {
  return n < 0 ? 0 : n;
}

export function createVoiceMetrics(options: { enabled: boolean }): VoiceMetrics {
  const enabled = options.enabled === true;
  if (!enabled) {
    return {
      enabled: false,
      outboundCallAttempt: () => {},
      compatError: () => {},
      mediaWsConnected: () => {},
      mediaWsClosed: () => {},
      mediaWsError: () => {},
      snapshot: () => ({ enabled: false, metrics: [] })
    };
  }

  const outboundAttemptsByProvider = new Map<string, number>();

  const compatErrorsByStageProvider = new Map<string, number>();

  const wsActiveByProvider = new Map<string, number>();
  const wsOpenByProvider = new Map<string, number>();
  const wsCloseByProvider = new Map<string, number>();
  const wsErrorByProvider = new Map<string, number>();

  const ensureProvider = (voiceProvider: string) => {
    if (!outboundAttemptsByProvider.has(voiceProvider)) outboundAttemptsByProvider.set(voiceProvider, 0);
    if (!wsActiveByProvider.has(voiceProvider)) wsActiveByProvider.set(voiceProvider, 0);
    if (!wsOpenByProvider.has(voiceProvider)) wsOpenByProvider.set(voiceProvider, 0);
    if (!wsCloseByProvider.has(voiceProvider)) wsCloseByProvider.set(voiceProvider, 0);
    if (!wsErrorByProvider.has(voiceProvider)) wsErrorByProvider.set(voiceProvider, 0);
  };

  return {
    enabled: true,
    outboundCallAttempt: (voiceProvider) => {
      const id = String(voiceProvider ?? '').trim();
      if (!id) return;
      ensureProvider(id);
      incByKey(outboundAttemptsByProvider, id, 1);
    },
    compatError: (stage, voiceProvider) => {
      const id = String(voiceProvider ?? '').trim();
      const stageId = String(stage ?? '').trim();
      if (!id || !stageId) return;
      incByKey(compatErrorsByStageProvider, `${stageId}|${id}`, 1);
    },
    mediaWsConnected: (voiceProvider) => {
      const id = String(voiceProvider ?? '').trim();
      if (!id) return;
      ensureProvider(id);
      incByKey(wsActiveByProvider, id, 1);
      incByKey(wsOpenByProvider, id, 1);
    },
    mediaWsClosed: (voiceProvider) => {
      const id = String(voiceProvider ?? '').trim();
      if (!id) return;
      ensureProvider(id);
      const next = clampMin0(wsActiveByProvider.get(id)! - 1);
      wsActiveByProvider.set(id, next);
      incByKey(wsCloseByProvider, id, 1);
    },
    mediaWsError: (voiceProvider) => {
      const id = String(voiceProvider ?? '').trim();
      if (!id) return;
      ensureProvider(id);
      incByKey(wsErrorByProvider, id, 1);
    },
    snapshot: () => {
      const metrics: VoiceMetricSample[] = [];

      for (const [voiceProvider, value] of outboundAttemptsByProvider.entries()) {
        metrics.push({
          name: 'voice.calls.outbound_attempt_total',
          type: 'counter',
          value,
          labels: { voiceProvider }
        });
      }

      for (const [key, value] of compatErrorsByStageProvider.entries()) {
        const [stage, voiceProvider] = key.split('|');
        if (!stage || !voiceProvider) continue;
        metrics.push({
          name: 'voice.compat.error_total',
          type: 'counter',
          value,
          labels: { voiceProvider, stage }
        });
      }

      const providers = new Set<string>();
      for (const map of [wsActiveByProvider, wsOpenByProvider, wsCloseByProvider, wsErrorByProvider]) {
        for (const key of map.keys()) providers.add(key);
      }

      for (const voiceProvider of providers) {
        metrics.push({
          name: 'voice.media.ws_active',
          type: 'gauge',
          value: wsActiveByProvider.get(voiceProvider)!,
          labels: { voiceProvider }
        });
        metrics.push({
          name: 'voice.media.ws_open_total',
          type: 'counter',
          value: wsOpenByProvider.get(voiceProvider)!,
          labels: { voiceProvider }
        });
        metrics.push({
          name: 'voice.media.ws_close_total',
          type: 'counter',
          value: wsCloseByProvider.get(voiceProvider)!,
          labels: { voiceProvider }
        });
        metrics.push({
          name: 'voice.media.ws_error_total',
          type: 'counter',
          value: wsErrorByProvider.get(voiceProvider)!,
          labels: { voiceProvider }
        });
      }

      return { enabled: true, metrics };
    }
  };
}
