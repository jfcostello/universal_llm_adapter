import type { RealtimeEvent, RealtimeAudioFrame } from '../../../../../../../kernel/index.js';
import type { RealtimeSession } from '../../../../../../../modules/realtime/index.js';
import type { AudioPacer } from '../../../../../../../modules/audio/index.js';
import { base64ToBytes } from '../../../../../../../modules/audio/index.js';
import { setUnrefTimeout } from '../../../../../../../modules/shared/index.js';

import type { AudioSpec } from '../../audio.js';
import { convertAudioBytes, frameAudioBytes } from '../../audio.js';
import type { ResettableQueue } from '../../resettable-queue.js';
import { DEFAULT_LIMITS } from './constants.js';
import { startDtmfPump } from './dtmf-pump.js';
import { startInboundPump } from './inbound-pump.js';
import { startOutboundPump } from './outbound-pump.js';
import type {
  AudioNegotiationState,
  DrainTrackingState,
  MarkTrackingState,
  OutboundItem,
  VoiceMediaOutboundMessage,
  UserSpeechState,
  VoiceMediaProtocolAdapter,
  VoiceMediaWsBridgeCallbacks,
  VoiceMediaWsBridgeLimits
} from './types.js';

async function* iterateAsyncIterator<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
    yield next.value;
  }
}

export function startSessionPump<Metadata>(options: {
  session: RealtimeSession;
  call: Metadata;
  streamId: string;
  adapter: VoiceMediaProtocolAdapter<Metadata>;
  sendMessage: (msg: VoiceMediaOutboundMessage) => void;
  mediaInputAudio: AudioSpec;
  mediaOutputAudio: AudioSpec;
  inboundAudioQueue: ResettableQueue<RealtimeAudioFrame>;
  outboundAudioQueue: ResettableQueue<OutboundItem>;
  dtmfQueue: ResettableQueue<string>;
  markToMs: Map<string, number>;
  markKindByName: Map<string, 'periodic' | 'drain'>;
  markState: MarkTrackingState;
  drainState: DrainTrackingState;
  audioState: AudioNegotiationState;
  userSpeechState: UserSpeechState;
  limits: Required<VoiceMediaWsBridgeLimits>;
  frameMs: number;
  markEveryMs: number;
  pacingEnabled: boolean;
  pacer: Pick<AudioPacer, 'paceBytes' | 'reset'>;
  callbacks: VoiceMediaWsBridgeCallbacks<Metadata>;
  clearPlayback: (call: Metadata, streamId: string) => void;
  closeAll: () => Promise<void>;
  timers: { firstTurnGraceTimer: any | undefined };
}): void {
  void (async () => {
    try {
      const iterator = options.session.events()[Symbol.asyncIterator]();

      const first = await iterator.next();
      if (first.done || !first.value) {
        options.callbacks.onError?.({
          message: 'Session ended before ready',
          code: 'session_ended_before_ready',
          metadata: options.call
        });
        void options.closeAll();
        return;
      }
      if (first.value.type !== 'ready') {
        options.callbacks.onError?.({
          message: 'Expected ready event',
          code: 'unexpected_session_event',
          metadata: options.call
        });
        void options.closeAll();
        return;
      }

      const audio = (first.value as any)?.audio ?? {};
      const inCfg = audio?.input ?? {};
      const outCfg = audio?.output ?? {};

      options.audioState.sessionReadyAudioInput = {
        format: (inCfg.format ?? options.mediaInputAudio.format) as AudioSpec['format'],
        sampleRateHz: Number(inCfg.sampleRateHz ?? options.mediaInputAudio.sampleRateHz),
        channels: (inCfg.channels ?? options.mediaInputAudio.channels) as 1 | 2
      };
      options.audioState.sessionReadyAudioOutput = {
        format: (outCfg.format ?? options.mediaOutputAudio.format) as AudioSpec['format'],
        sampleRateHz: Number(outCfg.sampleRateHz ?? options.mediaOutputAudio.sampleRateHz),
        channels: (outCfg.channels ?? options.mediaOutputAudio.channels) as 1 | 2
      };

      // Start pumps once the session is ready.
      startInboundPump({
        session: options.session,
        call: options.call,
        inboundAudioQueue: options.inboundAudioQueue,
        audioState: options.audioState,
        callbacks: options.callbacks,
        closeAll: options.closeAll
      });
      startOutboundPump({
        outboundAudioQueue: options.outboundAudioQueue,
        adapter: options.adapter,
        streamId: options.streamId,
        sendMessage: options.sendMessage,
        mediaOutputAudio: options.mediaOutputAudio,
        pacingEnabled: options.pacingEnabled,
        pacer: options.pacer,
        markEveryMs: options.markEveryMs,
        markToMs: options.markToMs,
        markKindByName: options.markKindByName,
        markState: options.markState
      });
      startDtmfPump({
        session: options.session,
        call: options.call,
        dtmfQueue: options.dtmfQueue,
        callbacks: options.callbacks,
        closeAll: options.closeAll
      });

      options.callbacks.onRealtimeEvent?.({ event: first.value as RealtimeEvent, metadata: options.call });

      const firstTurnGraceMs = Math.max(0, Math.floor(Number(options.limits.firstTurnGraceMs ?? 0)));
      const readyAtMs = Date.now();
      const firstTurnGraceEndsAtMs = firstTurnGraceMs > 0 ? readyAtMs + firstTurnGraceMs : 0;
      let firstAutoCommitDone = false;
      let sawUserSpeechStarted = false;

      const scheduleCommitAfterGrace = () => {
        const delay = Math.max(0, firstTurnGraceEndsAtMs - Date.now());
        clearTimeout(options.timers.firstTurnGraceTimer);
        options.timers.firstTurnGraceTimer = setUnrefTimeout(() => {
          options.timers.firstTurnGraceTimer = undefined;
          void (async () => {
            try {
              await options.session.commit();
              firstAutoCommitDone = true;
            } catch (err: any) {
              options.callbacks.onError?.({
                message: err?.message ?? String(err),
                code: 'session_commit_failed',
                metadata: options.call
              });
              void options.closeAll();
            }
          })();
        }, delay);
      };

      for await (const event of iterateAsyncIterator(iterator)) {
        const inGrace = Boolean(firstTurnGraceEndsAtMs) && Date.now() < firstTurnGraceEndsAtMs && !firstAutoCommitDone;
        const suppressUserTranscripts =
          inGrace &&
          !sawUserSpeechStarted &&
          (event.type === 'user_transcript.delta' || event.type === 'user_transcript.final');

        if (!suppressUserTranscripts) {
          options.callbacks.onRealtimeEvent?.({ event: event as RealtimeEvent, metadata: options.call });
        }

        if (event.type === 'user_speech.started') {
          options.userSpeechState.pendingUserSpeech = true;
          if (inGrace) sawUserSpeechStarted = true;
          if (inGrace) {
            clearTimeout(options.timers.firstTurnGraceTimer);
            options.timers.firstTurnGraceTimer = undefined;
          }
        } else if (event.type === 'user_speech.stopped') {
          if (options.userSpeechState.pendingUserSpeech) {
            options.userSpeechState.pendingUserSpeech = false;
            try {
              if (inGrace && !firstAutoCommitDone) {
                scheduleCommitAfterGrace();
              } else {
                await options.session.commit();
                firstAutoCommitDone = true;
              }
            } catch (err: any) {
              options.callbacks.onError?.({
                message: err?.message ?? String(err),
                code: 'session_commit_failed',
                metadata: options.call
              });
              void options.closeAll();
              return;
            }
          }
        } else if (event.type === 'assistant_audio.chunk') {
          const outputSpec = options.audioState.sessionReadyAudioOutput as AudioSpec;
          const outBytes = base64ToBytes(event.frame.dataBase64);
          const converted = convertAudioBytes({
            input: outBytes,
            inputSpec: outputSpec,
            outputSpec: options.mediaOutputAudio
          });
          const framed = frameAudioBytes({
            bytes: converted,
            audio: options.mediaOutputAudio,
            frameMs: options.frameMs
          });

          const maxPendingOutboundFramesRaw = Number(options.limits.maxPendingOutboundFrames);
          const maxPendingOutboundFrames = Number.isFinite(maxPendingOutboundFramesRaw)
            ? Math.max(1, Math.floor(maxPendingOutboundFramesRaw))
            : DEFAULT_LIMITS.maxPendingOutboundFrames;
          const wouldOverflow = options.outboundAudioQueue.size() + framed.length > maxPendingOutboundFrames;
          if (wouldOverflow) {
            options.callbacks.onError?.({
              message: 'Outbound backpressure',
              code: 'outbound_backpressure',
              metadata: options.call
            });
            options.clearPlayback(options.call, options.streamId);

            const capped = framed.length > maxPendingOutboundFrames
              ? framed.slice(framed.length - maxPendingOutboundFrames)
              : framed;
            for (const frame of capped) {
              options.outboundAudioQueue.push({ kind: 'audio', bytes: frame });
            }
          } else {
            for (const frame of framed) {
              options.outboundAudioQueue.push({ kind: 'audio', bytes: frame });
            }
          }
        } else if (event.type === 'assistant_audio.end') {
          const name = `d${++options.drainState.drainSeq}`;
          options.outboundAudioQueue.push({ kind: 'mark', name, markKind: 'drain' });
        } else if (event.type === 'playback.clear_requested') {
          options.clearPlayback(options.call, options.streamId);
        } else if (event.type === 'error' || event.type === 'timeout') {
          options.clearPlayback(options.call, options.streamId);
        } else if (event.type === 'closed') {
          void options.closeAll();
          return;
        }
      }
    } catch (err: any) {
      options.callbacks.onError?.({ message: err?.message ?? String(err), code: 'session_pump_failed', metadata: options.call });
      void options.closeAll();
    }
  })();
}
