import type http from 'http';
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
import { assertAuthorized } from './security/auth.js';
import { createRateLimiter, getClientIp } from './security/rate-limiter.js';
import {
  runWithCoordinatorLifecycle,
  streamWithCoordinatorLifecycle
} from '../../coordinator-lifecycle/index.js';
import type { LLMCallSpec, LLMStreamEvent } from '../../../core/types.js';
import type { VectorCallSpec, VectorStreamEvent } from '../../../core/vector-spec-types.js';
import type { EmbeddingCallSpec } from '../../../core/embedding-spec-types.js';
import type { PluginRegistryLike } from '../../coordinator-lifecycle/index.js';
import type { ServerDependencies } from '../index.js';
import { getEmbeddingLogger, getLogger, getVectorLogger } from '../../../core/logging.js';
import { runWithLiveTestContext } from '../../testing/live-test-context.js';

interface HandlerOptions {
  registry: PluginRegistryLike;
  pluginsPath: string;
  batchId?: string;
  closeLoggerAfterRequest: boolean;
  deps: ServerDependencies;
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
  };
  authorize?: (req: http.IncomingMessage) => boolean | Promise<boolean>;
}

function writeJson(res: http.ServerResponse, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createServerHandler(options: HandlerOptions): http.RequestListener {
  const { registry, pluginsPath, batchId, closeLoggerAfterRequest, deps, config, authorize } = options;

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

  async function assertAuthorizedAndRateLimited(req: http.IncomingMessage): Promise<string | undefined> {
    const authIdentity = await assertAuthorized(req, config.auth ?? { enabled: false }, authorize);
    if (config.rateLimit?.enabled) {
      const key =
        authIdentity ??
        getClientIp(req, Boolean(config.rateLimit?.trustProxyHeaders)) ??
        'unknown';
      rateLimiter.check(key);
    }
    return authIdentity;
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

      const raced: any =
        waitMs === Number.POSITIVE_INFINITY
          ? { result: await iterator.next() }
          : await Promise.race([
              iterator.next().then(result => ({ result })),
              new Promise(resolve => setTimeout(() => resolve({ timeout: true }), waitMs))
            ]);

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

    if (method !== 'POST') {
      writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed' } });
      return;
    }

    try {
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
          const correlationId = spec.metadata?.correlationId as string | undefined;
          const logger = getLogger(correlationId);
          const startTime = Date.now();

          const liveContext = {
            correlationId,
            testFile: (spec.metadata as any)?.testFile as string | undefined,
            testName: (spec.metadata as any)?.testName as string | undefined
          };

          await runWithLiveTestContext(liveContext, async () => {
            const callPromise = runWithCoordinatorLifecycle<LLMCallSpec, any, any, any>({
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
                logger.info('HTTP /run completed', { durationMs: Date.now() - startTime });
              } catch (error: any) {
                if (timedOut) {
                  const mapped = mapErrorToHttp(error);
                  writeJson(res, mapped.status, mapped.body);
                  logger.warning('HTTP /run timed out', { durationMs: Date.now() - startTime });
                  releaseDeferred = true;
                  callPromise
                    .catch(err => logger.error('Coordinator finished after timeout', { error: err }))
                    .finally(() => release());
                  return;
                }

                const mapped = mapErrorToHttp(error);
                writeJson(res, mapped.status, mapped.body);
                logger.error('HTTP /run failed', { durationMs: Date.now() - startTime, error });
              } finally {
                if (timeoutId) clearTimeout(timeoutId);
              }

              return;
            }

            try {
              const response = await callPromise;
              writeJson(res, 200, { type: 'response', data: response });
              logger.info('HTTP /run completed', { durationMs: Date.now() - startTime });
            } catch (error: any) {
              const mapped = mapErrorToHttp(error);
              writeJson(res, mapped.status, mapped.body);
              logger.error('HTTP /run failed', { durationMs: Date.now() - startTime, error });
            }
          });
        } catch (error: any) {
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
          const correlationId = spec.metadata?.correlationId as string | undefined;
          const logger = getLogger(correlationId);
          const startTime = Date.now();

          const liveContext = {
            correlationId,
            testFile: (spec.metadata as any)?.testFile as string | undefined,
            testName: (spec.metadata as any)?.testName as string | undefined
          };

          await runWithLiveTestContext(liveContext, async () => {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            });
            (res as any).flushHeaders?.();

            const lifecycleStream = streamWithCoordinatorLifecycle<
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
                startTimeMs: startTime,
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

            logger.info('HTTP /stream completed', { durationMs: Date.now() - startTime });
          });
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
          const logger = getVectorLogger(correlationId);
          const startTime = Date.now();

          const liveContext = {
            correlationId,
            testFile: (spec.metadata as any)?.testFile as string | undefined,
            testName: (spec.metadata as any)?.testName as string | undefined
          };

          await runWithLiveTestContext(liveContext, async () => {
            const createVectorCoordinator = (deps as any).createVectorCoordinator as
              | ServerDependencies['createVectorCoordinator']
              | undefined;

            if (!createVectorCoordinator) {
              const error = new Error('Vector coordinator not available');
              (error as any).statusCode = 501;
              (error as any).code = 'not_implemented';
              throw error;
            }

            const callPromise = runWithCoordinatorLifecycle<VectorCallSpec, any, any, any>({
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
                logger.info('HTTP /vector/run completed', { durationMs: Date.now() - startTime });
              } catch (error: any) {
                if (timedOut) {
                  const mapped = mapErrorToHttp(error);
                  writeJson(res, mapped.status, mapped.body);
                  logger.warning('HTTP /vector/run timed out', { durationMs: Date.now() - startTime });
                  releaseDeferred = true;
                  callPromise
                    .catch(err => logger.error('Coordinator finished after timeout', { error: err }))
                    .finally(() => release());
                  return;
                }

                const mapped = mapErrorToHttp(error);
                writeJson(res, mapped.status, mapped.body);
                logger.error('HTTP /vector/run failed', { durationMs: Date.now() - startTime, error });
              } finally {
                if (timeoutId) clearTimeout(timeoutId);
              }

              return;
            }

            try {
              const response = await callPromise;
              writeJson(res, 200, { type: 'response', data: response });
              logger.info('HTTP /vector/run completed', { durationMs: Date.now() - startTime });
            } catch (error: any) {
              const mapped = mapErrorToHttp(error);
              writeJson(res, mapped.status, mapped.body);
              logger.error('HTTP /vector/run failed', { durationMs: Date.now() - startTime, error });
            }
          });
        } catch (error: any) {
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
          const logger = getVectorLogger(correlationId);
          const startTime = Date.now();

          const liveContext = {
            correlationId,
            testFile: (spec.metadata as any)?.testFile as string | undefined,
            testName: (spec.metadata as any)?.testName as string | undefined
          };

          await runWithLiveTestContext(liveContext, async () => {
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

            const lifecycleStream = streamWithCoordinatorLifecycle<
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
                startTimeMs: startTime,
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

            logger.info('HTTP /vector/stream completed', { durationMs: Date.now() - startTime });
          });
        } finally {
          release();
        }

        return;
      }

      if (url === '/vector/embeddings/run') {
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
          const logger = getEmbeddingLogger(correlationId);
          const startTime = Date.now();

          const liveContext = {
            correlationId,
            testFile: (spec.metadata as any)?.testFile as string | undefined,
            testName: (spec.metadata as any)?.testName as string | undefined
          };

          await runWithLiveTestContext(liveContext, async () => {
            const createEmbeddingCoordinator = (deps as any).createEmbeddingCoordinator as
              | ServerDependencies['createEmbeddingCoordinator']
              | undefined;

            if (!createEmbeddingCoordinator) {
              const error = new Error('Embedding coordinator not available');
              (error as any).statusCode = 501;
              (error as any).code = 'not_implemented';
              throw error;
            }

            const callPromise = runWithCoordinatorLifecycle<EmbeddingCallSpec, any, any, any>({
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
                logger.info('HTTP /vector/embeddings/run completed', { durationMs: Date.now() - startTime });
              } catch (error: any) {
                if (timedOut) {
                  const mapped = mapErrorToHttp(error);
                  writeJson(res, mapped.status, mapped.body);
                  logger.warning('HTTP /vector/embeddings/run timed out', { durationMs: Date.now() - startTime });
                  releaseDeferred = true;
                  callPromise
                    .catch(err => logger.error('Coordinator finished after timeout', { error: err }))
                    .finally(() => release());
                  return;
                }

                const mapped = mapErrorToHttp(error);
                writeJson(res, mapped.status, mapped.body);
                logger.error('HTTP /vector/embeddings/run failed', { durationMs: Date.now() - startTime, error });
              } finally {
                if (timeoutId) clearTimeout(timeoutId);
              }

              return;
            }

            try {
              const response = await callPromise;
              writeJson(res, 200, { type: 'response', data: response });
              logger.info('HTTP /vector/embeddings/run completed', { durationMs: Date.now() - startTime });
            } catch (error: any) {
              const mapped = mapErrorToHttp(error);
              writeJson(res, mapped.status, mapped.body);
              logger.error('HTTP /vector/embeddings/run failed', { durationMs: Date.now() - startTime, error });
            }
          });
        } catch (error: any) {
          const mapped = mapErrorToHttp(error);
          writeJson(res, mapped.status, mapped.body);
        } finally {
          if (!releaseDeferred) release();
        }

        return;
      }

      writeJson(res, 404, { type: 'error', error: { message: 'Not found' } });
    } catch (error: any) {
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
