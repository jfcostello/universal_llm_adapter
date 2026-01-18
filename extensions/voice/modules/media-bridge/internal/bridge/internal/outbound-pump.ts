import type { AudioPacer } from '../../../../../../../modules/audio/index.js';
import { bytesToBase64, durationMsForBytes } from '../../../../../../../modules/audio/index.js';

import type { AudioSpec } from '../../audio.js';
import type { ResettableQueue } from '../../resettable-queue.js';
import type {
  MarkTrackingState,
  OutboundItem,
  VoiceMediaOutboundMessage,
  VoiceMediaProtocolAdapter
} from './types.js';

export function startOutboundPump<Metadata>(options: {
  outboundAudioQueue: ResettableQueue<OutboundItem>;
  adapter: VoiceMediaProtocolAdapter<Metadata>;
  streamId: string;
  sendMessage: (msg: VoiceMediaOutboundMessage) => void;
  mediaOutputAudio: AudioSpec;
  pacingEnabled: boolean;
  pacer: Pick<AudioPacer, 'paceBytes' | 'reset'>;
  markEveryMs: number;
  markToMs: Map<string, number>;
  markKindByName: Map<string, 'periodic' | 'drain'>;
  markState: MarkTrackingState;
}): void {
  void (async () => {
    while (true) {
      const next = await options.outboundAudioQueue.next();
      if (!next) return;

      const { value, generation } = next;

      if (value === null) {
        continue;
      }

      if (generation !== options.outboundAudioQueue.currentGeneration()) {
        continue;
      }

      if (value.kind === 'mark') {
        options.markToMs.set(value.name, options.markState.sentAudioMsTotal);
        options.markKindByName.set(value.name, value.markKind);
        options.sendMessage(options.adapter.buildMarkMessage({ streamId: options.streamId, name: value.name }));
        continue;
      }

      const bytes = value.bytes;

      // Any clear interrupts in-flight frames as well as queued frames.
      if (options.pacingEnabled) {
        await options.pacer.paceBytes({
          format: options.mediaOutputAudio.format,
          sampleRateHz: options.mediaOutputAudio.sampleRateHz,
          channels: options.mediaOutputAudio.channels,
          byteLength: bytes.length
        });
      }

      if (generation !== options.outboundAudioQueue.currentGeneration()) {
        continue;
      }

      const payloadBase64 = bytesToBase64(bytes);
      options.sendMessage(options.adapter.buildAudioMessage({ streamId: options.streamId, payloadBase64 }));

      // Mark tracking for playback progress.
      const durMs = durationMsForBytes({
        format: options.mediaOutputAudio.format,
        sampleRateHz: options.mediaOutputAudio.sampleRateHz,
        channels: options.mediaOutputAudio.channels,
        byteLength: bytes.length
      });
      options.markState.sentAudioMsTotal += durMs;
      options.markState.pendingMarkMs += durMs;
      if (options.markState.pendingMarkMs >= options.markEveryMs) {
        const name = `m${++options.markState.markSeq}`;
        options.markToMs.set(name, options.markState.sentAudioMsTotal);
        options.markKindByName.set(name, 'periodic');
        options.markState.pendingMarkMs = 0;
        options.sendMessage(options.adapter.buildMarkMessage({ streamId: options.streamId, name }));
      }
    }
  })();
}
