import { resamplePcm16Samples, resamplePcm16leBytes, pcm16leSamplesToBytes, pcm16leBytesToSamples } from '../../../modules/audio/index.js';

describe('audio/resampler', () => {
  test('resamplePcm16Samples returns empty output for empty input', () => {
    const output = resamplePcm16Samples({
      samples: new Int16Array(),
      fromSampleRateHz: 8000,
      toSampleRateHz: 16000,
      channels: 1
    });
    expect(output.length).toBe(0);
  });

  test('resamplePcm16Samples preserves constant mono signal', () => {
    const inFrames = 160; // 20ms at 8kHz
    const input = new Int16Array(inFrames).fill(1000);
    const output = resamplePcm16Samples({
      samples: input,
      fromSampleRateHz: 8000,
      toSampleRateHz: 16000,
      channels: 1
    });
    expect(output.length).toBe(inFrames * 2);
    expect(new Set(Array.from(output))).toEqual(new Set([1000]));
  });

  test('resamplePcm16Samples preserves constant stereo signal', () => {
    const inFrames = 160;
    const interleaved = new Int16Array(inFrames * 2);
    for (let i = 0; i < inFrames; i++) {
      interleaved[i * 2] = 1111;
      interleaved[i * 2 + 1] = -2222;
    }
    const output = resamplePcm16Samples({
      samples: interleaved,
      fromSampleRateHz: 8000,
      toSampleRateHz: 24000,
      channels: 2
    });
    expect(output.length).toBe(inFrames * 3 * 2);
    for (let i = 0; i < output.length / 2; i++) {
      expect(output[i * 2]).toBe(1111);
      expect(output[i * 2 + 1]).toBe(-2222);
    }
  });

  test('resamplePcm16leBytes roundtrips via samples path', () => {
    const inputSamples = new Int16Array(80).fill(7);
    const bytes = pcm16leSamplesToBytes(inputSamples);
    const outBytes = resamplePcm16leBytes({
      bytes,
      fromSampleRateHz: 8000,
      toSampleRateHz: 8000,
      channels: 1
    });
    const outSamples = pcm16leBytesToSamples(outBytes);
    expect(Array.from(outSamples)).toEqual(Array.from(inputSamples));
  });

  test('throws when samples length not divisible by channels', () => {
    expect(() =>
      resamplePcm16Samples({
        samples: new Int16Array([1, 2, 3]),
        fromSampleRateHz: 8000,
        toSampleRateHz: 16000,
        channels: 2
      })
    ).toThrow('PCM16 sample length must be divisible by channels');
  });
});
