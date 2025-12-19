import { pcm16leBytesToSamples, pcm16leSamplesToBytes } from './pcm16.js';

const BIAS = 0x84; // 132
const CLIP = 32635;

function linearSampleToUlaw(sample: number): number {
  let sign = 0;
  let magnitude = sample;

  if (magnitude < 0) {
    sign = 0x80;
    magnitude = -magnitude;
  }

  // JS number abs of -32768 is 32768; clip ensures bounds
  magnitude = Math.min(CLIP, magnitude);
  magnitude += BIAS;

  // Segment/exponent computed by highest-bit position:
  // exponent = floor(log2(magnitude)) - 7, clamped to [0..7]
  const exponent = Math.max(0, Math.min(7, Math.floor(Math.log2(magnitude)) - 7));
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;

  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulawByte;
}

function ulawToLinearSample(ulawByte: number): number {
  const u = (~ulawByte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;

  let magnitude = ((mantissa << 3) + BIAS) << exponent;
  magnitude -= BIAS;

  return sign ? -magnitude : magnitude;
}

export function encodePcm16SamplesToG711UlawBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = linearSampleToUlaw(samples[i]);
  }
  return out;
}

export function decodeG711UlawBytesToPcm16Samples(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = ulawToLinearSample(bytes[i]);
  }
  return out;
}

export function pcm16leBytesToG711UlawBytes(bytes: Uint8Array): Uint8Array {
  return encodePcm16SamplesToG711UlawBytes(pcm16leBytesToSamples(bytes));
}

export function g711UlawBytesToPcm16leBytes(bytes: Uint8Array): Uint8Array {
  return pcm16leSamplesToBytes(decodeG711UlawBytesToPcm16Samples(bytes));
}
