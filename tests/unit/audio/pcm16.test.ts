import { pcm16leBytesToSamples, pcm16leSamplesToBytes } from '../../../modules/audio/index.js';

describe('audio/pcm16', () => {
  test('encodes and decodes PCM16LE roundtrip', () => {
    const samples = new Int16Array([-32768, -1, 0, 1, 32767]);
    const bytes = pcm16leSamplesToBytes(samples);
    expect(bytes.length).toBe(samples.length * 2);

    const decoded = pcm16leBytesToSamples(bytes);
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  test('throws on odd PCM16 byte length', () => {
    expect(() => pcm16leBytesToSamples(new Uint8Array([0x00]))).toThrow('pcm16 bytes length must be even');
  });
});

