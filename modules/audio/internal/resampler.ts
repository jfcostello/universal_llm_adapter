import { pcm16leBytesToSamples, pcm16leSamplesToBytes } from './pcm16.js';

export function resamplePcm16Samples(options: {
  samples: Int16Array;
  fromSampleRateHz: number;
  toSampleRateHz: number;
  channels: 1 | 2;
}): Int16Array {
  const input = options.samples;
  const channels = options.channels === 2 ? 2 : 1;
  if (input.length % channels !== 0) {
    throw new Error('PCM16 sample length must be divisible by channels');
  }

  const fromHz = Math.max(1, Math.floor(options.fromSampleRateHz));
  const toHz = Math.max(1, Math.floor(options.toSampleRateHz));

  const inFrames = input.length / channels;
  if (inFrames === 0) return new Int16Array();
  if (fromHz === toHz) return input.slice();

  const ratio = toHz / fromHz;
  const outFrames = Math.max(1, Math.round(inFrames * ratio));
  const output = new Int16Array(outFrames * channels);

  for (let ch = 0; ch < channels; ch++) {
    for (let i = 0; i < outFrames; i++) {
      const srcPos = (i * fromHz) / toHz;
      const idx0 = Math.min(inFrames - 1, Math.floor(srcPos));
      const idx1 = Math.min(inFrames - 1, idx0 + 1);
      const frac = srcPos - idx0;

      const s0 = input[idx0 * channels + ch];
      const s1 = input[idx1 * channels + ch];

      const interpolated = Math.round(s0 + (s1 - s0) * frac);
      output[i * channels + ch] = interpolated;
    }
  }

  return output;
}

export function resamplePcm16leBytes(options: {
  bytes: Uint8Array;
  fromSampleRateHz: number;
  toSampleRateHz: number;
  channels: 1 | 2;
}): Uint8Array {
  const samples = pcm16leBytesToSamples(options.bytes);
  const resampled = resamplePcm16Samples({
    samples,
    fromSampleRateHz: options.fromSampleRateHz,
    toSampleRateHz: options.toSampleRateHz,
    channels: options.channels
  });
  return pcm16leSamplesToBytes(resampled);
}
