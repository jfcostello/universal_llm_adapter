import { base64ToBytes, bytesToBase64 } from '@/modules/audio/index.ts';
import { convertProviderAudioToSessionOutput, convertSessionAudioToProviderPcm16_16k } from '@/plugins/realtime-compat/gemini/internal/audio.ts';

describe('realtime-compat/gemini — audio', () => {
  test('convertSessionAudioToProviderPcm16_16k converts pcm16@24k to pcm16@16k mono', () => {
    // Choose a sample count divisible by 3 so 24k -> 16k resampling is exact (ratio 2/3).
    const pcm24kBytes = new Uint8Array(600).fill(0x00); // 300 samples
    const out = convertSessionAudioToProviderPcm16_16k({
      format: 'pcm16',
      sampleRateHz: 24000,
      channels: 1,
      dataBase64: bytesToBase64(pcm24kBytes)
    });

    expect(out.mimeType).toBe('audio/pcm;rate=16000');
    // 300 samples @24k => 200 samples @16k => 400 bytes
    expect(base64ToBytes(out.audioBase64).length).toBe(400);
  });

  test('convertSessionAudioToProviderPcm16_16k converts g711_ulaw@8k to pcm16@16k', () => {
    const ulaw8kBytes = new Uint8Array(100).fill(0xff); // 100 samples
    const out = convertSessionAudioToProviderPcm16_16k({
      format: 'g711_ulaw',
      sampleRateHz: 8000,
      channels: 1,
      dataBase64: bytesToBase64(ulaw8kBytes)
    });

    expect(out.mimeType).toBe('audio/pcm;rate=16000');
    // 100 ulaw samples @8k => 200 pcm16 samples @16k => 400 bytes
    expect(base64ToBytes(out.audioBase64).length).toBe(400);
  });

  test('convertSessionAudioToProviderPcm16_16k rejects non-mono input', () => {
    expect(() =>
      convertSessionAudioToProviderPcm16_16k({
        format: 'pcm16',
        sampleRateHz: 24000,
        channels: 2,
        dataBase64: bytesToBase64(new Uint8Array([0x00, 0x00, 0x00, 0x00]))
      })
    ).toThrow('channels=1');
  });

  test('convertSessionAudioToProviderPcm16_16k rejects unsupported input formats', () => {
    expect(() =>
      convertSessionAudioToProviderPcm16_16k({
        format: 'g711_alaw' as any,
        sampleRateHz: 8000,
        channels: 1,
        dataBase64: bytesToBase64(new Uint8Array([0x00]))
      })
    ).toThrow('Unsupported input format');
  });

  test('convertProviderAudioToSessionOutput parses rate= from mimeType and resamples output', () => {
    const pcm16kBytes = new Uint8Array([0x00, 0x00, 0xe8, 0x03]); // 2 samples @16k
    const frame = convertProviderAudioToSessionOutput({
      providerAudioBase64: bytesToBase64(pcm16kBytes),
      providerMimeType: 'audio/pcm;rate=16000',
      desired: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
    });

    expect(frame.format).toBe('pcm16');
    expect(frame.sampleRateHz).toBe(8000);
    expect(base64ToBytes(frame.dataBase64).length).toBe(2);
  });

  test('convertProviderAudioToSessionOutput falls back to desired sample rate when mimeType rate is missing/invalid', () => {
    const pcmBytes = new Uint8Array([0x00, 0x00, 0xe8, 0x03]); // 2 samples

    const noRate = convertProviderAudioToSessionOutput({
      providerAudioBase64: bytesToBase64(pcmBytes),
      providerMimeType: 'audio/pcm',
      desired: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
    });
    expect(base64ToBytes(noRate.dataBase64).length).toBe(4);

    const invalidRate = convertProviderAudioToSessionOutput({
      providerAudioBase64: bytesToBase64(pcmBytes),
      providerMimeType: 'audio/pcm;rate=0',
      desired: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
    });
    expect(base64ToBytes(invalidRate.dataBase64).length).toBe(4);
  });

  test('convertProviderAudioToSessionOutput treats undefined mimeType as no-rate', () => {
    const pcmBytes = new Uint8Array([0x00, 0x00]);
    const frame = convertProviderAudioToSessionOutput({
      providerAudioBase64: bytesToBase64(pcmBytes),
      providerMimeType: undefined as any,
      desired: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
    });

    expect(base64ToBytes(frame.dataBase64).length).toBe(2);
  });

  test('convertProviderAudioToSessionOutput supports desired g711_ulaw output', () => {
    const pcm16kBytes = new Uint8Array([0x00, 0x00, 0xe8, 0x03]); // 2 samples @16k
    const frame = convertProviderAudioToSessionOutput({
      providerAudioBase64: bytesToBase64(pcm16kBytes),
      providerMimeType: 'audio/pcm;rate=16000',
      desired: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
    });

    expect(frame.format).toBe('g711_ulaw');
    expect(frame.sampleRateHz).toBe(8000);
    expect(base64ToBytes(frame.dataBase64).length).toBe(1);
  });

  test('convertProviderAudioToSessionOutput rejects unsupported desired output formats', () => {
    expect(() =>
      convertProviderAudioToSessionOutput({
        providerAudioBase64: 'AA==',
        providerMimeType: 'audio/pcm;rate=16000',
        desired: { format: 'g711_alaw' as any, sampleRateHz: 8000, channels: 1 }
      })
    ).toThrow('Unsupported desired output format');
  });
});
