export type AudioFormat = 'pcm16' | 'g711_ulaw' | 'g711_alaw';

export function bytesPerSample(format: AudioFormat): number {
  if (format === 'pcm16') return 2;
  if (format === 'g711_ulaw' || format === 'g711_alaw') return 1;
  throw new Error(`Unsupported audio format: ${String(format)}`);
}

export function bytesForDurationMs(options: {
  format: AudioFormat;
  sampleRateHz: number;
  channels: 1 | 2;
  durationMs: number;
}): number {
  const sampleRateHz = Math.max(1, Math.floor(options.sampleRateHz));
  const channels = options.channels === 2 ? 2 : 1;
  const durationMs = Math.max(0, options.durationMs);
  const frames = Math.floor((sampleRateHz * durationMs) / 1000);
  return frames * channels * bytesPerSample(options.format);
}

export function durationMsForBytes(options: {
  format: AudioFormat;
  sampleRateHz: number;
  channels: 1 | 2;
  byteLength: number;
}): number {
  const sampleRateHz = Math.max(1, Math.floor(options.sampleRateHz));
  const channels = options.channels === 2 ? 2 : 1;
  const byteLength = Math.max(0, Math.floor(options.byteLength));
  const bps = bytesPerSample(options.format);
  const frames = byteLength / (channels * bps);
  return (frames * 1000) / sampleRateHz;
}

export function splitBytesIntoFrames(options: {
  bytes: Uint8Array;
  format: AudioFormat;
  sampleRateHz: number;
  channels: 1 | 2;
  frameMs: number;
}): Uint8Array[] {
  const bytes = options.bytes ?? new Uint8Array();
  const frameMs = Math.max(1, Math.floor(options.frameMs));
  const frameBytes = bytesForDurationMs({
    format: options.format,
    sampleRateHz: options.sampleRateHz,
    channels: options.channels,
    durationMs: frameMs
  });

  if (frameBytes <= 0) return bytes.length ? [bytes] : [];

  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += frameBytes) {
    frames.push(bytes.subarray(offset, Math.min(bytes.length, offset + frameBytes)));
  }
  return frames;
}
