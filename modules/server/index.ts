import http from 'http';
import { AddressInfo } from 'net';
import { PluginRegistry, deepMerge, getAdapterPathsConfig, getDefaults } from '../../kernel/index.js';
import type { LLMCallSpec, LLMStreamEvent } from '../../kernel/index.js';
import type { AuthConfig, AuthContext } from '../auth/index.js';
import { readTrimmedStringProperty } from '../shared/index.js';
import {
  resolveEffectivePluginsPath,
  type CoordinatorLifecycleDeps,
  type PluginRegistryLike
} from '../lifecycle/index.js';
import { createServerHandler } from './internal/handler.js';

export { mapErrorToHttp } from './internal/transport/error-mapper.js';
export {
  assertValidSpec,
  assertValidVectorSpec,
  assertValidEmbeddingSpec
} from './internal/transport/spec-validator.js';

// Public server helpers intended for use by extensions.
export { readJsonBody } from './internal/transport/body-parser.js';
export { writeHttpUpgradeResponse } from './internal/transport/upgrade-router.js';
export type { AuthConfig, AuthContext, AuthErrorLike, Authenticator } from '../auth/index.js';
export { createAuthenticator } from '../auth/index.js';
export type { CorsConfig } from './internal/security/cors.js';
export { applyCors } from './internal/security/cors.js';
export { applySecurityHeaders } from './internal/security/security-headers.js';
export type { RateLimitConfig } from './internal/security/rate-limiter.js';
export { createRateLimiter, getClientIp } from './internal/security/rate-limiter.js';

export interface ServerDependencies
  extends CoordinatorLifecycleDeps<PluginRegistryLike, any> {
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

/**
 * Default dependencies using shared factory functions.
 * This ensures CLI and server use identical coordinator creation logic.
 * All imports are dynamic to preserve lazy loading.
 */
const defaultDependencies: ServerDependencies = {
  getDefaults,
  createRegistry: async (pluginsPath: string) => {
    const { createRegistry } = await import('../lifecycle/index.js');
    return createRegistry(pluginsPath);
  },
  createCoordinator: async (registry: PluginRegistryLike) => {
    const { createLlmCoordinator } = await import('../lifecycle/index.js');
    return createLlmCoordinator(registry);
  },
  createVectorCoordinator: async (registry: PluginRegistryLike) => {
    const { createVectorCoordinator } = await import('../lifecycle/index.js');
    return createVectorCoordinator(registry);
  },
  createEmbeddingCoordinator: async (registry: PluginRegistryLike) => {
    const { createEmbeddingCoordinator } = await import('../lifecycle/index.js');
    return createEmbeddingCoordinator(registry);
  },
  createRealtimeSession: async (registry: PluginRegistryLike, spec: any) => {
    const { createRealtimeSession } = await import('../realtime/index.js');
    return createRealtimeSession(registry as any, spec as any);
  },
  closeLogger: async () => {
    const { closeLogger } = await import('../lifecycle/index.js');
    return closeLogger();
  }
};

function resolvePluginsPathWithConfig(pluginsPath: string): string {
  const pathsConfig = getAdapterPathsConfig();
  return resolveEffectivePluginsPath({
    pluginsPath,
    configuredPluginsPath: pathsConfig?.paths.plugins
  });
}

function parseApiKeyEntriesFromEnv(env: NodeJS.ProcessEnv): Array<{ id: string; token?: string; sha256?: string }> {
  const raw = readTrimmedStringProperty(env, 'LLM_ADAPTER_API_KEYS');
  if (!raw) return [];

  const entries = raw
    .split(',')
    .map((v) => String(v).trim())
    .filter(Boolean);

  const keys: Array<{ id: string; token?: string; sha256?: string }> = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const match = entry.match(/^([^:=]{1,128})[:=](.+)$/);
    const id = match ? match[1].trim() : `key_${i + 1}`;
    const value = match ? match[2].trim() : entry.trim();

    if (/^sha256:/i.test(value) || /^[0-9a-f]{64}$/i.test(value)) {
      keys.push({ id, sha256: value });
    } else {
      keys.push({ id, token: value });
    }
  }

  return keys;
}

function resolveAuthConfig(optionsAuth: unknown, authDefaults: unknown): AuthConfig {
  const candidate: any = optionsAuth ?? authDefaults;

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid auth config');
  }

  if ('enabled' in candidate) {
    throw new Error('auth.enabled is no longer supported; use auth.mode');
  }
  if ('allowApiKeyHeader' in candidate) {
    throw new Error('allowApiKeyHeader is no longer supported; use allowHeader');
  }
  if (!candidate.mode) {
    throw new Error('Auth mode is required');
  }
  const mode = String(candidate.mode);
  if (mode === 'none') return { mode: 'none' };

  if (mode === 'apiKey') {
    const keys =
      Array.isArray(candidate.keys) && candidate.keys.length > 0
        ? candidate.keys
        : parseApiKeyEntriesFromEnv(process.env);
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('apiKey auth requires at least one key (set LLM_ADAPTER_API_KEYS or auth.keys)');
    }

    return {
      mode: 'apiKey',
      allowBearer: candidate.allowBearer,
      allowHeader: candidate.allowHeader,
      headerName: candidate.headerName,
      realm: candidate.realm,
      keys
    } as any;
  }

  if (mode === 'jwt') {
    return { ...candidate, mode: 'jwt' } as any;
  }

  if (mode === 'proxySigned') {
    return { ...candidate, mode: 'proxySigned' } as any;
  }

  throw new Error(`Unsupported auth mode: ${mode}`);
}

export function createServerHandlerWithDefaults(
  options: ServerOptions = {}
): http.RequestListener {
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

export async function createServer(options: ServerOptions = {}): Promise<RunningServer> {
  const deps: ServerDependencies = { ...defaultDependencies, ...options.deps };
  const serverDefaults = (deps.getDefaults ?? getDefaults)().server;
  const authDefaults = serverDefaults.auth ?? { mode: 'none' };
  const rateLimitDefaults = serverDefaults.rateLimit ?? {};
  const corsDefaults = serverDefaults.cors ?? {};
  const policyDefaults = (serverDefaults as any).policy ?? {};
  const authConfig = resolveAuthConfig(options.auth, authDefaults) as any;
  const rateLimitConfig = { ...rateLimitDefaults, ...options.rateLimit };
  const corsConfig = { ...corsDefaults, ...options.cors };
  const policyConfig =
    options.policy && typeof options.policy === 'object'
      ? (deepMerge(policyDefaults as any, options.policy as any) as any)
      : policyDefaults;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const pluginsPath = resolvePluginsPathWithConfig(options.pluginsPath ?? './plugins');
  const enabledExtensions = options.extensions?.enabled ?? serverDefaults.extensions?.enabled ?? [];

  const registry =
    options.registry ?? (await deps.createRegistry(pluginsPath));
  if (typeof (registry as any).loadAll === 'function') {
    await (registry as any).loadAll();
  }

  // Optional: fail-fast plugin validation (opt-in). Useful for long-lived servers and live tests.
  if (String(process.env.LLM_ADAPTER_VALIDATE_PLUGINS || '').trim() === '1') {
    const registryAny = registry as any;
    if (registryAny && typeof registryAny.validateAll === 'function') {
      const validatedKey = Symbol.for('llm_adapter_plugins_validated');
      if (registryAny[validatedKey] !== true) {
        await registryAny.validateAll();
        registryAny[validatedKey] = true;
      }
    }
  }

  const coreHandler = createServerHandler({
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
      auth: authConfig,
      rateLimit: rateLimitConfig,
      cors: corsConfig,
      policy: policyConfig,
      securityHeadersEnabled:
        options.securityHeadersEnabled ?? serverDefaults.securityHeadersEnabled
    }
  });

  let extensionsHandleHttp: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>) | undefined;
  const handler: http.RequestListener = async (req, res) => {
    if (extensionsHandleHttp) {
      try {
        const handled = await extensionsHandleHttp(req, res);
        if (handled) return;
      } catch (error: any) {
        try {
          const { mapErrorToHttp } = await import('../transport/index.js');
          const mapped = mapErrorToHttp(error);
          if (!res.headersSent) {
            const extraHeaders = (error as any)?.headers;
            if (extraHeaders && typeof extraHeaders === 'object') {
              for (const [key, value] of Object.entries(extraHeaders)) {
                try { res.setHeader(key, value as any); } catch {}
              }
            }
            res.setHeader('content-type', 'application/json');
            res.statusCode = mapped.status;
          }
          if (!res.writableEnded) {
            res.end(JSON.stringify(mapped.body));
          }
        } catch {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
          }
          if (!res.writableEnded) {
            res.end(JSON.stringify({ type: 'error', error: { message: 'Server error', code: 'internal' } }));
          }
        }
        return;
      }
    }
    await coreHandler(req, res);
  };

  const server = http.createServer(handler);

  // Transport hardening defaults (safe by default; configurable for enterprise deployments).
  const httpHeadersTimeoutMs =
    options.httpHeadersTimeoutMs ?? (serverDefaults as any).httpHeadersTimeoutMs ?? 20000;
  const httpRequestTimeoutMs =
    options.httpRequestTimeoutMs ?? (serverDefaults as any).httpRequestTimeoutMs ?? 0;
  const httpKeepAliveTimeoutMs =
    options.httpKeepAliveTimeoutMs ?? (serverDefaults as any).httpKeepAliveTimeoutMs ?? 5000;
  const httpMaxHeadersCount =
    options.httpMaxHeadersCount ?? (serverDefaults as any).httpMaxHeadersCount ?? 1000;

  if (Number.isFinite(Number(httpHeadersTimeoutMs))) {
    (server as any).headersTimeout = Math.max(0, Number(httpHeadersTimeoutMs));
  }
  if (Number.isFinite(Number(httpRequestTimeoutMs))) {
    (server as any).requestTimeout = Math.max(0, Number(httpRequestTimeoutMs));
  }
  if (Number.isFinite(Number(httpKeepAliveTimeoutMs))) {
    (server as any).keepAliveTimeout = Math.max(0, Number(httpKeepAliveTimeoutMs));
  }
  if (Number.isFinite(Number(httpMaxHeadersCount))) {
    (server as any).maxHeadersCount = Math.max(0, Math.floor(Number(httpMaxHeadersCount)));
  }

  // Avoid unhandled parse errors taking down the process; respond with a generic 400 and close.
  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      try {
        socket.destroy();
      } catch {}
    }
  });
  const { attachUpgradeRouter } = await import('./internal/transport/upgrade-router.js');
  const upgradeRouter = attachUpgradeRouter(server);

  const realtimeEnabled = options.realtime?.enabled === true;
  const realtimeWsPath = options.realtime?.wsPath ?? '/realtime/ws';
  const realtimeMaxWsMessageBytes = options.realtime?.maxWsMessageBytes ?? 262144;
  const realtimeWsIdleTimeoutMs = options.realtime?.wsIdleTimeoutMs ?? 60000;
  const realtimeOpenHandshakeTimeoutMs = options.realtime?.openHandshakeTimeoutMs ?? 60000;
  const realtimeMaxConcurrentSessions = options.realtime?.maxConcurrentSessions ?? 20;
  const realtimeMaxAudioBytesPerSecond = options.realtime?.maxAudioBytesPerSecond ?? 256000;
  const realtimeMaxSessionDurationMs = options.realtime?.maxSessionDurationMs ?? 3600000;

  let closeRealtimeWs: (() => Promise<void>) | undefined;
  if (realtimeEnabled) {
    if (!authConfig || authConfig.mode === 'none') {
      throw new Error('Realtime WS requires server auth to be enabled');
    }

    const { createAuthenticator } = await import('../auth/index.js');
    const { createRateLimiter } = await import('./internal/security/rate-limiter.js');
    const rateLimiter = createRateLimiter(rateLimitConfig as any);
    const authenticator = createAuthenticator(authConfig as any);

    const { attachRealtimeWsServer } = await import('./internal/realtime/ws.js');
    const realtime = await attachRealtimeWsServer({
      server,
      upgradeRouter,
      registry,
      authorizeUpgrade: async (req) => {
        const ctx = await authenticator.authenticate(req);
        if (options.authorize) {
          const allowed = await (options.authorize as any)(ctx, req);
          if (!allowed) {
            const error = new Error('Forbidden');
            (error as any).statusCode = 403;
            (error as any).code = 'forbidden';
            throw error;
          }
        }
        const authIdentity = ctx.subject ?? 'unknown';
        if (rateLimitConfig.enabled) {
          rateLimiter.check(authIdentity);
        }
      },
      createSession: async ({ registry, spec }) => {
        if (!deps.createRealtimeSession) {
          throw new Error('Realtime session factory unavailable');
        }
        return deps.createRealtimeSession(registry, spec);
      },
      config: {
        path: realtimeWsPath,
        maxMessageBytes: realtimeMaxWsMessageBytes,
        idleTimeoutMs: realtimeWsIdleTimeoutMs,
        openHandshakeTimeoutMs: realtimeOpenHandshakeTimeoutMs,
        maxConcurrentSessions: realtimeMaxConcurrentSessions,
        maxAudioBytesPerSecond: realtimeMaxAudioBytesPerSecond,
        maxSessionDurationMs: realtimeMaxSessionDurationMs
      }
    });
    closeRealtimeWs = realtime.close;
  }

  let closeExtensions: (() => Promise<void>) | undefined;
  if (enabledExtensions.length > 0) {
    const { loadServerExtensions } = await import('./internal/extensions/host.js');
    const extensionsHttpConfig = {
      maxRequestBytes: options.maxRequestBytes ?? serverDefaults.maxRequestBytes,
      bodyReadTimeoutMs: options.bodyReadTimeoutMs ?? serverDefaults.bodyReadTimeoutMs,
      auth: authConfig,
      rateLimit: rateLimitConfig,
      cors: corsConfig,
      policy: policyConfig,
      securityHeadersEnabled:
        options.securityHeadersEnabled ?? serverDefaults.securityHeadersEnabled,
      extensions: serverDefaults.extensions,
      authorize: options.authorize
    };
    const host = await loadServerExtensions({
      enabled: enabledExtensions,
      server,
      registry,
      pluginsPath,
      upgradeRouter,
      httpConfig: extensionsHttpConfig
    });
    extensionsHandleHttp = host.handleHttp;
    closeExtensions = host.close;
  }

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
        (async () => {
          try {
            await closeExtensions?.();
          } catch {}
          try {
            await closeRealtimeWs?.();
          } catch {}
          try {
            upgradeRouter.close();
          } catch {}
          server.close(async (error) => {
            if (error) reject(error);
            else {
              await deps.closeLogger();
              resolve();
            }
          });
        })().catch(reject);
      })
  };
}

export { createAudioRateLimiter } from './internal/transport/audio-rate-limiter.js';

export type { LLMCallSpec, LLMStreamEvent };
