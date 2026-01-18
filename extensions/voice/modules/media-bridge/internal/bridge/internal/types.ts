import type { RealtimeEvent } from '../../../../../../../kernel/index.js';
import type { RealtimeSession } from '../../../../../../../modules/realtime/index.js';
import type { AudioPacer } from '../../../../../../../modules/audio/index.js';

import type { AudioSpec } from '../../audio.js';

export type VoiceRequestLike = { url?: string | undefined };

export type VoiceMediaWsLike = {
  readyState?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: 'message' | 'close' | 'error', cb: (...args: any[]) => void) => void;
};

export type VoiceMediaOutboundMessage = string | Record<string, any>;

export type VoiceMediaAudioConfig = {
  input: AudioSpec;
  output: AudioSpec;
};

export type VoiceMediaInboundEvent<Metadata> =
  | { type: 'connected' }
  | { type: 'start'; streamId: string; metadata: Metadata }
  | { type: 'media'; streamId: string; payloadBase64: string }
  | { type: 'mark'; streamId: string; name: string }
  | { type: 'dtmf'; streamId: string; digit: string }
  | { type: 'stop'; streamId: string };

export interface VoiceMediaProtocolAdapter<Metadata> {
  parseInbound: (raw: string) => VoiceMediaInboundEvent<Metadata>;
  buildClearMessage: (options: { streamId: string }) => VoiceMediaOutboundMessage;
  buildMarkMessage: (options: { streamId: string; name: string }) => VoiceMediaOutboundMessage;
  buildAudioMessage: (options: { streamId: string; payloadBase64: string }) => VoiceMediaOutboundMessage;
}

export interface VoiceMediaWsBridgeLimits {
  maxWsMessageBytes?: number;
  maxAudioBytesPerSecond?: number;
  idleTimeoutMs?: number;
  maxSessionDurationMs?: number;
  startTimeoutMs?: number;
  maxPendingInboundFrames?: number;
  maxPendingOutboundFrames?: number;
  firstTurnGraceMs?: number;
}

export interface VoiceMediaWsBridgeAudioOptions {
  frameMs?: number;
  markEveryMs?: number;
  pacing?: {
    enabled?: boolean;
    pacer?: Pick<AudioPacer, 'paceBytes' | 'reset'>;
  };
}

export interface VoiceMediaWsBridgeCallbacks<Metadata> {
  onCallStart?: (metadata: Metadata) => void;
  onDtmf?: (options: { digit: string; metadata: Metadata }) => void;
  onMark?: (options: { name: string; metadata: Metadata; kind?: 'periodic' | 'drain'; playedMs?: number }) => void;
  onRealtimeEvent?: (options: { event: RealtimeEvent; metadata: Metadata }) => void;
  onError?: (options: { message: string; code?: string; metadata?: Metadata }) => void;
}

export interface VoiceMediaWsBridgeOptions<Metadata> {
  createSession: (options: { metadata: Metadata }) => Promise<RealtimeSession> | RealtimeSession;
  adapter: VoiceMediaProtocolAdapter<Metadata>;
  mediaAudio: VoiceMediaAudioConfig;
  limits?: VoiceMediaWsBridgeLimits;
  audio?: VoiceMediaWsBridgeAudioOptions;
  callbacks?: VoiceMediaWsBridgeCallbacks<Metadata>;
}

export interface VoiceMediaWsBridge {
  handleConnection: (ws: VoiceMediaWsLike, req: VoiceRequestLike) => Promise<void>;
}

export type OutboundItem =
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'mark'; name: string; markKind: 'periodic' | 'drain' };

export type AudioNegotiationState = {
  sessionReadyAudioInput?: AudioSpec | undefined;
  sessionReadyAudioOutput?: AudioSpec | undefined;
};

export type MarkTrackingState = {
  sentAudioMsTotal: number;
  pendingMarkMs: number;
  markSeq: number;
};

export type DrainTrackingState = {
  drainSeq: number;
};

export type UserSpeechState = {
  pendingUserSpeech: boolean;
};
