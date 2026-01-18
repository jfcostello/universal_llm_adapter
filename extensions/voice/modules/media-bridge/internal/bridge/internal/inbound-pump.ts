import type { RealtimeAudioFrame } from '../../../../../../../kernel/index.js';
import type { RealtimeSession } from '../../../../../../../modules/realtime/index.js';
import { base64ToBytes, bytesToBase64 } from '../../../../../../../modules/audio/index.js';

import type { AudioSpec } from '../../audio.js';
import { convertAudioBytes } from '../../audio.js';
import type { ResettableQueue } from '../../resettable-queue.js';
import type { AudioNegotiationState, VoiceMediaWsBridgeCallbacks } from './types.js';

export function startInboundPump<Metadata>(options: {
  session: RealtimeSession;
  call: Metadata;
  inboundAudioQueue: ResettableQueue<RealtimeAudioFrame>;
  audioState: AudioNegotiationState;
  callbacks: VoiceMediaWsBridgeCallbacks<Metadata>;
  closeAll: () => Promise<void>;
}): void {
  void (async () => {
    while (true) {
      const frame = await options.inboundAudioQueue.nextValue();
      if (frame === null) return;
      try {
        const target = options.audioState.sessionReadyAudioInput;
        if (target) {
          const inputSpec: AudioSpec = {
            format: frame.format as AudioSpec['format'],
            sampleRateHz: Number(frame.sampleRateHz),
            channels: frame.channels as 1 | 2
          };

          const sameFormat = inputSpec.format === target.format;
          const sameRate = Math.floor(inputSpec.sampleRateHz) === Math.floor(target.sampleRateHz);
          const sameCh = inputSpec.channels === target.channels;

          if (!sameFormat || !sameRate || !sameCh) {
            const inputBytes = base64ToBytes(frame.dataBase64);
            const converted = convertAudioBytes({ input: inputBytes, inputSpec, outputSpec: target });
            const outBase64 = bytesToBase64(converted);
            await options.session.sendAudio({
              format: target.format as any,
              sampleRateHz: target.sampleRateHz,
              channels: target.channels,
              dataBase64: outBase64
            });
            continue;
          }
        }

        await options.session.sendAudio(frame);
      } catch (err: any) {
        options.callbacks.onError?.({
          message: err?.message ?? String(err),
          code: 'session_send_audio_failed',
          metadata: options.call
        });
        void options.closeAll();
        return;
      }
    }
  })();
}
