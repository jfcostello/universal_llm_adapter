import {
  g711UlawBytesToPcm16leBytes,
  pcm16leBytesToG711UlawBytes,
  resamplePcm16leBytes,
  splitBytesIntoFrames
} from '../../../../../modules/audio/index.js';

export type BridgeAudioFormat = 'pcm16' | 'g711_ulaw' | 'g711_alaw';

export interface AudioSpec {
  format: BridgeAudioFormat;
  sampleRateHz: number;
  channels: 1 | 2;
}

function downmixPcm16leToMono(bytes: Uint8Array): Uint8Array {
  if (bytes.length % 4 !== 0) {
    throw new Error('Stereo PCM16LE byte length must be divisible by 4');
  }
  const out = new Uint8Array(bytes.length / 2);
  const viewIn = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const viewOut = new DataView(out.buffer, out.byteOffset, out.byteLength);

  const frames = bytes.length / 4;
  for (let i = 0; i < frames; i++) {
    const left = viewIn.getInt16(i * 4, true);
    const right = viewIn.getInt16(i * 4 + 2, true);
    const mixed = Math.round((left + right) / 2);
    viewOut.setInt16(i * 2, mixed, true);
  }

  return out;
}

function ensureG711Mono(spec: AudioSpec): void {
  if (spec.format === 'g711_ulaw' && spec.channels !== 1) {
    throw new Error('g711_ulaw must be mono');
  }
}

function toPcm16leBytes(input: Uint8Array, spec: AudioSpec): Uint8Array {
  if (spec.format === 'pcm16') return input;
  if (spec.format === 'g711_ulaw') return g711UlawBytesToPcm16leBytes(input);
  throw new Error(`Unsupported input format: ${spec.format}`);
}

function fromPcm16leBytes(pcm16leBytes: Uint8Array, spec: AudioSpec): Uint8Array {
  if (spec.format === 'pcm16') return pcm16leBytes;
  if (spec.format === 'g711_ulaw') return pcm16leBytesToG711UlawBytes(pcm16leBytes);
  throw new Error(`Unsupported output format: ${spec.format}`);
}

export function convertAudioBytes(options: {
  input: Uint8Array;
  inputSpec: AudioSpec;
  outputSpec: AudioSpec;
}): Uint8Array {
  ensureG711Mono(options.inputSpec);
  ensureG711Mono(options.outputSpec);

  const inputSpec = options.inputSpec;
  const outputSpec = options.outputSpec;

  const sameFormat = inputSpec.format === outputSpec.format;
  const sameRate = Math.floor(inputSpec.sampleRateHz) === Math.floor(outputSpec.sampleRateHz);
  const sameCh = inputSpec.channels === outputSpec.channels;
  if (sameFormat && sameRate && sameCh) return options.input;

  // Convert via PCM16LE when sample rate/channels differ.
  let pcm16leBytes = toPcm16leBytes(options.input, inputSpec);
  let pcmChannels = inputSpec.format === 'pcm16' ? inputSpec.channels : 1;

  if (pcmChannels === 2 && outputSpec.channels === 1) {
    pcm16leBytes = downmixPcm16leToMono(pcm16leBytes);
    pcmChannels = 1;
  }

  if (Math.floor(inputSpec.sampleRateHz) !== Math.floor(outputSpec.sampleRateHz)) {
    pcm16leBytes = resamplePcm16leBytes({
      bytes: pcm16leBytes,
      fromSampleRateHz: inputSpec.sampleRateHz,
      toSampleRateHz: outputSpec.sampleRateHz,
      channels: pcmChannels
    });
  }

  if (pcmChannels !== outputSpec.channels) {
    throw new Error(`Unsupported channel conversion: ${pcmChannels} -> ${outputSpec.channels}`);
  }

  return fromPcm16leBytes(pcm16leBytes, outputSpec);
}

export function frameAudioBytes(options: {
  bytes: Uint8Array;
  audio: AudioSpec;
  frameMs: number;
}): Uint8Array[] {
  ensureG711Mono(options.audio);
  return splitBytesIntoFrames({
    bytes: options.bytes,
    format: options.audio.format,
    sampleRateHz: options.audio.sampleRateHz,
    channels: options.audio.channels,
    frameMs: options.frameMs
  });
}
