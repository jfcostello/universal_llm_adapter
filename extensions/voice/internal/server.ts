import type http from 'http';
import type net from 'net';
import crypto from 'crypto';
import { createRequire } from 'module';

import { mapErrorToHttp } from '../../../modules/transport/index.js';
import { createSignedWsToken, verifySignedWsToken } from '../../../modules/security/index.js';
import { normalizeFlag, sleep } from '../../../modules/shared/index.js';
import {
  applyCors,
  applySecurityHeaders,
  assertAuthorized,
  createRateLimiter,
  getClientIp,
  readJsonBody,
  writeHttpUpgradeResponse
} from '../../../modules/server/index.js';

import type { VoiceProviderPlugins } from './provider-plugins.js';
import { createVoiceProviderPlugins } from './provider-plugins.js';
import type { VoiceCallConfigStore } from './call-config-store/index.js';
import { createVoiceCallConfigStoreFromEnv } from './call-config-store/index.js';
import { createVoiceMetrics } from './metrics.js';

type VoiceMediaTokenPayload = {
  iat: number;
  exp: number;
  nonce: string;
  purpose: 'voice_media';
  callConfigId: string;
  voiceProvider: string;
};

type VoiceLogger = {
  withCorrelation: (correlationId: string | string[]) => VoiceLogger;
  debug: (message: string, data?: any) => void;
  info: (message: string, data?: any) => void;
  warning: (message: string, data?: any) => void;
  error: (message: string, data?: any) => void;
};

type VoiceLogging = {
  getLogger: (correlationId?: string) => VoiceLogger;
};

function parseUrl(rawUrl: string | undefined): URL | null {
  const raw = rawUrl ?? '/';
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return null;
  }
}

function getVoicePublicBaseUrlOverride(): string | undefined {
  const raw = String(process.env.LLM_ADAPTER_VOICE_PUBLIC_BASE_URL ?? '').trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid LLM_ADAPTER_VOICE_PUBLIC_BASE_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid LLM_ADAPTER_VOICE_PUBLIC_BASE_URL');
  }
  return parsed.origin;
}

function getPublicHttpBaseUrl(req: http.IncomingMessage): string {
  const override = getVoicePublicBaseUrlOverride();
  if (override) return override;

  const headers = req.headers ?? {};
  const trustProxyHeaders = normalizeFlag(process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS, false);

  const forwardedProto = trustProxyHeaders ? headers['x-forwarded-proto'] : undefined;
  const proto = (() => {
    if (typeof forwardedProto === 'string' && forwardedProto.trim()) {
      return forwardedProto.split(',')[0]!.trim();
    }
    return (req.socket as any)?.encrypted ? 'https' : 'http';
  })();

  const forwardedHost = trustProxyHeaders ? headers['x-forwarded-host'] : undefined;
  const host = (() => {
    if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
      return forwardedHost.split(',')[0]!.trim();
    }
    if (typeof headers.host === 'string' && headers.host.trim()) {
      return headers.host.trim();
    }
    return 'localhost';
  })();

  return `${proto}://${host}`;
}

function toWsUrl(httpBaseUrl: string, pathname: string, searchParams: Record<string, string>): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathname;
  url.search = '';
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function getWsTokenSecret(): string {
  const raw = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET ?? '').trim();
  if (!raw) {
    throw new Error('Missing LLM_ADAPTER_VOICE_WS_TOKEN_SECRET');
  }
  return raw;
}

function getWsTokenTtlSeconds(): number {
  const raw = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS ?? '').trim();
  if (!raw) return 300;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS');
  }
  return Math.floor(n);
}

function getMediaWsMaxMessageBytes(): number {
  const raw = String(process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES ?? '').trim();
  if (!raw) return 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid LLM_ADAPTER_VOICE_MEDIA_WS_MAX_MESSAGE_BYTES');
  }
  return Math.floor(n);
}

function getMediaWsMaxConcurrentSessions(): number {
  const raw = String(process.env.LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS ?? '').trim();
  if (!raw) return 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid LLM_ADAPTER_VOICE_MEDIA_WS_MAX_CONCURRENT_SESSIONS');
  }
  return Math.floor(n);
}

function mintVoiceMediaToken(options: { callConfigId: string; voiceProvider: string }): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = getWsTokenTtlSeconds();
  const payload: VoiceMediaTokenPayload = {
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    nonce: crypto.randomBytes(18).toString('base64url'),
    purpose: 'voice_media',
    callConfigId: String(options.callConfigId),
    voiceProvider: String(options.voiceProvider)
  };
  return createSignedWsToken({ secret: getWsTokenSecret(), payload });
}

function verifyVoiceMediaToken(token: string): { ok: true; payload: VoiceMediaTokenPayload } | { ok: false; error: any } {
  const res = verifySignedWsToken<VoiceMediaTokenPayload>({
    token,
    secret: getWsTokenSecret(),
    maxTtlSeconds: getWsTokenTtlSeconds(),
    expected: { purpose: 'voice_media' }
  });
  if (!res.ok) return res;

  const callConfigId = String((res.payload as any).callConfigId ?? '').trim();
  const voiceProvider = String((res.payload as any).voiceProvider ?? '').trim();
  if (!callConfigId || !voiceProvider) {
    return { ok: false, error: { code: 'missing_fields', message: 'Token payload missing required fields' } };
  }

  return { ok: true, payload: { ...(res.payload as any), callConfigId, voiceProvider } as VoiceMediaTokenPayload };
}

function writeJson(res: http.ServerResponse, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readTextBody(
  req: http.IncomingMessage,
  options: { maxBytes: number; timeoutMs: number }
): Promise<string> {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : Number.POSITIVE_INFINITY;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;

  let input = '';
  let bytes = 0;
  let timeout: NodeJS.Timeout | undefined;

  const readPromise = (async () => {
    req.setEncoding('utf-8');
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        const error = new Error('Request body too large');
        (error as any).statusCode = 413;
        (error as any).code = 'payload_too_large';
        throw error;
      }
      input += chunk;
    }
    return input;
  })();

  try {
    if (timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Request body read timed out');
          (error as any).statusCode = 408;
          (error as any).code = 'body_read_timeout';
          reject(error);
        }, timeoutMs);
      });
      return await Promise.race([readPromise, timeoutPromise]);
    }
    return await readPromise;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function createVoiceServerRegistration(ctx: {
  server: http.Server;
  registry: any;
  pluginsPath: string;
  upgradeRouter: any;
  store?: VoiceCallConfigStore;
  providerPlugins?: VoiceProviderPlugins;
  logging?: VoiceLogging;
  httpConfig?: {
    maxRequestBytes?: number;
    bodyReadTimeoutMs?: number;
    auth?: any;
    rateLimit?: any;
    cors?: any;
    securityHeadersEnabled?: boolean;
    idempotencyWaitMs?: number;
    idempotencyLockTtlSeconds?: number;
    authorize?: ((req: http.IncomingMessage) => boolean | Promise<boolean>) | undefined;
  };
}): Promise<{
  handleHttp: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  handleUpgrade: (ctx: { req: http.IncomingMessage; socket: net.Socket; head: Buffer; pathname: string }) => Promise<boolean>;
  close: () => Promise<void>;
}> {
  const storeInit = ctx.store ? { store: ctx.store, close: undefined } : await createVoiceCallConfigStoreFromEnv();
  const store = storeInit.store;
  const providerPlugins = ctx.providerPlugins ?? createVoiceProviderPlugins({ pluginsPath: ctx.pluginsPath });
  const httpConfig = ctx.httpConfig ?? {};
  const maxRequestBytes = httpConfig.maxRequestBytes ?? Number.POSITIVE_INFINITY;
  const bodyReadTimeoutMs = httpConfig.bodyReadTimeoutMs ?? 0;
  const authConfig = httpConfig.auth ?? { enabled: false };
  const rateLimitConfig = httpConfig.rateLimit ?? { enabled: false };
  const corsConfig = httpConfig.cors ?? { enabled: false };
  const securityHeadersEnabled = httpConfig.securityHeadersEnabled ?? true;
  const idempotencyWaitMs = Number.isFinite(httpConfig.idempotencyWaitMs)
    ? Math.max(0, Number(httpConfig.idempotencyWaitMs))
    : 2000;
  const idempotencyLockTtlSeconds = Number.isFinite(httpConfig.idempotencyLockTtlSeconds)
    ? Math.max(1, Math.floor(Number(httpConfig.idempotencyLockTtlSeconds)))
    : 60;
  const authorize = httpConfig.authorize;

  const rateLimiter = createRateLimiter(rateLimitConfig);

  let cachedLoggingModule: { getLogger: (correlationId?: string) => VoiceLogger } | undefined;
  const resolveLogger = async (correlationId?: string): Promise<VoiceLogger | undefined> => {
    if (ctx.logging?.getLogger) {
      try {
        return ctx.logging.getLogger(correlationId);
      } catch {
        return undefined;
      }
    }

    try {
      if (!cachedLoggingModule) {
        cachedLoggingModule = await import('../../../modules/logging/index.js');
      }
      return cachedLoggingModule.getLogger(correlationId);
    } catch {
      return undefined;
    }
  };

  const safeLog = (logger: VoiceLogger | undefined, level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any): void => {
    try {
      const fn = logger?.[level];
      if (typeof fn === 'function') fn(message, data);
    } catch {}
  };

  const assertAuthorizedAndRateLimited = async (req: http.IncomingMessage): Promise<string | undefined> => {
    const authIdentity = await assertAuthorized(req, authConfig, authorize as any);
    const clientIp = getClientIp(req, Boolean(rateLimitConfig?.trustProxyHeaders));
    const key = authIdentity ?? clientIp ?? 'unknown';
    if (rateLimitConfig?.enabled) {
      if (authConfig?.enabled) {
        rateLimiter.check(key);
      }
    }
    return authIdentity;
  };

  const require = createRequire(import.meta.url);
  const wsLib = require('ws');
  const mediaWsMaxMessageBytes = getMediaWsMaxMessageBytes();
  const mediaWsMaxConcurrentSessions = getMediaWsMaxConcurrentSessions();
  const wss = new wsLib.WebSocketServer({ noServer: true, maxPayload: mediaWsMaxMessageBytes, perMessageDeflate: false });

  let draining = false;
  let activeMediaWs = 0;
  let pendingMediaWs = 0;

  const metrics = createVoiceMetrics({
    enabled: normalizeFlag(process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED, false)
  });

  const close = async () => {
    draining = true;
    const clients: any[] = Array.from(wss.clients);
    for (const client of clients) {
      try { client.terminate(); } catch {}
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    activeMediaWs = 0;
    pendingMediaWs = 0;
    try {
      await storeInit.close?.();
    } catch {}
  };

  return {
    handleHttp: async (req, res) => {
      const url = parseUrl(req.url);
      if (!url) return false;

      const pathname = url.pathname;
      if (pathname !== '/voice' && !pathname.startsWith('/voice/')) return false;

      applySecurityHeaders(res, Boolean(securityHeadersEnabled));
      const corsHandled = applyCors(req, res, corsConfig);
      if (corsHandled) return true;

      try {
        if (pathname === '/voice/webhook') {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'POST') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          const callConfigId = String(url.searchParams.get('callConfigId') ?? '').trim();
          if (!callConfigId) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing callConfigId', code: 'validation_error' } });
            return true;
          }

          const callConfig = await store.getConfig(callConfigId);
          if (!callConfig) {
            writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
            return true;
          }

          const voiceProvider = String((callConfig as any).voiceProvider ?? '').trim();
          if (!voiceProvider) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
            return true;
          }

          const logger = await resolveLogger(callConfigId);
          safeLog(logger, 'info', 'voice.webhook.request', { callConfigId, voiceProvider, method });

          const compat = await providerPlugins.getCompat(voiceProvider);

          try {
            const validateWebhookRequest = (compat as any)?.validateWebhookRequest;
            if (typeof validateWebhookRequest === 'function') {
              const httpBaseUrl = getPublicHttpBaseUrl(req);
              const publicUrl = new URL(req.url ?? '/voice/webhook', httpBaseUrl).toString();

              const params: Record<string, string> = {};
              if (method === 'POST') {
                const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
                const rawBody = await readTextBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });

                if (rawBody && contentType.includes('application/x-www-form-urlencoded')) {
                  const form = new URLSearchParams(rawBody);
                  for (const [k, v] of form.entries()) {
                    params[String(k)] = String(v);
                  }
                }
              }

              let providerDefaults: any | undefined;
              try {
                const manifest = await providerPlugins.getManifest?.(voiceProvider);
                providerDefaults = (manifest as any)?.defaults;
              } catch {
                // ignore and allow compat to decide whether defaults are required
              }

              try {
                await validateWebhookRequest({ req, method, url: publicUrl, params, callConfigId, callConfig, voiceProvider, providerDefaults });
              } catch (error: any) {
                metrics.compatError('webhook_validate', voiceProvider);
                const statusCode = Number(error?.statusCode ?? 500);
                const code = error?.code !== undefined ? String(error.code) : undefined;
                safeLog(
                  logger,
                  statusCode >= 500 ? 'error' : 'warning',
                  'voice.webhook.validation_failed',
                  { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}) }
                );
                throw error;
              }
            }

            const httpBaseUrl = getPublicHttpBaseUrl(req);
            const token = mintVoiceMediaToken({ callConfigId, voiceProvider });
            const mediaWsUrl = toWsUrl(httpBaseUrl, '/voice/media', { token });

            const response = await (async () => {
              try {
                return await compat.createWebhookResponse({ req, callConfigId, callConfig, voiceProvider, mediaWsUrl });
              } catch (error: any) {
                metrics.compatError('webhook_response', voiceProvider);
                throw error;
              }
            })();
            const status = Number(response?.status ?? 200);
            const headers = (response?.headers && typeof response.headers === 'object') ? response.headers : {};
            const body = String(response?.body ?? '');

            safeLog(logger, 'info', 'voice.webhook.response', { callConfigId, voiceProvider, status });

            res.writeHead(status, headers);
            res.end(body);
            return true;
          } catch (error: any) {
            const statusCode = Number(error?.statusCode ?? 500);
            const code = error?.code !== undefined ? String(error.code) : undefined;
            if (!(statusCode === 401 && code === 'unauthorized')) {
              safeLog(
                logger,
                statusCode >= 500 ? 'error' : 'warning',
                'voice.webhook.error',
                { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}) }
              );
            }
            throw error;
          }
        }

        if (pathname === '/voice/metrics') {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'GET') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          if (!metrics.enabled) {
            writeJson(res, 404, { type: 'error', error: { message: 'Not found', code: 'not_found' } });
            return true;
          }

          await assertAuthorizedAndRateLimited(req);

          const snapshot = metrics.snapshot();
          writeJson(res, 200, { ok: true, enabled: snapshot.enabled, metrics: snapshot.metrics });
          return true;
        }

        if (pathname === '/voice/calls') {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'POST') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          await assertAuthorizedAndRateLimited(req);

          if (!authConfig?.enabled) {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice calls endpoint requires server auth to be enabled', code: 'not_implemented' } });
            return true;
          }

          const body = await readJsonBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });
          const to = String(body?.to ?? '').trim();
          const from = String(body?.from ?? '').trim();
          const systemPrompt = body?.systemPrompt !== undefined ? String(body.systemPrompt) : undefined;
          const realtimeSpec = body?.realtimeSpec;
          const voiceProvider = String(body?.voiceProvider ?? '').trim();

          const ttlSecondsRaw = body?.ttlSeconds;
          const ttlSeconds = ttlSecondsRaw === undefined || ttlSecondsRaw === null ? 900 : Number(ttlSecondsRaw);

          if (!to || !from || !voiceProvider || !realtimeSpec) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing required fields', code: 'validation_error' } });
            return true;
          }

          if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
            writeJson(res, 400, { type: 'error', error: { message: 'Invalid ttlSeconds', code: 'validation_error' } });
            return true;
          }

          const idempotencyKeyHeader = req.headers?.['idempotency-key'];
          const idempotencyKey =
            (typeof idempotencyKeyHeader === 'string' ? idempotencyKeyHeader : undefined) ??
            (body?.idempotencyKey !== undefined ? String(body.idempotencyKey) : undefined);
          const idempotencyKeyTrimmed = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';

          let callConfigId: string | undefined;
          let logger: VoiceLogger | undefined;

          try {
            if (idempotencyKeyTrimmed) {
              const existing = await store.getIdempotency(idempotencyKeyTrimmed);
              if (existing) {
                callConfigId = String((existing as any)?.callConfigId ?? '').trim();
                const providerCallId = String((existing as any)?.providerCallId ?? '').trim();
                logger = await resolveLogger(callConfigId || undefined);
                safeLog(logger, 'info', 'voice.calls.idempotency_hit', {
                  ...(callConfigId ? { callConfigId } : {}),
                  voiceProvider,
                  ...(providerCallId ? { providerCallId } : {})
                });
                writeJson(res, 200, existing);
                return true;
              }

              const lockTtlSeconds = Math.max(1, Math.min(ttlSeconds, idempotencyLockTtlSeconds));
              const lockOk = await store.consumeNonceOnce(`idem:${idempotencyKeyTrimmed}`, { ttlSeconds: lockTtlSeconds });
              if (!lockOk) {
                const start = Date.now();
                while (Date.now() - start < idempotencyWaitMs) {
                  const ready = await store.getIdempotency(idempotencyKeyTrimmed);
                  if (ready) {
                    callConfigId = String((ready as any)?.callConfigId ?? '').trim();
                    const providerCallId = String((ready as any)?.providerCallId ?? '').trim();
                    logger = await resolveLogger(callConfigId || undefined);
                    safeLog(logger, 'info', 'voice.calls.idempotency_hit', {
                      ...(callConfigId ? { callConfigId } : {}),
                      voiceProvider,
                      ...(providerCallId ? { providerCallId } : {})
                    });
                    writeJson(res, 200, ready);
                    return true;
                  }
                  await sleep(25);
                }

                logger = await resolveLogger();
                safeLog(logger, 'warning', 'voice.calls.idempotency_in_progress', { voiceProvider });
                writeJson(res, 409, {
                  type: 'error',
                  error: { message: 'Idempotency key is already in progress', code: 'idempotency_in_progress' }
                });
                return true;
              }
            }

            let providerDefaults: any | undefined;
            try {
              const manifest = await providerPlugins.getManifest(voiceProvider);
              providerDefaults = (manifest as any).defaults;
            } catch {
              writeJson(res, 400, { type: 'error', error: { message: 'Unknown voiceProvider', code: 'validation_error' } });
              return true;
            }

            callConfigId = `voice_cfg_${crypto.randomBytes(18).toString('base64url')}`;
            logger = logger ?? (await resolveLogger(callConfigId));
            safeLog(logger, 'info', 'voice.calls.accepted', {
              callConfigId,
              voiceProvider,
              hasIdempotencyKey: Boolean(idempotencyKeyTrimmed)
            });
            await store.putConfig(
              {
                version: 1,
                callConfigId,
                createdAtMs: 0,
                expiresAtMs: 0,
                to,
                from,
                direction: 'outbound',
                systemPrompt,
                realtimeSpec,
                voiceProvider,
                metadata: body?.metadata
              } as any,
              { ttlSeconds }
            );

            const httpBaseUrl = getPublicHttpBaseUrl(req);
            const token = mintVoiceMediaToken({ callConfigId, voiceProvider });
            const mediaWsUrl = toWsUrl(httpBaseUrl, '/voice/media', { token });

            const compat = await providerPlugins.getCompat(voiceProvider);
            const callConfig = await store.getConfig(callConfigId);
            if (!callConfig) {
              const error = new Error('Failed to load stored call config');
              (error as any).statusCode = 500;
              throw error;
            }

            metrics.outboundCallAttempt(voiceProvider);

            const outbound = await (async () => {
              try {
                return await compat.createOutboundCall({
                  to,
                  from,
                  callConfigId,
                  callConfig,
                  voiceProvider,
                  mediaWsUrl,
                  providerDefaults
                });
              } catch (error: any) {
                metrics.compatError('outbound_call', voiceProvider);
                throw error;
              }
            })();
            const providerCallId = String(outbound?.providerCallId ?? '').trim();
            if (!providerCallId) {
              const error = new Error('Voice provider did not return providerCallId');
              (error as any).statusCode = 502;
              (error as any).code = 'provider_error';
              throw error;
            }

            safeLog(logger, 'info', 'voice.calls.queued', { callConfigId, voiceProvider, providerCallId });

            const response = { callConfigId, providerCallId, status: 'queued' };
            if (idempotencyKeyTrimmed) {
              await store.putIdempotency(idempotencyKeyTrimmed, response, { ttlSeconds });
            }

            writeJson(res, 200, response);
            return true;
          } catch (error: any) {
            const statusCode = Number(error?.statusCode ?? 500);
            const code = error?.code !== undefined ? String(error.code) : undefined;
            const fallbackLogger = logger ?? (await resolveLogger(callConfigId));
            safeLog(
              fallbackLogger,
              statusCode >= 500 ? 'error' : 'warning',
              'voice.calls.error',
              { ...(callConfigId ? { callConfigId } : {}), voiceProvider, statusCode, ...(code ? { code } : {}) }
            );
            throw error;
          }
        }

        if (pathname === '/voice' || pathname === '/voice/') {
          writeJson(res, 200, { ok: true });
          return true;
        }

        writeJson(res, 404, { type: 'error', error: { message: 'Not found', code: 'not_found' } });
        return true;
      } catch (err: any) {
        const mapped = mapErrorToHttp(err);
        writeJson(res, mapped.status, mapped.body);
        return true;
      }
    },

    handleUpgrade: async ({ req, socket, head, pathname }) => {
      if (pathname !== '/voice/media') return false;

      if (draining) {
        writeHttpUpgradeResponse(socket, 503, 'Service Unavailable', 'Service Unavailable');
        socket.destroy();
        return true;
      }

      let pendingReserved = false;
      const releasePending = () => {
        if (!pendingReserved) return;
        pendingReserved = false;
        pendingMediaWs = Math.max(0, pendingMediaWs - 1);
      };

      try {
        const url = parseUrl(req.url);
        if (!url) {
          writeHttpUpgradeResponse(socket, 400, 'Bad Request', 'Bad Request');
          socket.destroy();
          return true;
        }

        const token = String(url.searchParams.get('token') ?? '').trim();
        const verified = verifyVoiceMediaToken(token);
        if (!verified.ok) {
          writeHttpUpgradeResponse(socket, 401, 'Unauthorized', 'Unauthorized');
          socket.destroy();
          return true;
        }

        const { callConfigId, voiceProvider, nonce, exp } = verified.payload;

        if (activeMediaWs + pendingMediaWs >= mediaWsMaxConcurrentSessions) {
          const logger = await resolveLogger(callConfigId);
          safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'server_busy' });
          writeHttpUpgradeResponse(socket, 503, 'Service Unavailable', 'Service Unavailable');
          socket.destroy();
          return true;
        }

        pendingMediaWs += 1;
        pendingReserved = true;

        const nowSeconds = Math.floor(Date.now() / 1000);
        const ttlSeconds = Math.max(1, Math.ceil(exp - nowSeconds));
        const nonceOk = await store.consumeNonceOnce(nonce, { ttlSeconds });
        if (!nonceOk) {
          const logger = await resolveLogger(callConfigId);
          safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'nonce_replay' });
          writeHttpUpgradeResponse(socket, 401, 'Unauthorized', 'Unauthorized');
          socket.destroy();
          releasePending();
          return true;
        }

        const callConfig = await store.getConfig(callConfigId);
        if (!callConfig) {
          const logger = await resolveLogger(callConfigId);
          safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'unknown_call_config' });
          writeHttpUpgradeResponse(socket, 404, 'Not Found', 'Not Found');
          socket.destroy();
          releasePending();
          return true;
        }

        if (String((callConfig as any).voiceProvider ?? '') !== voiceProvider) {
          const logger = await resolveLogger(callConfigId);
          safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'voice_provider_mismatch' });
          writeHttpUpgradeResponse(socket, 401, 'Unauthorized', 'Unauthorized');
          socket.destroy();
          releasePending();
          return true;
        }

        const logger = await resolveLogger(callConfigId);
        const compat = await providerPlugins.getCompat(voiceProvider);

        wss.handleUpgrade(req, socket, head, (ws: any) => {
          releasePending();
          activeMediaWs += 1;

          const releaseActive = () => {
            activeMediaWs = Math.max(0, activeMediaWs - 1);
          };

          metrics.mediaWsConnected(voiceProvider);
          safeLog(logger, 'info', 'voice.media.connected', { callConfigId, voiceProvider });
          try {
            ws.on?.('close', (code: number) => {
              releaseActive();
              metrics.mediaWsClosed(voiceProvider);
              safeLog(logger, 'info', 'voice.media.closed', { callConfigId, voiceProvider, code: Number(code) });
            });
            ws.on?.('error', (err: any) => {
              metrics.mediaWsError(voiceProvider);
              safeLog(logger, 'error', 'voice.media.ws_error', { callConfigId, voiceProvider, message: err?.message ?? String(err) });
            });
          } catch {}

          void Promise.resolve()
            .then(() =>
              compat.handleMediaConnection({
                ws,
                req,
                callConfigId,
                callConfig,
                voiceProvider,
                registry: ctx.registry,
                store,
                logger,
                metrics
              })
            )
            .catch((err) => {
              metrics.compatError('media_connection', voiceProvider);
              safeLog(logger, 'error', 'voice.media.error', {
                callConfigId,
                voiceProvider,
                code: err?.code !== undefined ? String(err.code) : undefined,
                message: err?.message ?? 'Media handler failed'
              });
              try { ws.close(); } catch {}
            });
        });

        return true;
      } catch (error: any) {
        releasePending();
        writeHttpUpgradeResponse(socket, 500, 'Internal Server Error', 'Internal Server Error');
        socket.destroy();
        return true;
      }
    },

    close
  };
}
