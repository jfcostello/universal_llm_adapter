import type { RealtimeAudioFrame } from '../../../../kernel/index.js';
import {
  base64ToBytes,
  bytesToBase64,
  decodeG711UlawBytesToPcm16Samples,
  pcm16leSamplesToBytes,
  resamplePcm16Samples,
  resamplePcm16leBytes,
  pcm16leBytesToG711UlawBytes
} from '../../../../modules/audio/index.js';

function parseRateFromMimeType(mimeType: string): number | undefined {
  const raw = String(mimeType ?? '');
  const m = raw.match(/rate\s*=\s*(\d+)/i);
  if (!m) return undefined;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function convertSessionAudioToProviderPcm16_16k(frame: RealtimeAudioFrame): { audioBase64: string; mimeType: string } {
  const channels = frame.channels === 2 ? 2 : 1;
  if (channels !== 1) {
    throw new Error('Provider input requires channels=1');
  }

  if (frame.format === 'pcm16') {
    const bytes = base64ToBytes(frame.dataBase64);
    const resampled = resamplePcm16leBytes({
      bytes,
      fromSampleRateHz: frame.sampleRateHz,
      toSampleRateHz: 16000,
      channels: 1
    });
    return { audioBase64: bytesToBase64(resampled), mimeType: 'audio/pcm;rate=16000' };
  }

  if (frame.format === 'g711_ulaw') {
    const ulawBytes = base64ToBytes(frame.dataBase64);
    const samples = decodeG711UlawBytesToPcm16Samples(ulawBytes);
    const resampled = resamplePcm16Samples({
      samples,
      fromSampleRateHz: frame.sampleRateHz,
      toSampleRateHz: 16000,
      channels: 1
    });
    const pcmBytes = pcm16leSamplesToBytes(resampled);
    return { audioBase64: bytesToBase64(pcmBytes), mimeType: 'audio/pcm;rate=16000' };
  }

  // g711_alaw is not yet supported by the audio module; require conversion upstream.
  throw new Error(`Unsupported input format for provider conversion: ${frame.format}`);
}

export function convertProviderAudioToSessionOutput(options: {
  providerAudioBase64: string;
  providerMimeType: string;
  desired: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
}): RealtimeAudioFrame {
  const providerBytes = base64ToBytes(options.providerAudioBase64);
  const providerRate = parseRateFromMimeType(options.providerMimeType) ?? options.desired.sampleRateHz;

  if (options.desired.format === 'pcm16') {
    const outBytes = resamplePcm16leBytes({
      bytes: providerBytes,
      fromSampleRateHz: providerRate,
      toSampleRateHz: options.desired.sampleRateHz,
      channels: options.desired.channels
    });
    return {
      format: 'pcm16',
      sampleRateHz: options.desired.sampleRateHz,
      channels: options.desired.channels,
      dataBase64: bytesToBase64(outBytes)
    };
  }

  if (options.desired.format === 'g711_ulaw') {
    const pcmResampled = resamplePcm16leBytes({
      bytes: providerBytes,
      fromSampleRateHz: providerRate,
      toSampleRateHz: options.desired.sampleRateHz,
      channels: 1
    });
    const ulawBytes = pcm16leBytesToG711UlawBytes(pcmResampled);
    return {
      format: 'g711_ulaw',
      sampleRateHz: options.desired.sampleRateHz,
      channels: 1,
      dataBase64: bytesToBase64(ulawBytes)
    };
  }

  throw new Error(`Unsupported desired output format: ${options.desired.format}`);
}
