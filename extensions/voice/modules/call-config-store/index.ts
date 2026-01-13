export type VoiceCallDirection = 'inbound' | 'outbound';

export type VoiceAssistantFirstTurnConfig = {
  enabled: boolean;
  prompt?: string;
  role: 'system' | 'user';
  delayMs: number;
  missingPromptBehavior: 'reject' | 'skip';
};

export type VoiceCallTimeoutsConfig = {
  callTimeoutMs?: number;
  silenceTimeoutMs?: number;
  silenceAssistantAudioStartFallbackMs?: number;
  silenceAssistantAudioEndFallbackMs?: number;
  firstTurnGraceMs?: number;
};

export type VoiceCallRecordingProviderRecording = {
  id: string;
  url: string;
  status?: string;
};

export type VoiceCallRecordingConfig = {
  enabled: boolean;
  mode: 'provider' | 'adapter';
  format: 'mp3' | 'wav';
  channels: 'mono' | 'dual';
  providerRecording?: VoiceCallRecordingProviderRecording;
};

export interface VoiceCallConfigV1 {
  version: 1;
  callConfigId: string;
  createdAtMs: number;
  expiresAtMs: number;

  to: string;
  from: string;
  direction: VoiceCallDirection;

  systemPrompt?: string;
  realtimeSpec: any;

  voiceProvider: string;
  metadata?: Record<string, any>;
  providerConfig?: Record<string, any>;

  providerCallId?: string;
  assistantFirstTurn?: VoiceAssistantFirstTurnConfig;
  timeouts?: VoiceCallTimeoutsConfig;
  recording?: VoiceCallRecordingConfig;
}

export interface VoiceCallConfigStore {
  putConfig: (config: VoiceCallConfigV1, options: { ttlSeconds: number }) => Promise<void>;
  getConfig: (callConfigId: string) => Promise<VoiceCallConfigV1 | null>;
  deleteConfig: (callConfigId: string) => Promise<void>;

  putIdempotency: (key: string, value: any, options: { ttlSeconds: number }) => Promise<void>;
  getIdempotency: (key: string) => Promise<any | null>;

  consumeNonceOnce: (nonce: string, options: { ttlSeconds: number }) => Promise<boolean>;
}

export { createInMemoryVoiceCallConfigStore } from './internal/memory.js';
export { createRedisVoiceCallConfigStore } from './internal/redis.js';
export { createVoiceCallConfigStoreFromEnv } from './internal/from-env.js';
