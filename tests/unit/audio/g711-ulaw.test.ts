import {
  decodeG711UlawBytesToPcm16Samples,
  encodePcm16SamplesToG711UlawBytes,
  g711UlawBytesToPcm16leBytes,
  pcm16leBytesToG711UlawBytes,
  pcm16leBytesToSamples,
  pcm16leSamplesToBytes
} from '../../../modules/audio/index.js';

describe('audio/g711_ulaw', () => {
  test('encodes known edge values deterministically', () => {
    const samples = new Int16Array([-32768, 0, 32767]);
    const encoded = encodePcm16SamplesToG711UlawBytes(samples);
    expect(Array.from(encoded)).toEqual([0x00, 0xff, 0x80]);
  });

  test('decodes known codes deterministically', () => {
    const decoded = decodeG711UlawBytesToPcm16Samples(new Uint8Array([0xff, 0x80, 0x00]));
    expect(Array.from(decoded)).toEqual([0, 32124, -32124]);
  });

  test('byte-level wrappers convert between PCM16LE bytes and μ-law bytes', () => {
    const pcmSamples = new Int16Array([0, 32767, -32768]);
    const pcmBytes = pcm16leSamplesToBytes(pcmSamples);
    const ulawBytes = pcm16leBytesToG711UlawBytes(pcmBytes);
    expect(Array.from(ulawBytes)).toEqual([0xff, 0x80, 0x00]);

    const outPcmBytes = g711UlawBytesToPcm16leBytes(ulawBytes);
    const outSamples = pcm16leBytesToSamples(outPcmBytes);
    expect(Array.from(outSamples)).toEqual([0, 32124, -32124]);
  });

  test('roundtrip stays within telephony tolerances', () => {
    const input: number[] = [];
    // Deterministic sample sweep (avoid exact extremes)
    for (let s = -30000; s <= 30000; s += 3000) {
      input.push(s);
    }
    const samples = new Int16Array(input);
    const encoded = encodePcm16SamplesToG711UlawBytes(samples);
    const decoded = decodeG711UlawBytesToPcm16Samples(encoded);
    expect(decoded.length).toBe(samples.length);

    let maxAbsErr = 0;
    for (let i = 0; i < samples.length; i++) {
      const err = Math.abs((samples[i] ?? 0) - (decoded[i] ?? 0));
      if (err > maxAbsErr) maxAbsErr = err;
    }
    expect(maxAbsErr).toBeLessThanOrEqual(3000);
  });
});
