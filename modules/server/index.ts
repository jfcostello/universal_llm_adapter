import http from 'http';
import { AddressInfo } from 'net';
import { PluginRegistry, getDefaults } from '../kernel/index.js';
import type { LLMCallSpec, LLMStreamEvent } from '../kernel/index.js';
import type {
  CoordinatorLifecycleDeps,
  PluginRegistryLike
} from '../lifecycle/index.js';
import { createServerHandler } from './internal/handler.js';

export interface ServerDependencies
  extends CoordinatorLifecycleDeps<PluginRegistryLike, any> {
  getDefaults?: typeof getDefaults;
  createRegistry: (pluginsPath: string) => PromiseLike<PluginRegistryLike> | PluginRegistryLike;
  closeLogger: () => Promise<void>;
  createVectorCoordinator?: (registry: PluginRegistryLike) => PromiseLike<any> | any;
  createEmbeddingCoordinator?: (registry: PluginRegistryLike) => PromiseLike<any> | any;
}

export interface ServerAuthOptions {
  enabled?: boolean;
  allowBearer?: boolean;
  allowApiKeyHeader?: boolean;
  headerName?: string;
  apiKeys?: string[] | string;
  hashedKeys?: string[] | string;
  realm?: string;
}

export interface ServerRateLimitOptions {
  enabled?: boolean;
  requestsPerMinute?: number;
  burst?: number;
  trustProxyHeaders?: boolean;
}

export interface ServerCorsOptions {
  enabled?: boolean;
  allowedOrigins?: string[] | '*';
  allowedHeaders?: string[];
  allowCredentials?: boolean;
}

export interface ServerOptions {
  host?: string;
  port?: number;
  pluginsPath?: string;
  batchId?: string;
  closeLoggerAfterRequest?: boolean;
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
  auth?: ServerAuthOptions;
  rateLimit?: ServerRateLimitOptions;
  cors?: ServerCorsOptions;
  securityHeadersEnabled?: boolean;
  authorize?: (req: http.IncomingMessage) => boolean | Promise<boolean>;
  deps?: Partial<ServerDependencies>;
  registry?: PluginRegistryLike;
}

export interface RunningServer {
  url: string;
  server: http.Server;
  close: () => Promise<void>;
}

const defaultDependencies: ServerDependencies = {
  getDefaults,
  createRegistry: (pluginsPath: string) => new PluginRegistry(pluginsPath),
  createCoordinator: async (registry: PluginRegistryLike) => {
    const module = await import('../llm/index.js');
    return new module.LLMCoordinator(registry as any);
  },
  createVectorCoordinator: async (registry: PluginRegistryLike) => {
    const module = await import('../../coordinator/vector-coordinator.js');
    return new module.VectorStoreCoordinator(registry as any);
  },
  createEmbeddingCoordinator: async (registry: PluginRegistryLike) => {
    const module = await import('../../coordinator/embedding-coordinator.js');
    return new module.EmbeddingCoordinator(registry as any);
  },
  closeLogger: async () => (await import('../logging/index.js')).closeLogger()
};

export function createServerHandlerWithDefaults(
  options: ServerOptions = {}
): http.RequestListener {
  const deps: ServerDependencies = { ...defaultDependencies, ...options.deps };
  if (!options.registry) {
    throw new Error('registry must be provided to createServerHandlerWithDefaults');
  }
  const serverDefaults = (deps.getDefaults ?? getDefaults)().server;
  const authDefaults = serverDefaults.auth ?? {};
  const rateLimitDefaults = serverDefaults.rateLimit ?? {};
  const corsDefaults = serverDefaults.cors ?? {};
  return createServerHandler({
    registry: options.registry,
    pluginsPath: options.pluginsPath ?? './plugins',
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
      auth: { ...authDefaults, ...options.auth },
      rateLimit: { ...rateLimitDefaults, ...options.rateLimit },
      cors: { ...corsDefaults, ...options.cors },
      securityHeadersEnabled:
        options.securityHeadersEnabled ?? serverDefaults.securityHeadersEnabled ?? true
    }
  });
}

export async function createServer(options: ServerOptions = {}): Promise<RunningServer> {
  const deps: ServerDependencies = { ...defaultDependencies, ...options.deps };
  const serverDefaults = (deps.getDefaults ?? getDefaults)().server;
  const authDefaults = serverDefaults.auth ?? {};
  const rateLimitDefaults = serverDefaults.rateLimit ?? {};
  const corsDefaults = serverDefaults.cors ?? {};
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const pluginsPath = options.pluginsPath ?? './plugins';

  const registry =
    options.registry ?? (await deps.createRegistry(pluginsPath));
  if (typeof (registry as any).loadAll === 'function') {
    await (registry as any).loadAll();
  }

  const handler = createServerHandler({
    registry,
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
      auth: { ...authDefaults, ...options.auth },
      rateLimit: { ...rateLimitDefaults, ...options.rateLimit },
      cors: { ...corsDefaults, ...options.cors },
      securityHeadersEnabled:
        options.securityHeadersEnabled ?? serverDefaults.securityHeadersEnabled ?? true
    }
  });

  const server = http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(async (error) => {
          if (error) reject(error);
          else {
            await deps.closeLogger();
            resolve();
          }
        });
      })
  };
}

export type { LLMCallSpec, LLMStreamEvent };
