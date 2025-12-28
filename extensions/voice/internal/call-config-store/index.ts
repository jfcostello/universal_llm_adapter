export type VoiceCallDirection = 'inbound' | 'outbound';

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
