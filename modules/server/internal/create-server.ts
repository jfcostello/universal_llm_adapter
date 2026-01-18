import http from 'http';
import type { AddressInfo } from 'net';

import { deepMerge, getDefaults } from '../../../kernel/index.js';

import type { ServerDependencies, ServerOptions, RunningServer } from './server-types.js';
import { createServerHandler } from './handler.js';
import { resolveAuthConfig } from './auth-config.js';
import { defaultDependencies } from './default-dependencies.js';
import { resolvePluginsPathWithConfig } from './plugins-path.js';

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

  const registry = options.registry ?? (await deps.createRegistry(pluginsPath));
  if (typeof (registry as any).loadAll === 'function') {
    await (registry as any).loadAll();
  }

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
          const { mapErrorToHttp } = await import('../../transport/index.js');
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

  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      try {
        socket.destroy();
      } catch {}
    }
  });
  const { attachUpgradeRouter } = await import('./transport/upgrade-router.js');
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

    const { createAuthenticator } = await import('../../auth/index.js');
    const { createRateLimiter } = await import('./security/rate-limiter.js');
    const rateLimiter = createRateLimiter(rateLimitConfig as any);
    const authenticator = createAuthenticator(authConfig as any);

    const { attachRealtimeWsServer } = await import('./realtime/ws.js');
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
    const { loadServerExtensions } = await import('./extensions/host.js');
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
