import type { RealtimeAudioFrame } from '../../../../../../../kernel/index.js';
import type { RealtimeSession } from '../../../../../../../modules/realtime/index.js';
import { AudioPacer } from '../../../../../../../modules/audio/index.js';
import { setUnrefTimeout } from '../../../../../../../modules/shared/index.js';
import { createAudioRateLimiter } from '../../../../../../../modules/server/index.js';

import type { AudioSpec } from '../../audio.js';
import { ResettableQueue } from '../../resettable-queue.js';
import { DEFAULT_AUDIO, DEFAULT_LIMITS } from './constants.js';
import { startSessionPump } from './session-pump.js';
import type {
  AudioNegotiationState,
  DrainTrackingState,
  MarkTrackingState,
  OutboundItem,
  UserSpeechState,
  VoiceMediaInboundEvent,
  VoiceMediaOutboundMessage,
  VoiceMediaWsBridge,
  VoiceMediaWsBridgeLimits,
  VoiceMediaWsBridgeOptions
} from './types.js';
import { approxBytesFromBase64, ensureSendable, safeClose } from './ws-helpers.js';

export function createVoiceMediaWsBridge<Metadata>(options: VoiceMediaWsBridgeOptions<Metadata>): VoiceMediaWsBridge {
  const limits: Required<VoiceMediaWsBridgeLimits> = {
    ...DEFAULT_LIMITS,
    ...(options.limits ?? {})
  };
  const audioCfg = options.audio ?? {};
  const frameMs = Math.max(1, Math.floor(audioCfg.frameMs ?? DEFAULT_AUDIO.frameMs));
  const markEveryMs = Math.max(1, Math.floor(audioCfg.markEveryMs ?? DEFAULT_AUDIO.markEveryMs));
  const pacer = audioCfg.pacing?.pacer ?? new AudioPacer();
  const pacingEnabled = audioCfg.pacing?.enabled !== false;

  const adapter = options.adapter;

  const mediaInputAudio: AudioSpec = {
    format: options.mediaAudio.input.format,
    sampleRateHz: Number(options.mediaAudio.input.sampleRateHz),
    channels: options.mediaAudio.input.channels as 1 | 2
  };
  const mediaOutputAudio: AudioSpec = {
    format: options.mediaAudio.output.format,
    sampleRateHz: Number(options.mediaAudio.output.sampleRateHz),
    channels: options.mediaAudio.output.channels as 1 | 2
  };

  const callbacks = options.callbacks ?? {};

  return {
    async handleConnection(ws, _req): Promise<void> {
      const rateLimiter = createAudioRateLimiter(limits.maxAudioBytesPerSecond);

      const timers: {
        idleTimer: any | undefined;
        durationTimer: any | undefined;
        startTimer: any | undefined;
        firstTurnGraceTimer: any | undefined;
      } = {
        idleTimer: undefined,
        durationTimer: undefined,
        startTimer: undefined,
        firstTurnGraceTimer: undefined
      };

      let closed = false;
      let metadata: Metadata | undefined;
      let streamId: string | undefined;

      let session: RealtimeSession | undefined;

      const inboundAudioQueue = new ResettableQueue<RealtimeAudioFrame>();
      const outboundAudioQueue = new ResettableQueue<OutboundItem>();
      const dtmfQueue = new ResettableQueue<string>();

      const audioState: AudioNegotiationState = {};
      const markState: MarkTrackingState = { sentAudioMsTotal: 0, pendingMarkMs: 0, markSeq: 0 };
      const drainState: DrainTrackingState = { drainSeq: 0 };
      const userSpeechState: UserSpeechState = { pendingUserSpeech: false };

      let playedMs: number | undefined;
      const markToMs = new Map<string, number>();
      const markKindByName = new Map<string, 'periodic' | 'drain'>();

      const touch = () => {
        if (!Number.isFinite(limits.idleTimeoutMs) || limits.idleTimeoutMs <= 0) return;
        if (timers.idleTimer) clearTimeout(timers.idleTimer);
        timers.idleTimer = setUnrefTimeout(() => {
          callbacks.onError?.({ message: 'WS idle timeout', code: 'ws_idle_timeout', metadata });
          safeClose(ws, 1000, 'Idle timeout');
        }, limits.idleTimeoutMs);
      };

      const closeAll = async () => {
        if (closed) return;
        closed = true;
        if (timers.idleTimer) clearTimeout(timers.idleTimer);
        if (timers.durationTimer) clearTimeout(timers.durationTimer);
        if (timers.startTimer) clearTimeout(timers.startTimer);
        clearTimeout(timers.firstTurnGraceTimer);
        timers.firstTurnGraceTimer = undefined;

        inboundAudioQueue.close();
        outboundAudioQueue.close();
        dtmfQueue.close();
        try { await session?.close?.(); } catch {}
        try { safeClose(ws, 1000, 'Closed'); } catch {}
      };

      const sendMessage = (msg: VoiceMediaOutboundMessage) => {
        if (closed) return;
        try {
          ensureSendable(ws);
          touch();
          ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
        } catch (err: any) {
          callbacks.onError?.({ message: err?.message ?? String(err), code: 'ws_send_failed', metadata });
          void closeAll();
        }
      };

      const clearPlayback = (call: Metadata, callStreamId: string) => {
        outboundAudioQueue.clear();
        pacer.reset();

        markState.sentAudioMsTotal = 0;
        markState.pendingMarkMs = 0;
        markState.markSeq = 0;
        drainState.drainSeq = 0;
        playedMs = undefined;
        markToMs.clear();
        markKindByName.clear();

        sendMessage(adapter.buildClearMessage({ streamId: callStreamId }));
      };

      ws.on('close', () => {
        void closeAll();
      });
      ws.on('error', () => {
        void closeAll();
      });

      touch();
      if (Number.isFinite(limits.maxSessionDurationMs) && limits.maxSessionDurationMs > 0) {
        timers.durationTimer = setUnrefTimeout(() => {
          callbacks.onError?.({ message: 'WS max session duration exceeded', code: 'ws_max_duration', metadata });
          safeClose(ws, 1000, 'Max duration');
        }, limits.maxSessionDurationMs);
      }
      if (Number.isFinite(limits.startTimeoutMs) && limits.startTimeoutMs > 0) {
        timers.startTimer = setUnrefTimeout(() => {
          callbacks.onError?.({ message: 'Missing start event', code: 'missing_start', metadata });
          safeClose(ws, 1008, 'Missing start');
        }, limits.startTimeoutMs);
      }

      const handleMedia = (msg: { payloadBase64: string }) => {
        const bytesApprox = approxBytesFromBase64(msg.payloadBase64);
        rateLimiter.charge(bytesApprox);

        // Always enqueue frames as the configured `mediaAudio.input`; the inbound pump will convert
        // to the negotiated session audio.input spec only when needed.
        inboundAudioQueue.push({
          format: mediaInputAudio.format,
          sampleRateHz: mediaInputAudio.sampleRateHz,
          channels: mediaInputAudio.channels,
          dataBase64: msg.payloadBase64
        });
      };

      ws.on('message', async (data: any) => {
        touch();
        const buf = Buffer.from(data as any);
        if (buf.length > limits.maxWsMessageBytes) {
          callbacks.onError?.({ message: 'WS message too large', code: 'message_too_large', metadata });
          safeClose(ws, 1009, 'Message too large');
          return;
        }

        const msgRaw = buf.toString('utf-8');

        let msg: VoiceMediaInboundEvent<Metadata>;
        try {
          msg = adapter.parseInbound(msgRaw);
        } catch (err: any) {
          callbacks.onError?.({ message: String(err), code: 'invalid_message', metadata });
          safeClose(ws, 1003, 'Invalid message');
          return;
        }

        try {
          switch (msg.type) {
            case 'connected':
              return;
            case 'start': {
              if (metadata) return;
              if (timers.startTimer) {
                clearTimeout(timers.startTimer);
                timers.startTimer = undefined;
              }

              metadata = msg.metadata;
              const callStreamId = msg.streamId;
              streamId = callStreamId;

              callbacks.onCallStart?.(metadata);
              session = await Promise.resolve(options.createSession({ metadata }));

              startSessionPump({
                session,
                call: metadata,
                streamId: callStreamId,
                adapter,
                sendMessage,
                mediaInputAudio,
                mediaOutputAudio,
                inboundAudioQueue,
                outboundAudioQueue,
                dtmfQueue,
                markToMs,
                markKindByName,
                markState,
                drainState,
                audioState,
                userSpeechState,
                limits,
                frameMs,
                markEveryMs,
                pacingEnabled,
                pacer,
                callbacks,
                clearPlayback,
                closeAll,
                timers
              });
              return;
            }
            case 'media': {
              if (!metadata || !streamId) {
                callbacks.onError?.({ message: 'Media received before start', code: 'media_before_start' });
                safeClose(ws, 1008, 'Missing start');
                return;
              }

              if (msg.streamId !== streamId) {
                callbacks.onError?.({ message: 'streamId mismatch', code: 'stream_id_mismatch', metadata });
                safeClose(ws, 1008, 'Forbidden');
                return;
              }

              if (inboundAudioQueue.size() >= limits.maxPendingInboundFrames) {
                callbacks.onError?.({ message: 'Inbound backpressure', code: 'inbound_backpressure', metadata });
                safeClose(ws, 1013, 'Busy');
                return;
              }

              handleMedia({ payloadBase64: msg.payloadBase64 });
              return;
            }
            case 'mark': {
              if (!metadata) return;
              const msAt = markToMs.get(msg.name);
              const kind = markKindByName.get(msg.name);
              if (msAt !== undefined) {
                playedMs = msAt;
              }
              if (msAt !== undefined) markToMs.delete(msg.name);
              if (kind) markKindByName.delete(msg.name);
              callbacks.onMark?.({ name: msg.name, metadata, ...(kind ? { kind } : {}), playedMs });
              return;
            }
            case 'dtmf': {
              if (!metadata) return;
              callbacks.onDtmf?.({ digit: msg.digit, metadata });
              dtmfQueue.push(msg.digit);
              return;
            }
            case 'stop': {
              void closeAll();
              return;
            }
          }
        } catch (err: any) {
          callbacks.onError?.({ message: err?.message ?? String(err), code: err?.code ?? 'bridge_error', metadata });
          void closeAll();
        }
      });

      // Keep the promise alive until the socket closes.
      await new Promise<void>(resolve => {
        ws.on('close', () => resolve());
      });
    }
  };
}
