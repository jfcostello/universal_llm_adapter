import type { RealtimeAudioFrame } from '../../../../../../kernel/index.js';
import { base64ToBytes, bytesToBase64, resamplePcm16leBytes } from '../../../../../../modules/audio/index.js';

export function toProviderPcm16(
  frame: RealtimeAudioFrame,
  options: { providerSampleRate: number }
): Uint8Array {
  if (frame.format !== 'pcm16') {
    throw new Error('sendAudio requires format=pcm16');
  }
  if (frame.channels !== 1) {
    throw new Error('sendAudio requires channels=1');
  }

  const bytes = base64ToBytes(frame.dataBase64);
  const providerSampleRate = Math.floor(options.providerSampleRate);
  if (Math.floor(frame.sampleRateHz) === providerSampleRate) return bytes;

  return resamplePcm16leBytes({
    bytes,
    fromSampleRateHz: frame.sampleRateHz,
    toSampleRateHz: providerSampleRate,
    channels: 1
  });
}

export function fromProviderPcm16(bytes: Uint8Array, options: { outputSampleRateHz: number; providerSampleRate: number }): RealtimeAudioFrame {
  const outputSampleRateHz = Math.floor(options.outputSampleRateHz);
  const providerSampleRate = Math.floor(options.providerSampleRate);

  if (outputSampleRateHz === providerSampleRate) {
    return {
      format: 'pcm16',
      sampleRateHz: outputSampleRateHz,
      channels: 1,
      dataBase64: bytesToBase64(bytes)
    };
  }

  const resampled = resamplePcm16leBytes({
    bytes,
    fromSampleRateHz: providerSampleRate,
    toSampleRateHz: outputSampleRateHz,
    channels: 1
  });
  return {
    format: 'pcm16',
    sampleRateHz: outputSampleRateHz,
    channels: 1,
    dataBase64: bytesToBase64(resampled)
  };
}

