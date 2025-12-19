import { base64ToBytes, bytesToBase64 } from '@/modules/audio/index.ts';
import { convertAudioBytes, frameAudioBytes, type AudioSpec } from '@/plugins/modules/twilio-media-streams/internal/audio.ts';

function pcm16leBytes(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return out;
}

describe('plugins/modules/twilio-media-streams — audio bridging', () => {
  test('returns input unchanged when specs match', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const spec: AudioSpec = { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 };
    const out = convertAudioBytes({ input: bytes, inputSpec: spec, outputSpec: spec });
    expect(out).toBe(bytes);
  });

  test('converts g711_ulaw -> pcm16', () => {
    const ulaw = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const out = convertAudioBytes({
      input: ulaw,
      inputSpec: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
      outputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
    });
    expect(out.length).toBe(ulaw.length * 2);
  });

  test('converts pcm16 -> g711_ulaw', () => {
    const pcm = pcm16leBytes([0, 1000, -1000, 2000]);
    const out = convertAudioBytes({
      input: pcm,
      inputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 },
      outputSpec: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
    });
    expect(out.length).toBe(pcm.length / 2);
  });

  test('throws for unsupported input format', () => {
    expect(() =>
      convertAudioBytes({
        input: new Uint8Array([1, 2]),
        inputSpec: { format: 'g711_alaw', sampleRateHz: 8000, channels: 1 },
        outputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
      })
    ).toThrow('Unsupported input format');
  });

  test('throws for unsupported output format', () => {
    expect(() =>
      convertAudioBytes({
        input: new Uint8Array([1, 2]),
        inputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 },
        outputSpec: { format: 'g711_alaw', sampleRateHz: 8000, channels: 1 }
      })
    ).toThrow('Unsupported output format');
  });

  test('throws when g711_ulaw is not mono', () => {
    expect(() =>
      convertAudioBytes({
        input: new Uint8Array([1, 2]),
        inputSpec: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 2 },
        outputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
      })
    ).toThrow('g711_ulaw must be mono');
  });

  test('downmixes stereo pcm16 to mono', () => {
    // 2 frames, stereo interleaved: [L0,R0,L1,R1]
    const stereoSamples = [1000, 3000, -2000, 2000];
    const stereoBytes = pcm16leBytes(stereoSamples);
    const out = convertAudioBytes({
      input: stereoBytes,
      inputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 2 },
      outputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
    });

    const outSamples = Array.from(new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2));
    expect(outSamples).toEqual([2000, 0]);
  });

  test('throws on invalid stereo pcm16 byte length during downmix', () => {
    expect(() =>
      convertAudioBytes({
        input: new Uint8Array([0, 1]),
        inputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 2 },
        outputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
      })
    ).toThrow('Stereo PCM16LE byte length must be divisible by 4');
  });

  test('resamples pcm16 when sample rates differ', () => {
    const pcm = pcm16leBytes([0, 1000, 0, -1000, 0, 500, 0, -500]);
    const out = convertAudioBytes({
      input: pcm,
      inputSpec: { format: 'pcm16', sampleRateHz: 16000, channels: 1 },
      outputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).not.toBe(pcm.length);
  });

  test('throws on unsupported channel conversion (mono to stereo)', () => {
    expect(() =>
      convertAudioBytes({
        input: pcm16leBytes([0, 1]),
        inputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 1 },
        outputSpec: { format: 'pcm16', sampleRateHz: 8000, channels: 2 }
      })
    ).toThrow('Unsupported channel conversion');
  });

  test('frames bytes to fixed duration', () => {
    const ulaw = new Uint8Array(320).fill(0x55); // 40ms at 8k mono ulaw
    const frames = frameAudioBytes({
      bytes: ulaw,
      audio: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
      frameMs: 20
    });
    expect(frames).toHaveLength(2);
    expect(frames[0].length).toBe(160);
    expect(frames[1].length).toBe(160);
  });

  test('frameAudioBytes rejects non-mono g711_ulaw', () => {
    expect(() =>
      frameAudioBytes({
        bytes: new Uint8Array([1, 2, 3]),
        audio: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 2 },
        frameMs: 20
      })
    ).toThrow('g711_ulaw must be mono');
  });

  test('base64 roundtrip helper sanity', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

