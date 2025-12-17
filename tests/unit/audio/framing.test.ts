import { bytesForDurationMs, bytesPerSample, durationMsForBytes, splitBytesIntoFrames } from '../../../modules/audio/index.js';

describe('audio/framing', () => {
  test('bytesPerSample returns expected values', () => {
    expect(bytesPerSample('pcm16')).toBe(2);
    expect(bytesPerSample('g711_ulaw')).toBe(1);
    expect(bytesPerSample('g711_alaw')).toBe(1);
  });

  test('bytesPerSample throws on unsupported formats', () => {
    expect(() => bytesPerSample('nope' as any)).toThrow('Unsupported audio format');
  });

  test('bytesForDurationMs computes PCM16 frame size (mono)', () => {
    // 24kHz * 20ms = 480 samples, *2 bytes = 960 bytes
    expect(bytesForDurationMs({ format: 'pcm16', sampleRateHz: 24000, channels: 1, durationMs: 20 })).toBe(960);
  });

  test('bytesForDurationMs computes 8-bit frame size (stereo)', () => {
    // 8kHz * 20ms = 160 frames, *2ch *1 byte = 320 bytes
    expect(bytesForDurationMs({ format: 'g711_ulaw', sampleRateHz: 8000, channels: 2, durationMs: 20 })).toBe(320);
  });

  test('durationMsForBytes inverts bytesForDurationMs for aligned inputs', () => {
    const bytes = bytesForDurationMs({ format: 'pcm16', sampleRateHz: 16000, channels: 1, durationMs: 20 });
    const ms = durationMsForBytes({ format: 'pcm16', sampleRateHz: 16000, channels: 1, byteLength: bytes });
    expect(ms).toBe(20);
  });

  test('durationMsForBytes supports stereo inputs', () => {
    const ms = durationMsForBytes({ format: 'g711_ulaw', sampleRateHz: 8000, channels: 2, byteLength: 320 });
    expect(ms).toBe(20);
  });

  test('splitBytesIntoFrames splits into fixed-size frames with remainder', () => {
    const frameBytes = bytesForDurationMs({ format: 'pcm16', sampleRateHz: 24000, channels: 1, durationMs: 20 });
    const input = new Uint8Array(frameBytes * 2 + 7);
    const frames = splitBytesIntoFrames({
      bytes: input,
      format: 'pcm16',
      sampleRateHz: 24000,
      channels: 1,
      frameMs: 20
    });
    expect(frames.length).toBe(3);
    expect(frames[0]?.length).toBe(frameBytes);
    expect(frames[1]?.length).toBe(frameBytes);
    expect(frames[2]?.length).toBe(7);
  });

  test('splitBytesIntoFrames returns [] for empty input', () => {
    const frames = splitBytesIntoFrames({
      bytes: new Uint8Array(),
      format: 'g711_ulaw',
      sampleRateHz: 8000,
      channels: 1,
      frameMs: 20
    });
    expect(frames).toEqual([]);
  });

  test('splitBytesIntoFrames returns original bytes when computed frameBytes is 0', () => {
    const input = new Uint8Array([1, 2, 3]);
    const frames = splitBytesIntoFrames({
      bytes: input,
      format: 'pcm16',
      sampleRateHz: 1,
      channels: 1,
      frameMs: 1
    });
    expect(frames).toEqual([input]);
  });

  test('splitBytesIntoFrames returns [] when frameBytes is 0 and bytes are empty', () => {
    const frames = splitBytesIntoFrames({
      bytes: new Uint8Array(),
      format: 'pcm16',
      sampleRateHz: 1,
      channels: 1,
      frameMs: 1
    });
    expect(frames).toEqual([]);
  });

  test('splitBytesIntoFrames tolerates missing bytes field', () => {
    const frames = splitBytesIntoFrames({
      bytes: undefined as any,
      format: 'pcm16',
      sampleRateHz: 24000,
      channels: 1,
      frameMs: 20
    });
    expect(frames).toEqual([]);
  });
});
