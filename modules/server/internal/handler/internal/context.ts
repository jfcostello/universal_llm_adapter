import type http from 'http';

import { createLimiter } from '../../transport/limiter.js';
import { createRateLimiter } from '../../security/rate-limiter.js';
import { normalizeServerPolicy, type ServerPolicyConfig } from '../../security/policy.js';
import { runWithCoordinatorLifecycle, streamWithCoordinatorLifecycle } from '../../../../lifecycle/index.js';
import { createAuthenticator, type AuthContext } from '../../../../auth/index.js';
import type { PluginRegistryLike } from '../../../../lifecycle/index.js';

import type { ServerDependencies } from '../../../index.js';
import { createReadyChecker } from './ready-check.js';

export interface HandlerConfig {
  maxRequestBytes: number;
  bodyReadTimeoutMs: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxConcurrentRequests: number;
  maxConcurrentStreams: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  maxConcurrentVectorRequests?: number;
  maxConcurrentVectorStreams?: number;
  vectorMaxQueueSize?: number;
  vectorQueueTimeoutMs?: number;
  maxConcurrentEmbeddingRequests?: number;
  embeddingMaxQueueSize?: number;
  embeddingQueueTimeoutMs?: number;
  auth: any;
  rateLimit: any;
  cors: any;
  securityHeadersEnabled: boolean;
  policy?: ServerPolicyConfig;
}

export interface HandlerContextOptions {
  registry: PluginRegistryLike;
  pluginsPath: string;
  batchId?: string;
  closeLoggerAfterRequest: boolean;
  deps: ServerDependencies;
  lifecycle?: {
    runWithCoordinatorLifecycle?: typeof runWithCoordinatorLifecycle;
    streamWithCoordinatorLifecycle?: typeof streamWithCoordinatorLifecycle;
  };
  config: HandlerConfig;
  authorize?: (ctx: AuthContext, req: http.IncomingMessage) => boolean | Promise<boolean>;
}

export interface HandlerContext {
  registry: PluginRegistryLike;
  pluginsPath: string;
  batchId?: string;
  closeLoggerAfterRequest: boolean;
  deps: ServerDependencies;
  config: HandlerConfig;
  authorize?: HandlerContextOptions['authorize'];
  authenticator: ReturnType<typeof createAuthenticator>;
  policy: ReturnType<typeof normalizeServerPolicy>;
  runWithCoordinatorLifecycleFn: typeof runWithCoordinatorLifecycle;
  streamWithCoordinatorLifecycleFn: typeof streamWithCoordinatorLifecycle;
  checkReady: () => Promise<boolean>;
  llmRunLimiter: ReturnType<typeof createLimiter>;
  llmStreamLimiter: ReturnType<typeof createLimiter>;
  vectorRunLimiter: ReturnType<typeof createLimiter>;
  vectorStreamLimiter: ReturnType<typeof createLimiter>;
  embeddingRunLimiter: ReturnType<typeof createLimiter>;
  rateLimiter: ReturnType<typeof createRateLimiter>;
}

export function createHandlerContext(options: HandlerContextOptions): HandlerContext {
  const { registry, pluginsPath, batchId, closeLoggerAfterRequest, deps, config, authorize, lifecycle } = options;

  const authenticator = createAuthenticator(config.auth ?? { mode: 'none' });
  const policy = normalizeServerPolicy(config.policy);
  const { checkReady } = createReadyChecker(pluginsPath);

  const runWithCoordinatorLifecycleFn =
    lifecycle?.runWithCoordinatorLifecycle ?? runWithCoordinatorLifecycle;
  const streamWithCoordinatorLifecycleFn =
    lifecycle?.streamWithCoordinatorLifecycle ?? streamWithCoordinatorLifecycle;

  const llmRunLimiter = createLimiter({
    maxConcurrent: config.maxConcurrentRequests,
    maxQueueSize: config.maxQueueSize,
    queueTimeoutMs: config.queueTimeoutMs
  });

  const llmStreamLimiter = createLimiter({
    maxConcurrent: config.maxConcurrentStreams,
    maxQueueSize: config.maxQueueSize,
    queueTimeoutMs: config.queueTimeoutMs
  });

  const vectorRunLimiter = createLimiter({
    maxConcurrent: config.maxConcurrentVectorRequests ?? config.maxConcurrentRequests,
    maxQueueSize: config.vectorMaxQueueSize ?? config.maxQueueSize,
    queueTimeoutMs: config.vectorQueueTimeoutMs ?? config.queueTimeoutMs
  });

  const vectorStreamLimiter = createLimiter({
    maxConcurrent: config.maxConcurrentVectorStreams ?? config.maxConcurrentStreams,
    maxQueueSize: config.vectorMaxQueueSize ?? config.maxQueueSize,
    queueTimeoutMs: config.vectorQueueTimeoutMs ?? config.queueTimeoutMs
  });

  const embeddingRunLimiter = createLimiter({
    maxConcurrent: config.maxConcurrentEmbeddingRequests ?? config.maxConcurrentRequests,
    maxQueueSize: config.embeddingMaxQueueSize ?? config.maxQueueSize,
    queueTimeoutMs: config.embeddingQueueTimeoutMs ?? config.queueTimeoutMs
  });

  const rateLimiter = createRateLimiter(config.rateLimit ?? { enabled: false });

  return {
    registry,
    pluginsPath,
    batchId,
    closeLoggerAfterRequest,
    deps,
    config,
    authorize,
    authenticator,
    policy,
    runWithCoordinatorLifecycleFn,
    streamWithCoordinatorLifecycleFn,
    checkReady,
    llmRunLimiter,
    llmStreamLimiter,
    vectorRunLimiter,
    vectorStreamLimiter,
    embeddingRunLimiter,
    rateLimiter
  };
}
