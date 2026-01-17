import type { VoiceMediaWsBridgeAudioOptions, VoiceMediaWsBridgeLimits } from './types.js';

export const DEFAULT_LIMITS: Required<VoiceMediaWsBridgeLimits> = {
  maxWsMessageBytes: 262144,
  maxAudioBytesPerSecond: 256000,
  idleTimeoutMs: 60000,
  maxSessionDurationMs: 3600000,
  startTimeoutMs: 5000,
  maxPendingInboundFrames: 200,
  maxPendingOutboundFrames: 15000,
  firstTurnGraceMs: 0
};

export const DEFAULT_AUDIO: Required<Pick<VoiceMediaWsBridgeAudioOptions, 'frameMs' | 'markEveryMs'>> = {
  frameMs: 20,
  markEveryMs: 200
};
