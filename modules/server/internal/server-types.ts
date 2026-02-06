import type http from 'http';

import type { getDefaults } from '../../../kernel/index.js';
import type { AuthConfig, AuthContext } from '../../auth/index.js';
import type { CoordinatorLifecycleDeps, PluginRegistryLike } from '../../lifecycle/index.js';

export interface ServerDependencies extends CoordinatorLifecycleDeps<PluginRegistryLike, any> {
  getDefaults?: typeof getDefaults;
  createRegistry: (pluginsPath: string) => PromiseLike<PluginRegistryLike> | PluginRegistryLike;
  closeLogger: () => Promise<void>;
  createVectorCoordinator?: (registry: PluginRegistryLike) => PromiseLike<any> | any;
  createEmbeddingCoordinator?: (registry: PluginRegistryLike) => PromiseLike<any> | any;
  createRealtimeSession?: (registry: PluginRegistryLike, spec: any) => PromiseLike<any> | any;
}

export interface ServerRateLimitOptions {
  enabled?: boolean;
  requestsPerMinute?: number;
  burst?: number;
  trustProxyHeaders?: boolean;
  maxKeys?: number;
  keyTtlMs?: number;
}

export interface ServerCorsOptions {
  enabled?: boolean;
  allowedOrigins?: string[] | '*';
  allowedHeaders?: string[];
  allowCredentials?: boolean;
}

export interface ServerPolicyOptions {
  documents?: {
    filepath?: {
      enabled?: boolean;
      allowedRoots?: string[];
    };
  };
  telemetry?: {
    observabilityOverride?: {
      enabled?: boolean;
      allowlist?: string[];
    };
  };
}

export interface ServerOptions {
  host?: string;
  port?: number;
  pluginsPath?: string;
  batchId?: string;
  closeLoggerAfterRequest?: boolean;
  extensions?: {
    enabled?: string[];
  };
  realtime?: {
    enabled?: boolean;
    wsPath?: string;
    maxWsMessageBytes?: number;
    wsIdleTimeoutMs?: number;
    openHandshakeTimeoutMs?: number;
    maxConcurrentSessions?: number;
    maxAudioBytesPerSecond?: number;
    maxSessionDurationMs?: number;
  };
  maxRequestBytes?: number;
  bodyReadTimeoutMs?: number;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxConcurrentRequests?: number;
  maxConcurrentStreams?: number;
  maxQueueSize?: number;
  queueTimeoutMs?: number;
  maxConcurrentVectorRequests?: number;
  maxConcurrentVectorStreams?: number;
  vectorMaxQueueSize?: number;
  vectorQueueTimeoutMs?: number;
  maxConcurrentEmbeddingRequests?: number;
  embeddingMaxQueueSize?: number;
  embeddingQueueTimeoutMs?: number;
  auth?: AuthConfig;
  rateLimit?: ServerRateLimitOptions;
  cors?: ServerCorsOptions;
  policy?: ServerPolicyOptions;
  securityHeadersEnabled?: boolean;
  httpHeadersTimeoutMs?: number;
  httpRequestTimeoutMs?: number;
  httpKeepAliveTimeoutMs?: number;
  httpMaxHeadersCount?: number;
  authorize?: (ctx: AuthContext, req: http.IncomingMessage) => boolean | Promise<boolean>;
  deps?: Partial<ServerDependencies>;
  registry?: PluginRegistryLike;
}

export interface RunningServer {
  url: string;
  server: http.Server;
  close: () => Promise<void>;
}
