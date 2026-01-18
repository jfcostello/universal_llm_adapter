import type http from 'http';

import type { VoiceCallEventHub } from '../../../call-events/index.js';
import type { VoiceCallConfigStore } from '../../../call-config-store/index.js';
import type { VoiceProviderPlugins } from '../../../provider-plugins/index.js';

import type { VoiceLogger } from './types.js';

export type VoiceServerContext = {
  registry: any;
  store: VoiceCallConfigStore;
  providerPlugins: VoiceProviderPlugins;

  resolveLogger: (correlationId?: string) => Promise<VoiceLogger | undefined>;
  safeLog: (
    logger: VoiceLogger | undefined,
    level: 'debug' | 'info' | 'warning' | 'error',
    message: string,
    data?: any
  ) => void;

  metrics: any;
  eventsHub: VoiceCallEventHub;
  emitCallEvent: (callConfigId: string, event: any) => void;

  maxRequestBytes: number;
  bodyReadTimeoutMs: number;

  authConfig: any;
  rateLimitConfig: any;
  corsConfig: any;
  securityHeadersEnabled: boolean;

  idempotencyWaitMs: number;
  idempotencyLockTtlSeconds: number;

  voiceDefaults: Record<string, any>;

  assertAuthorizedAndRateLimited: (req: http.IncomingMessage) => Promise<string | undefined>;

  eventsDefaultIncludeDeltas: boolean;
  eventsKeepAliveIntervalMs: number;
  eventsMaxWriteQueueBytes: number;

  recordingProxyTimeoutMs: number;

  pendingEndRequests: Map<string, { cancel: () => void }>;
  pendingTransferRequests: Map<string, { cancel: () => void }>;
};
