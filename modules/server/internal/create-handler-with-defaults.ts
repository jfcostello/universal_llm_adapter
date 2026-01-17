import http from 'http';

import { deepMerge, getDefaults } from '../../../kernel/index.js';

import type { ServerDependencies, ServerOptions } from './server-types.js';
import { createServerHandler } from './handler.js';
import { resolveAuthConfig } from './auth-config.js';
import { defaultDependencies } from './default-dependencies.js';
import { resolvePluginsPathWithConfig } from './plugins-path.js';

export function createServerHandlerWithDefaults(options: ServerOptions = {}): http.RequestListener {
  const deps: ServerDependencies = { ...defaultDependencies, ...options.deps };
  if (!options.registry) {
    throw new Error('registry must be provided to createServerHandlerWithDefaults');
  }

  const serverDefaults = (deps.getDefaults ?? getDefaults)().server;
  const authDefaults = serverDefaults.auth ?? { mode: 'none' };
  const authConfig = resolveAuthConfig(options.auth, authDefaults);
  const rateLimitDefaults = serverDefaults.rateLimit ?? {};
  const corsDefaults = serverDefaults.cors ?? {};
  const policyDefaults = (serverDefaults as any).policy ?? {};
  const policyConfig =
    options.policy && typeof options.policy === 'object'
      ? (deepMerge(policyDefaults as any, options.policy as any) as any)
      : policyDefaults;
  const pluginsPath = resolvePluginsPathWithConfig(options.pluginsPath ?? './plugins');

  return createServerHandler({
    registry: options.registry,
    pluginsPath,
    batchId: options.batchId,
    closeLoggerAfterRequest: options.closeLoggerAfterRequest ?? false,
    deps,
    authorize: options.authorize,
    config: {
      maxRequestBytes: options.maxRequestBytes ?? serverDefaults.maxRequestBytes,
      bodyReadTimeoutMs: options.bodyReadTimeoutMs ?? serverDefaults.bodyReadTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs ?? serverDefaults.requestTimeoutMs,
      streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? serverDefaults.streamIdleTimeoutMs,
      maxConcurrentRequests: options.maxConcurrentRequests ?? serverDefaults.maxConcurrentRequests,
      maxConcurrentStreams: options.maxConcurrentStreams ?? serverDefaults.maxConcurrentStreams,
      maxQueueSize: options.maxQueueSize ?? serverDefaults.maxQueueSize,
      queueTimeoutMs: options.queueTimeoutMs ?? serverDefaults.queueTimeoutMs,
      maxConcurrentVectorRequests:
        options.maxConcurrentVectorRequests ?? serverDefaults.maxConcurrentVectorRequests,
      maxConcurrentVectorStreams:
        options.maxConcurrentVectorStreams ?? serverDefaults.maxConcurrentVectorStreams,
      vectorMaxQueueSize: options.vectorMaxQueueSize ?? serverDefaults.vectorMaxQueueSize,
      vectorQueueTimeoutMs:
        options.vectorQueueTimeoutMs ?? serverDefaults.vectorQueueTimeoutMs,
      maxConcurrentEmbeddingRequests:
        options.maxConcurrentEmbeddingRequests ?? serverDefaults.maxConcurrentEmbeddingRequests,
      embeddingMaxQueueSize:
        options.embeddingMaxQueueSize ?? serverDefaults.embeddingMaxQueueSize,
      embeddingQueueTimeoutMs:
        options.embeddingQueueTimeoutMs ?? serverDefaults.embeddingQueueTimeoutMs,
      auth: authConfig as any,
      rateLimit: { ...rateLimitDefaults, ...options.rateLimit },
      cors: { ...corsDefaults, ...options.cors },
      policy: policyConfig,
      securityHeadersEnabled:
        options.securityHeadersEnabled ?? serverDefaults.securityHeadersEnabled
    }
  });
}
