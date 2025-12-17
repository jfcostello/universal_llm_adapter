// Audio module public surface (provider-agnostic).
// Production code should import only from this file, not `internal/**`.

export { base64ToBytes, bytesToBase64 } from './internal/base64.js';
export {
  bytesForDurationMs,
  durationMsForBytes,
  bytesPerSample,
  splitBytesIntoFrames
} from './internal/framing.js';
export {
  pcm16leBytesToSamples,
  pcm16leSamplesToBytes
} from './internal/pcm16.js';
export {
  decodeG711UlawBytesToPcm16Samples,
  encodePcm16SamplesToG711UlawBytes,
  g711UlawBytesToPcm16leBytes,
  pcm16leBytesToG711UlawBytes
} from './internal/g711-ulaw.js';
export {
  resamplePcm16Samples,
  resamplePcm16leBytes
} from './internal/resampler.js';
export type { AudioPacerDeps } from './internal/pacer.js';
export { AudioPacer } from './internal/pacer.js';

