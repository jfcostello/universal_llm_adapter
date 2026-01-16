import type http from 'http';
import fs from 'fs';
import path from 'path';
import { readJsonBody } from './transport/body-parser.js';
import { writeSseEvent, writeSseEventWithBackpressure } from './streaming/sse.js';
import {
  assertValidSpec,
  assertValidVectorSpec,
  assertValidEmbeddingSpec
} from './transport/spec-validator.js';
import { createLimiter } from './transport/limiter.js';
import { mapErrorToHttp } from './transport/error-mapper.js';
import { applyCors } from './security/cors.js';
import { applySecurityHeaders } from './security/security-headers.js';
import { createRateLimiter, getClientIp } from './security/rate-limiter.js';
import {
  assertLlmSpecAllowedByPolicy,
  normalizeServerPolicy,
  type ServerPolicyConfig
} from './security/policy.js';
import { monotonicElapsedMs, monotonicNowNs } from '../../shared/index.js';
import {
  runWithCoordinatorLifecycle,
  streamWithCoordinatorLifecycle
} from '../../lifecycle/index.js';
import { createAuthenticator, type AuthContext, type AuthErrorLike } from '../../auth/index.js';
import type {
  EmbeddingCallSpec,
  LLMCallSpec,
  LLMStreamEvent,
  VectorCallSpec,
  VectorStreamEvent
} from '../../../kernel/index.js';
import type { PluginRegistryLike } from '../../lifecycle/index.js';
import type { ServerDependencies } from '../index.js';

interface HandlerOptions {
  registry: PluginRegistryLike;
  pluginsPath: string;
  batchId?: string;
  closeLoggerAfterRequest: boolean;
  deps: ServerDependencies;
  lifecycle?: {
    runWithCoordinatorLifecycle?: typeof runWithCoordinatorLifecycle;
    streamWithCoordinatorLifecycle?: typeof streamWithCoordinatorLifecycle;
  };
  config: {
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
  };
  authorize?: (ctx: AuthContext, req: http.IncomingMessage) => boolean | Promise<boolean>;
}

function writeJson(res: http.ServerResponse, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createServerHandler(options: HandlerOptions): http.RequestListener {
  const { registry, pluginsPath, batchId, closeLoggerAfterRequest, deps, config, authorize, lifecycle } = options;

  const authenticator = createAuthenticator(config.auth ?? { mode: 'none' });
  const policy = normalizeServerPolicy(config.policy);

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

  function applyErrorHeaders(res: http.ServerResponse, error: any) {
    const headers = (error as AuthErrorLike | undefined)?.headers;
    if (!headers || typeof headers !== 'object') return;
    if (res.headersSent) return;
    for (const [key, value] of Object.entries(headers)) {
      try {
        res.setHeader(key, value);
      } catch {
        // ignore invalid header sets
      }
    }
  }

  function makeForbiddenError() {
    const error = new Error('Forbidden');
    (error as any).statusCode = 403;
    (error as any).code = 'forbidden';
    return error;
  }

  async function assertAuthorizedAndRateLimited(req: http.IncomingMessage): Promise<AuthContext> {
    const authContext = await authenticator.authenticate(req);
    if (authorize) {
      const allowed = await authorize(authContext, req);
      if (!allowed) {
        throw makeForbiddenError();
      }
    }
    if (config.rateLimit?.enabled) {
      const key =
        authContext.subject ??
        getClientIp(req, Boolean(config.rateLimit?.trustProxyHeaders)) ??
        'unknown';
      rateLimiter.check(key);
    }
    return authContext;
  }

  function assertJsonContentType(req: http.IncomingMessage) {
    const contentType = req.headers['content-type'];
    if (contentType && !String(contentType).includes('application/json')) {
      const error = new Error('Unsupported Content-Type');
      (error as any).statusCode = 415;
      (error as any).code = 'unsupported_media_type';
      throw error;
    }
  }

  async function handleSseStream<E>(options: {
    iterator: AsyncIterator<E>;
    res: http.ServerResponse;
    startTimeMs: number;
    requestTimeoutMs: number;
    idleTimeoutMs: number;
  }): Promise<void> {
    const { iterator, res, startTimeMs, requestTimeoutMs, idleTimeoutMs } = options;

    let lastEventAt = Date.now();
    let finished = false;

    const sendTimeoutAndClose = async (code: string, message: string) => {
      finished = true;
      await writeSseEventWithBackpressure(res, {
        type: 'error',
        error: { message, code }
      });
      res.end();
      // Best-effort: do not await iterator.return() since it can hang if the
      // underlying generator is blocked. Still swallow sync throws and async rejections.
      try {
        const result = iterator.return?.(undefined);
        if (result && typeof (result as any).catch === 'function') {
          (result as any).catch(() => {});
        }
      } catch {
        // ignore
      }
    };

    while (!finished) {
      const now = Date.now();
      const remainingIdleMs =
        idleTimeoutMs > 0
          ? Math.max(0, idleTimeoutMs - (now - lastEventAt))
          : Number.POSITIVE_INFINITY;
      const remainingRequestMs =
        requestTimeoutMs > 0
          ? Math.max(0, requestTimeoutMs - (now - startTimeMs))
          : Number.POSITIVE_INFINITY;
      const waitMs = Math.min(remainingIdleMs, remainingRequestMs);

      const timeoutType = remainingRequestMs <= remainingIdleMs ? 'request' : 'idle';

      let timeoutId: NodeJS.Timeout | undefined;
      const raced: any =
        waitMs === Number.POSITIVE_INFINITY
          ? { result: await iterator.next() }
          : await (async () => {
              try {
                return await Promise.race([
                  iterator.next().then(result => ({ result })),
                  new Promise(resolve => {
                    timeoutId = setTimeout(() => resolve({ timeout: true }), waitMs);
                  })
                ]);
              } finally {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
              }
            })();

      if (raced.timeout) {
        if (timeoutType === 'request') {
          await sendTimeoutAndClose('timeout', 'Request timed out');
        } else {
          await sendTimeoutAndClose('stream_idle_timeout', 'Stream idle timeout');
        }
        break;
      }

      const { value, done } = raced.result as IteratorResult<E>;
      if (done) {
        finished = true;
        break;
      }

      lastEventAt = Date.now();
      await writeSseEventWithBackpressure(res, value);
    }
  }

  return async (req, res) => {
    applySecurityHeaders(res, config.securityHeadersEnabled ?? true);
    if (applyCors(req, res, config.cors)) {
      return;
    }

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/health') {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/ready') {
      const resolvedPluginsPath = path.isAbsolute(pluginsPath)
        ? pluginsPath
        : path.resolve(process.cwd(), pluginsPath);
      const ready = fs.existsSync(resolvedPluginsPath);
      if (!ready) {
        writeJson(res, 503, { ok: false });
        return;
      }
      writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/extensions/list') {
      try {
        await assertAuthorizedAndRateLimited(req);
        const { listExtensions } = await import('../../extensions/index.js');
        const results = listExtensions().map(item => ({
          name: item.name,
          kind: item.kind,
          root: item.root
        }));
        writeJson(res, 200, { type: 'response', data: results });
      } catch (error: any) {
        applyErrorHeaders(res, error);
        const mapped = mapErrorToHttp(error);
        writeJson(res, mapped.status, mapped.body);
      }
      return;
    }

    if (method !== 'POST') {
      writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed' } });
      return;
    }

    try {
      if (url === '/realtime/webrtc/client-secret') {
        if (!config.auth || config.auth.mode === 'none') {
          const error = new Error('Realtime client-secret endpoint requires server auth to be enabled');
          (error as any).statusCode = 501;
          (error as any).code = 'not_implemented';
          throw error;
        }

        await assertAuthorizedAndRateLimited(req);
        assertJsonContentType(req);

        const body = await readJsonBody(req, {
          maxBytes: config.maxRequestBytes,
          timeoutMs: config.bodyReadTimeoutMs
        });

        const providerId = String(body?.provider ?? '').trim();
        const model = body?.model !== undefined ? String(body.model) : undefined;
        const systemPrompt = body?.systemPrompt !== undefined ? String(body.systemPrompt) : undefined;
        const expiresAfterSecondsRaw = body?.expiresAfterSeconds;
        const expiresAfterSeconds =
          expiresAfterSecondsRaw === undefined || expiresAfterSecondsRaw === null
            ? undefined
            : Number(expiresAfterSecondsRaw);

        const MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS = 30;
        const MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS = 600;

        if (!providerId) {
          const error = new Error('Missing provider');
          (error as any).statusCode = 400;
          (error as any).code = 'validation_error';
          throw error;
        }

        if (expiresAfterSeconds !== undefined) {
          if (!Number.isFinite(expiresAfterSeconds)) {
            const error = new Error('Invalid expiresAfterSeconds');
            (error as any).statusCode = 400;
            (error as any).code = 'validation_error';
            throw error;
          }

          if (!Number.isInteger(expiresAfterSeconds)) {
            const error = new Error('expiresAfterSeconds must be an integer');
            (error as any).statusCode = 400;
            (error as any).code = 'validation_error';
            throw error;
          }

          if (
            expiresAfterSeconds < MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS ||
            expiresAfterSeconds > MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS
          ) {
            const error = new Error(
              `expiresAfterSeconds must be between ${MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS} and ${MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS}`
            );
            (error as any).statusCode = 400;
            (error as any).code = 'validation_error';
            throw error;
          }
        }

        const reg = registry as any;
        if (typeof reg.getRealtimeProvider !== 'function' || typeof reg.getRealtimeCompat !== 'function') {
          const error = new Error('Registry does not support realtime client-secret minting');
          (error as any).statusCode = 501;
          (error as any).code = 'not_implemented';
          throw error;
        }

        const provider = await reg.getRealtimeProvider(providerId);
        const compatKind = provider?.compat;
        if (!compatKind) {
          const error = new Error(`Realtime client-secret minting not supported for provider '${providerId}'`);
          (error as any).statusCode = 501;
          (error as any).code = 'not_implemented';
          throw error;
        }

        const compat = await reg.getRealtimeCompat(compatKind);
        if (!compat || typeof compat.mintClientSecret !== 'function') {
          const error = new Error(`Realtime client-secret minting not supported for provider '${providerId}'`);
          (error as any).statusCode = 501;
          (error as any).code = 'not_implemented';
          throw error;
        }

        const result = await compat.mintClientSecret({
          provider,
          spec: {
            provider: providerId,
            ...(model ? { model } : {}),
            ...(systemPrompt ? { systemPrompt } : {}),
            transport: { type: 'webrtc' }
          },
          ...(expiresAfterSeconds !== undefined ? { expiresAfterSeconds } : {})
        });

        writeJson(res, 200, {
          clientSecret: String(result?.clientSecret ?? ''),
          ...(result?.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {})
        });
        return;
      }

      if (url === '/run') {
        await assertAuthorizedAndRateLimited(req);

        assertJsonContentType(req);

        const abortController = new AbortController();
        req.once('close', () => abortController.abort());
        const release = await llmRunLimiter.acquire(abortController.signal);
        let releaseDeferred = false;

        try {
          const spec = (await readJsonBody(req, {
            maxBytes: config.maxRequestBytes,
            timeoutMs: config.bodyReadTimeoutMs
          })) as LLMCallSpec;

          assertValidSpec(spec);
          assertLlmSpecAllowedByPolicy(spec, policy);
          const correlationId = spec.metadata?.correlationId as string | undefined;
          const { getLogger } = await import('../../logging/index.js');
          const logger = getLogger(correlationId);
          const startTimeMonoNs = monotonicNowNs();
          const callPromise = runWithCoordinatorLifecycleFn<LLMCallSpec, any, any, any>({
            spec,
            pluginsPath,
            registry,
            batchId,
            closeLoggerAfter: closeLoggerAfterRequest,
            deps,
            run: (coordinator: any, s) => coordinator.run(s)
          });

          if (config.requestTimeoutMs > 0) {
            let timedOut = false;
            let timeoutId: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                const error = new Error('Request timed out');
                (error as any).statusCode = 504;
                (error as any).code = 'timeout';
                reject(error);
              }, config.requestTimeoutMs);
            });

            try {
              const response = await Promise.race([callPromise, timeoutPromise]);
              writeJson(res, 200, { type: 'response', data: response });
              logger.info('HTTP /run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
            } catch (error: any) {
              if (timedOut) {
                const mapped = mapErrorToHttp(error);
                writeJson(res, mapped.status, mapped.body);
                logger.warning('HTTP /run timed out', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
                releaseDeferred = true;
                callPromise
                  .catch(err => logger.error('Coordinator finished after timeout', { error: err }))
                  .finally(() => release());
                return;
              }

              const mapped = mapErrorToHttp(error);
              writeJson(res, mapped.status, mapped.body);
              logger.error('HTTP /run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
            }

            return;
          }

          try {
            const response = await callPromise;
            writeJson(res, 200, { type: 'response', data: response });
            logger.info('HTTP /run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
          } catch (error: any) {
            const mapped = mapErrorToHttp(error);
            writeJson(res, mapped.status, mapped.body);
            logger.error('HTTP /run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
          }
        } catch (error: any) {
          applyErrorHeaders(res, error);
          const mapped = mapErrorToHttp(error);
          writeJson(res, mapped.status, mapped.body);
        } finally {
          if (!releaseDeferred) release();
        }

        return;
      }

      if (url === '/stream') {
        await assertAuthorizedAndRateLimited(req);

        assertJsonContentType(req);

        const abortController = new AbortController();
        req.once('close', () => abortController.abort());
        const release = await llmStreamLimiter.acquire(abortController.signal);
        try {
          const spec = (await readJsonBody(req, {
            maxBytes: config.maxRequestBytes,
            timeoutMs: config.bodyReadTimeoutMs
          })) as LLMCallSpec;

          assertValidSpec(spec);
          assertLlmSpecAllowedByPolicy(spec, policy);
          const correlationId = spec.metadata?.correlationId as string | undefined;
          const { getLogger } = await import('../../logging/index.js');
          const logger = getLogger(correlationId);
          const startTimeMs = Date.now();
          const startTimeMonoNs = monotonicNowNs();
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          (res as any).flushHeaders?.();

          const lifecycleStream = streamWithCoordinatorLifecycleFn<
            LLMCallSpec,
            any,
            any,
            LLMStreamEvent
          >({
            spec,
            pluginsPath,
            registry,
            batchId,
            closeLoggerAfter: closeLoggerAfterRequest,
            deps,
            stream: (coordinator: any, s) => coordinator.runStream(s)
          });

          const iterator = lifecycleStream[Symbol.asyncIterator]();
          const idleTimeoutMs = config.streamIdleTimeoutMs;
          const requestTimeoutMs = config.requestTimeoutMs;

          try {
            await handleSseStream({
              iterator,
              res,
              startTimeMs,
              requestTimeoutMs,
              idleTimeoutMs
            });
          } catch (error: any) {
            const mapped = mapErrorToHttp(error);
            await writeSseEventWithBackpressure(res, mapped.body);
            res.end();
          }

          if (!res.writableEnded) {
            res.end();
          }

          logger.info('HTTP /stream completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
        } finally {
          release();
        }

        return;
      }

      if (url === '/vector/run') {
        await assertAuthorizedAndRateLimited(req);

        assertJsonContentType(req);

        const abortController = new AbortController();
        req.once('close', () => abortController.abort());
        const release = await vectorRunLimiter.acquire(abortController.signal);
        let releaseDeferred = false;

        try {
          const spec = (await readJsonBody(req, {
            maxBytes: config.maxRequestBytes,
            timeoutMs: config.bodyReadTimeoutMs
          })) as VectorCallSpec;

          assertValidVectorSpec(spec);

          const correlationId = spec.metadata?.correlationId as string | undefined;
          const { getVectorLogger } = await import('../../logging/index.js');
          const logger = getVectorLogger(correlationId);
          const startTimeMonoNs = monotonicNowNs();
          const createVectorCoordinator = (deps as any).createVectorCoordinator as
            | ServerDependencies['createVectorCoordinator']
            | undefined;

          if (!createVectorCoordinator) {
            const error = new Error('Vector coordinator not available');
            (error as any).statusCode = 501;
            (error as any).code = 'not_implemented';
            throw error;
          }

          const callPromise = runWithCoordinatorLifecycleFn<VectorCallSpec, any, any, any>({
            spec,
            pluginsPath,
            registry,
            batchId,
            closeLoggerAfter: closeLoggerAfterRequest,
            deps: { ...deps, createCoordinator: createVectorCoordinator },
            run: (coordinator: any, s) => coordinator.execute(s)
          });

          if (config.requestTimeoutMs > 0) {
            let timedOut = false;
            let timeoutId: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                const error = new Error('Request timed out');
                (error as any).statusCode = 504;
                (error as any).code = 'timeout';
                reject(error);
              }, config.requestTimeoutMs);
            });

            try {
              const response = await Promise.race([callPromise, timeoutPromise]);
              writeJson(res, 200, { type: 'response', data: response });
              logger.info('HTTP /vector/run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
            } catch (error: any) {
              if (timedOut) {
                const mapped = mapErrorToHttp(error);
                writeJson(res, mapped.status, mapped.body);
                logger.warning('HTTP /vector/run timed out', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
                releaseDeferred = true;
                callPromise
                  .catch(err => logger.error('Coordinator finished after timeout', { error: err }))
                  .finally(() => release());
                return;
              }

              const mapped = mapErrorToHttp(error);
              writeJson(res, mapped.status, mapped.body);
              logger.error('HTTP /vector/run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
            }

            return;
          }

          try {
            const response = await callPromise;
            writeJson(res, 200, { type: 'response', data: response });
            logger.info('HTTP /vector/run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
          } catch (error: any) {
            const mapped = mapErrorToHttp(error);
            writeJson(res, mapped.status, mapped.body);
            logger.error('HTTP /vector/run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
          }
        } catch (error: any) {
          applyErrorHeaders(res, error);
          const mapped = mapErrorToHttp(error);
          writeJson(res, mapped.status, mapped.body);
        } finally {
          if (!releaseDeferred) release();
        }

        return;
      }

      if (url === '/vector/stream') {
        await assertAuthorizedAndRateLimited(req);

        assertJsonContentType(req);

        const abortController = new AbortController();
        req.once('close', () => abortController.abort());
        const release = await vectorStreamLimiter.acquire(abortController.signal);
        try {
          const spec = (await readJsonBody(req, {
            maxBytes: config.maxRequestBytes,
            timeoutMs: config.bodyReadTimeoutMs
          })) as VectorCallSpec;

          assertValidVectorSpec(spec);

          const correlationId = spec.metadata?.correlationId as string | undefined;
          const { getVectorLogger } = await import('../../logging/index.js');
          const logger = getVectorLogger(correlationId);
          const startTimeMs = Date.now();
          const startTimeMonoNs = monotonicNowNs();
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          (res as any).flushHeaders?.();

          const createVectorCoordinator = (deps as any).createVectorCoordinator as
            | ServerDependencies['createVectorCoordinator']
            | undefined;

          if (!createVectorCoordinator) {
            const error = new Error('Vector coordinator not available');
            (error as any).statusCode = 501;
            (error as any).code = 'not_implemented';
            throw error;
          }

          const lifecycleStream = streamWithCoordinatorLifecycleFn<
            VectorCallSpec,
            any,
            any,
            VectorStreamEvent
          >({
            spec,
            pluginsPath,
            registry,
            batchId,
            closeLoggerAfter: closeLoggerAfterRequest,
            deps: { ...deps, createCoordinator: createVectorCoordinator },
            stream: (coordinator: any, s) => coordinator.executeStream(s)
          });

          const iterator = lifecycleStream[Symbol.asyncIterator]();

          try {
            await handleSseStream({
              iterator,
              res,
              startTimeMs,
              requestTimeoutMs: config.requestTimeoutMs,
              idleTimeoutMs: config.streamIdleTimeoutMs
            });
          } catch (error: any) {
            const mapped = mapErrorToHttp(error);
            await writeSseEventWithBackpressure(res, mapped.body);
            res.end();
          }

          if (!res.writableEnded) {
            res.end();
          }

          logger.info('HTTP /vector/stream completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
        } finally {
          release();
        }

        return;
      }

      if (url === '/embeddings/run') {
        await assertAuthorizedAndRateLimited(req);

        assertJsonContentType(req);

        const abortController = new AbortController();
        req.once('close', () => abortController.abort());
        const release = await embeddingRunLimiter.acquire(abortController.signal);
        let releaseDeferred = false;

        try {
          const spec = (await readJsonBody(req, {
            maxBytes: config.maxRequestBytes,
            timeoutMs: config.bodyReadTimeoutMs
          })) as EmbeddingCallSpec;

          assertValidEmbeddingSpec(spec);

          const correlationId = spec.metadata?.correlationId as string | undefined;
          const { getEmbeddingLogger } = await import('../../logging/index.js');
          const logger = getEmbeddingLogger(correlationId);
          const startTimeMonoNs = monotonicNowNs();
          const createEmbeddingCoordinator = (deps as any).createEmbeddingCoordinator as
            | ServerDependencies['createEmbeddingCoordinator']
            | undefined;

          if (!createEmbeddingCoordinator) {
            const error = new Error('Embedding coordinator not available');
            (error as any).statusCode = 501;
            (error as any).code = 'not_implemented';
            throw error;
          }

          const callPromise = runWithCoordinatorLifecycleFn<EmbeddingCallSpec, any, any, any>({
            spec,
            pluginsPath,
            registry,
            batchId,
            closeLoggerAfter: closeLoggerAfterRequest,
            deps: { ...deps, createCoordinator: createEmbeddingCoordinator },
            run: (coordinator: any, s) => coordinator.execute(s)
          });

          if (config.requestTimeoutMs > 0) {
            let timedOut = false;
            let timeoutId: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                const error = new Error('Request timed out');
                (error as any).statusCode = 504;
                (error as any).code = 'timeout';
                reject(error);
              }, config.requestTimeoutMs);
            });

            try {
              const response = await Promise.race([callPromise, timeoutPromise]);
              writeJson(res, 200, { type: 'response', data: response });
              logger.info('HTTP /embeddings/run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
            } catch (error: any) {
              if (timedOut) {
                const mapped = mapErrorToHttp(error);
                writeJson(res, mapped.status, mapped.body);
                logger.warning('HTTP /embeddings/run timed out', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
                releaseDeferred = true;
                callPromise
                  .catch(err => logger.error('Coordinator finished after timeout', { error: err }))
                  .finally(() => release());
                return;
              }

              const mapped = mapErrorToHttp(error);
              writeJson(res, mapped.status, mapped.body);
              logger.error('HTTP /embeddings/run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
            }

            return;
          }

          try {
            const response = await callPromise;
            writeJson(res, 200, { type: 'response', data: response });
            logger.info('HTTP /embeddings/run completed', { durationMs: monotonicElapsedMs(startTimeMonoNs) });
          } catch (error: any) {
            const mapped = mapErrorToHttp(error);
            writeJson(res, mapped.status, mapped.body);
            logger.error('HTTP /embeddings/run failed', { durationMs: monotonicElapsedMs(startTimeMonoNs), error });
          }
        } catch (error: any) {
          applyErrorHeaders(res, error);
          const mapped = mapErrorToHttp(error);
          writeJson(res, mapped.status, mapped.body);
        } finally {
          if (!releaseDeferred) release();
        }

        return;
      }

      writeJson(res, 404, { type: 'error', error: { message: 'Not found' } });
    } catch (error: any) {
      applyErrorHeaders(res, error);
      const mapped = mapErrorToHttp(error);

      if ((req.url === '/stream' || req.url === '/vector/stream') && res.headersSent) {
        writeSseEvent(res, mapped.body);
        res.end();
        return;
      }

      writeJson(res, mapped.status, mapped.body);
    }
  };
}
