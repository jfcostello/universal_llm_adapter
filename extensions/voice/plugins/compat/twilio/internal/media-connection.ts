import type http from 'http';

import { createVoiceMediaWsBridge } from '../../../../modules/media-bridge/index.js';

import { createTwilioMediaStreamsProtocolAdapter } from './media-streams/adapter.js';
import { createTwilioMediaBridgeSession } from './media-connection-session.js';
import { isCallLogCaptureEnabled, makeProviderConfigError } from './shared.js';
import { resolveMediaConnectionConfig } from './media-connection-config.js';

export async function handleMediaConnection(options: {
  ws: any;
  req: http.IncomingMessage;
  callConfigId: string;
  callConfig: any;
  voiceProvider: string;
  registry: any;
  providerDefaults?: any;
  events?: { emit?: (event: any) => void };
  logger?: any;
  metrics?: any;
  endCall: (options: { providerCallId: string; providerDefaults?: any }) => Promise<{ ok: true }>;
  persistCallLogs: (options: { callConfigId: string; providerCallId: string; providerDefaults?: any; logger?: any }) => Promise<void>;
}): Promise<void> {
  const callConfig = options.callConfig ?? {};
  const systemPrompt = callConfig.systemPrompt;
  const realtimeSpec = callConfig.realtimeSpec ?? {};
  const requestId = typeof callConfig?.metadata?.requestId === 'string'
    ? String(callConfig.metadata.requestId).trim()
    : '';

  const logger = options.logger;
  const safeLog = (level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any) => {
    try {
      const fn = logger?.[level];
      if (typeof fn === 'function') fn(message, data);
    } catch {}
  };
  const metrics = options.metrics;
  const safeMetric = (name: string, ...args: any[]) => {
    try {
      const fn = metrics?.[name];
      if (typeof fn === 'function') fn(...args);
    } catch {}
  };
  const baseFields = {
    callConfigId: String(options.callConfigId),
    voiceProvider: String(options.voiceProvider),
    ...(requestId ? { requestId } : {})
  };
  const systemPromptField = systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {};

  const emitEvent = (event: any) => {
    try {
      const fn = options.events?.emit;
      if (typeof fn === 'function') fn(event);
    } catch {}
  };

  const outboundBufferMaxFramesCap = (() => {
    const raw = String(process.env.LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP ?? '').trim();
    if (!raw) return 300000;
    const n = Number(raw);
    const out = Math.floor(n);
    if (!Number.isFinite(n) || out < 0) {
      throw makeProviderConfigError('Invalid LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP');
    }
    return out;
  })();
  if (outboundBufferMaxFramesCap === 0) {
    safeLog('warning', 'voice.media.outbound_buffer_cap_disabled', { ...baseFields, cap: outboundBufferMaxFramesCap });
  }

  const {
    callTimeoutMs,
    silenceTimeoutMs,
    firstTurnGraceMs,
    silenceAssistantAudioEndFallbackMs,
    silenceAssistantAudioStartFallbackMs,
    assistantFirstTurnCfg,
    assistantFirstTurnEnabled,
    outboundBufferMaxFrames
  } = resolveMediaConnectionConfig({
    callConfig,
    providerDefaults: options.providerDefaults,
    outboundBufferMaxFramesCap
  });

  let providerCallId: string | undefined;
  let providerStreamId: string | undefined;

  let callTimeoutTimer: any | undefined;
  let silenceTimer: any | undefined;
  let assistantAudioStartFallbackTimer: any | undefined;
  let assistantAudioEndFallbackTimer: any | undefined;
  let waitingForFirstAssistantAudioEnd = assistantFirstTurnEnabled;
  let assistantAudioActive = false;
  let callEnded = false;

  const outboundBackpressureThrottleMs = 5000;
  let lastOutboundBackpressureLogAtMs = 0;

  const clearCallTimeout = () => {
    if (callTimeoutTimer) {
      clearTimeout(callTimeoutTimer);
      callTimeoutTimer = undefined;
    }
  };

  const clearSilenceTimeout = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = undefined;
    }
  };

  const clearAssistantAudioStartFallback = () => {
    if (assistantAudioStartFallbackTimer) {
      clearTimeout(assistantAudioStartFallbackTimer);
      assistantAudioStartFallbackTimer = undefined;
    }
  };

  const clearAssistantAudioEndFallback = () => {
    if (assistantAudioEndFallbackTimer) {
      clearTimeout(assistantAudioEndFallbackTimer);
      assistantAudioEndFallbackTimer = undefined;
    }
  };

  const clearAllTimers = () => {
    clearCallTimeout();
    clearSilenceTimeout();
    clearAssistantAudioStartFallback();
    clearAssistantAudioEndFallback();
  };

  const requestEndCallOnce = async (reason: string) => {
    if (callEnded) return;
    callEnded = true;
    clearAllTimers();

    emitEvent({ type: 'voice.call.end_requested', reason, ...(providerCallId ? { providerCallId } : {}) });

    if (providerCallId) {
      try {
        await options.endCall({ providerCallId, providerDefaults: options.providerDefaults });
      } catch (error: any) {
        safeLog('error', 'voice.call.end_failed', {
          ...baseFields,
          ...systemPromptField,
          providerCallId,
          reason,
          message: error?.message ?? String(error),
          code: error?.code !== undefined ? String(error.code) : undefined,
          statusCode: Number(error?.statusCode ?? error?.status ?? 0) || undefined
        });
      }
    }

    try { options.ws?.close?.(); } catch {}
  };

  const startSilenceTimer = (timeoutMs: number) => {
    clearSilenceTimeout();
    silenceTimer = setTimeout(() => void requestEndCallOnce('silence_timeout'), Math.floor(timeoutMs));
    if (typeof (silenceTimer as any)?.unref === 'function') {
      try { (silenceTimer as any).unref(); } catch {}
    }
  };

  const resolveAssistantAudioEndFallbackMs = (timeoutMs: number) => {
    if (silenceAssistantAudioEndFallbackMs !== undefined) {
      return Math.floor(silenceAssistantAudioEndFallbackMs);
    }
    return Math.min(2000, Math.max(500, Math.floor(timeoutMs)));
  };

  const resolveAssistantAudioStartFallbackMs = (timeoutMs: number) => {
    if (silenceAssistantAudioStartFallbackMs !== undefined) {
      return Math.floor(silenceAssistantAudioStartFallbackMs);
    }
    // Give the assistant time to start speaking before arming a silence timer (covers missing assistant audio events).
    // Prefer a stable default that is long enough to avoid racing typical greeting audio.
    return Math.max(3000, Math.floor(timeoutMs));
  };

  const scheduleAssistantAudioStartFallback = (timeoutMs: number) => {
    if (callEnded) return;
    if (!waitingForFirstAssistantAudioEnd) return;

    clearAssistantAudioStartFallback();
    const fallbackMs = resolveAssistantAudioStartFallbackMs(timeoutMs);
    assistantAudioStartFallbackTimer = setTimeout(() => {
      waitingForFirstAssistantAudioEnd = false;
      startSilenceTimer(timeoutMs);
    }, fallbackMs);
    if (typeof (assistantAudioStartFallbackTimer as any)?.unref === 'function') {
      (assistantAudioStartFallbackTimer as any).unref();
    }
  };

  const scheduleAssistantAudioEndFallback = (timeoutMs: number) => {
    if (callEnded) return;
    if (!assistantFirstTurnEnabled) return;
    if (!waitingForFirstAssistantAudioEnd) return;
    clearAssistantAudioEndFallback();

    const fallbackMs = resolveAssistantAudioEndFallbackMs(timeoutMs);
    assistantAudioEndFallbackTimer = setTimeout(() => {
      waitingForFirstAssistantAudioEnd = false;
      startSilenceTimer(timeoutMs);
    }, fallbackMs);
    if (typeof (assistantAudioEndFallbackTimer as any)?.unref === 'function') {
      (assistantAudioEndFallbackTimer as any).unref();
    }
  };

  const bridge = createVoiceMediaWsBridge({
    createSession: async ({ metadata }) =>
      await createTwilioMediaBridgeSession({
        registry: options.registry,
        realtimeSpec,
        systemPrompt,
        callConfigId: options.callConfigId,
        voiceProvider: options.voiceProvider,
        providerCallMetadata: metadata,
        assistantFirstTurnEnabled,
        assistantFirstTurnCfg,
        silenceTimeoutMs,
        scheduleAssistantAudioStartFallback,
        requestEndCallOnce,
        safeLog,
        baseFields
      }),
    adapter: createTwilioMediaStreamsProtocolAdapter(),
    mediaAudio: {
      input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
      output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
    },
    ...(() => {
      const limits = {
        ...(firstTurnGraceMs !== undefined ? { firstTurnGraceMs } : {}),
        ...(outboundBufferMaxFrames !== undefined ? { maxPendingOutboundFrames: outboundBufferMaxFrames } : {})
      };
      return Object.keys(limits).length > 0 ? { limits } : {};
    })(),
    callbacks: {
      onCallStart: (metadata) => {
        providerCallId = metadata.callSid;
        providerStreamId = metadata.streamSid;

        safeLog('info', 'voice.media.stream_started', {
          ...baseFields,
          providerStreamId: metadata.streamSid,
          providerCallId: metadata.callSid
        });

        emitEvent({ type: 'voice.call.connected', providerStreamId: metadata.streamSid, providerCallId: metadata.callSid });

        if (callTimeoutMs && !callTimeoutTimer) {
          callTimeoutTimer = setTimeout(() => void requestEndCallOnce('call_timeout'), Math.floor(callTimeoutMs));
          if (typeof (callTimeoutTimer as any)?.unref === 'function') {
            (callTimeoutTimer as any).unref();
          }
        }

        if (silenceTimeoutMs && !assistantFirstTurnEnabled) {
          startSilenceTimer(silenceTimeoutMs);
        }
      },
      onMark: ({ name, playedMs, kind }) => {
        if (kind !== 'drain') return;
        emitEvent({
          type: 'voice.playback.drained',
          mark: String(name),
          playedMs,
          ...(providerCallId ? { providerCallId } : {})
        });
      },
      onRealtimeEvent: ({ event, metadata }) => {
        if (event?.type === 'ready') {
          safeLog('info', 'voice.realtime.ready', {
            ...baseFields,
            providerStreamId: metadata.streamSid,
            realtimeSessionId: (event as any).sessionId
          });
        }

        const type = String((event as any)?.type ?? '');

        if (type === 'assistant_audio.chunk') {
          if (!assistantAudioActive) {
            assistantAudioActive = true;
            emitEvent({ type: 'voice.assistant_audio.started', ...(providerCallId ? { providerCallId } : {}) });
          }
        } else if (type === 'assistant_audio.end') {
          if (assistantAudioActive) assistantAudioActive = false;
          emitEvent({ type: 'voice.assistant_audio.ended', ...(providerCallId ? { providerCallId } : {}) });
        }

        if (
          type === 'ready' ||
          type === 'closed' ||
          type === 'timeout' ||
          type === 'error' ||
          type === 'user_speech.started' ||
          type === 'user_speech.stopped' ||
          type.startsWith('user_transcript.') ||
          type.startsWith('assistant_transcript.')
        ) {
          emitEvent(event);
        }

        if (silenceTimeoutMs) {
          if (type === 'user_speech.started') {
            clearSilenceTimeout();
            clearAssistantAudioStartFallback();
            clearAssistantAudioEndFallback();
          } else if (type === 'assistant_audio.chunk') {
            clearSilenceTimeout();
            clearAssistantAudioStartFallback();
            scheduleAssistantAudioEndFallback(silenceTimeoutMs);
          } else if (type === 'assistant_audio.end') {
            clearAssistantAudioStartFallback();
            clearAssistantAudioEndFallback();
            if (waitingForFirstAssistantAudioEnd) {
              waitingForFirstAssistantAudioEnd = false;
            }
            if (!waitingForFirstAssistantAudioEnd) {
              startSilenceTimer(silenceTimeoutMs);
            }
          }
        }

        if (type === 'closed') {
          clearAllTimers();
        }
      },
      onError: ({ message, code, metadata }) => {
        const codeStr = code !== undefined ? String(code) : '';
        if (codeStr === 'outbound_backpressure') {
          const nowMs = Date.now();
          if (nowMs - lastOutboundBackpressureLogAtMs >= outboundBackpressureThrottleMs) {
            lastOutboundBackpressureLogAtMs = nowMs;
            safeLog('warning', 'voice.media.outbound_backpressure', {
              ...baseFields,
              ...(metadata?.streamSid ? { providerStreamId: metadata.streamSid } : {}),
              ...(metadata?.callSid ? { providerCallId: metadata.callSid } : {}),
              code: codeStr,
              message: String(message)
            });
            safeMetric('compatError', 'media_bridge', baseFields.voiceProvider);
          }
          return;
        }

        safeLog('error', 'voice.media.bridge_error', {
          ...baseFields,
          ...systemPromptField,
          ...(metadata?.streamSid ? { providerStreamId: metadata.streamSid } : {}),
          ...(metadata?.callSid ? { providerCallId: metadata.callSid } : {}),
          code: codeStr,
          message: String(message)
        });
        safeMetric('compatError', 'media_bridge', baseFields.voiceProvider);
      }
    }
  });

  try {
    await bridge.handleConnection(options.ws, options.req);
  } finally {
    clearAllTimers();

    if (providerCallId && isCallLogCaptureEnabled()) {
      void (async () => {
        try {
          await options.persistCallLogs({
            callConfigId: String(options.callConfigId),
            providerCallId,
            providerDefaults: options.providerDefaults,
            logger
          });
        } catch (error: any) {
          safeLog('warning', 'voice.twilio.call_logs.persist_failed', {
            ...baseFields,
            providerCallId,
            message: error?.message ?? String(error)
          });
        }
      })();
    }
  }
}
