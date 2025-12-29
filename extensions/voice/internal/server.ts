import type http from 'http';
import type net from 'net';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { createRequire } from 'module';

import { mapErrorToHttp } from '../../../modules/transport/index.js';
import { createSignedWsToken, verifySignedWsToken } from '../../../modules/security/index.js';
import { makeHttpError, normalizeFlag, readTrimmedStringProperty, sleep } from '../../../modules/shared/index.js';
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
import { createVoiceCallEventHub, type VoiceCallEventHub, type VoiceCallEventEnvelope } from './call-events.js';
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

function normalizeRequestId(value: string): string | undefined {
  if (!value) return undefined;
  const first = value.split(',')[0]!.trim();
  const cleaned = first.replace(/[\r\n\t]/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, 128);
}

function readRequestId(req: http.IncomingMessage): string | undefined {
  const readHeader = (name: string): string => {
    const raw = req.headers?.[name];
    const first =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? String(raw[0] ?? '')
          : '';
    return first.trim();
  };

  return (
    normalizeRequestId(readHeader('x-request-id')) ??
    normalizeRequestId(readHeader('x-correlation-id'))
  );
}

function normalizeIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const maxBytes = 512;
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) return trimmed;

  const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
  return `sha256:${hash}`;
}

function asPlainObject(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, any>;
}

function readVoiceExtensionDefaults(httpConfig: any): Record<string, any> {
  const extensions = asPlainObject(httpConfig?.extensions);
  const voice = asPlainObject(extensions?.voice);
  return voice ?? {};
}

type AssistantFirstTurnConfig = {
  enabled: boolean;
  prompt?: string;
  role: 'system' | 'user';
  delayMs: number;
  missingPromptBehavior: 'reject' | 'skip';
};

type VoiceCallTimeoutsConfig = {
  callTimeoutMs?: number;
  silenceTimeoutMs?: number;
};

function readPositiveInt(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  const out = Math.floor(n);
  if (!Number.isFinite(n) || out <= 0) {
    throw makeHttpError({ message: `Invalid ${label}`, statusCode: 400, code: 'validation_error' });
  }
  return out;
}

function normalizeVoiceCallTimeouts(options: {
  raw: unknown;
  defaults: unknown;
}): VoiceCallTimeoutsConfig | undefined {
  const raw = asPlainObject(options.raw);
  const defaults = asPlainObject(options.defaults);
  if (!raw && !defaults) return undefined;

  const callTimeoutMsRaw = raw?.callTimeoutMs !== undefined ? raw.callTimeoutMs : defaults?.callTimeoutMs;
  const silenceTimeoutMsRaw = raw?.silenceTimeoutMs !== undefined ? raw.silenceTimeoutMs : defaults?.silenceTimeoutMs;

  const out: VoiceCallTimeoutsConfig = {};
  if (callTimeoutMsRaw !== undefined && callTimeoutMsRaw !== null && callTimeoutMsRaw !== '') {
    out.callTimeoutMs = readPositiveInt(callTimeoutMsRaw, 'timeouts.callTimeoutMs');
  }
  if (silenceTimeoutMsRaw !== undefined && silenceTimeoutMsRaw !== null && silenceTimeoutMsRaw !== '') {
    out.silenceTimeoutMs = readPositiveInt(silenceTimeoutMsRaw, 'timeouts.silenceTimeoutMs');
  }

  return Object.keys(out).length > 0 ? out : {};
}

type VoiceCallRecordingConfig = {
  enabled: boolean;
  mode: 'provider' | 'adapter';
  format: 'mp3' | 'wav';
  channels: 'mono' | 'dual';
};

function normalizeVoiceCallRecording(options: {
  raw: unknown;
  defaults: unknown;
}): VoiceCallRecordingConfig | undefined {
  const raw = asPlainObject(options.raw);
  const defaults = asPlainObject(options.defaults);
  if (!raw && !defaults) return undefined;

  const enabled =
    raw?.enabled !== undefined
      ? Boolean(raw.enabled)
      : defaults?.enabled !== undefined
        ? Boolean(defaults.enabled)
        : false;

  const modeRaw = raw?.mode !== undefined ? raw.mode : defaults?.mode;
  const mode = modeRaw === 'adapter' ? 'adapter' : 'provider';

  const formatRaw = raw?.format !== undefined ? raw.format : defaults?.format;
  const format = formatRaw === 'wav' ? 'wav' : 'mp3';

  const channelsRaw = raw?.channels !== undefined ? raw.channels : defaults?.channels;
  const channels = channelsRaw === 'dual' ? 'dual' : 'mono';

  return { enabled, mode, format, channels };
}

function normalizeAssistantFirstTurn(options: {
  raw: unknown;
  defaults: unknown;
}): AssistantFirstTurnConfig | undefined {
  const raw = asPlainObject(options.raw);
  const defaults = asPlainObject(options.defaults);
  if (!raw && !defaults) return undefined;

  const enabled =
    raw?.enabled !== undefined
      ? Boolean(raw.enabled)
      : defaults?.enabled !== undefined
        ? Boolean(defaults.enabled)
        : false;

  const promptRaw = raw?.prompt !== undefined ? raw.prompt : defaults?.prompt;
  const prompt = promptRaw === undefined || promptRaw === null ? undefined : String(promptRaw);

  const roleRaw = raw?.role !== undefined ? raw.role : defaults?.role;
  const role = roleRaw === 'system' ? 'system' : 'user';

  const delayMsRaw = raw?.delayMs !== undefined ? raw.delayMs : defaults?.delayMs;
  const delayMsValue =
    delayMsRaw === undefined || delayMsRaw === null || delayMsRaw === ''
      ? 0
      : Number(delayMsRaw);
  if (!Number.isFinite(delayMsValue) || delayMsValue < 0) {
    throw makeHttpError({ message: 'Invalid assistantFirstTurn.delayMs', statusCode: 400, code: 'validation_error' });
  }
  const delayMs = Math.floor(delayMsValue);

  const missingPromptBehaviorRaw =
    raw?.missingPromptBehavior !== undefined
      ? raw.missingPromptBehavior
      : defaults?.missingPromptBehavior;
  const missingPromptBehavior = missingPromptBehaviorRaw === 'skip' ? 'skip' : 'reject';

  const out: AssistantFirstTurnConfig = {
    enabled,
    ...(prompt !== undefined ? { prompt } : {}),
    role,
    delayMs,
    missingPromptBehavior
  };

  if (out.enabled) {
    const trimmed = String(out.prompt ?? '').trim();
    if (!trimmed) {
      if (out.missingPromptBehavior === 'skip') {
        out.enabled = false;
      } else {
        throw makeHttpError({
          message: 'assistantFirstTurn.prompt is required when assistantFirstTurn.enabled=true',
          statusCode: 400,
          code: 'validation_error'
        });
      }
    }
  }

  return out;
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

function sanitizeForwardedProto(raw: unknown): 'http' | 'https' | undefined {
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]!.trim().toLowerCase();
  if (first === 'http' || first === 'https') return first;
  return undefined;
}

function sanitizeHostHeader(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]!.trim();
  if (!first) return undefined;
  if (/[\r\n\t ]/.test(first)) return undefined;
  if (first.includes('/') || first.includes('\\') || first.includes('@') || first.includes('://')) return undefined;

    try {
      const parsed = new URL(`http://${first}`);
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
      return parsed.host;
    } catch {
      return undefined;
    }
}

function getPublicHttpBaseUrl(req: http.IncomingMessage): string {
  const override = getVoicePublicBaseUrlOverride();
  if (override) return override;

  const headers = req.headers ?? {};
  const trustProxyHeaders = normalizeFlag(process.env.LLM_ADAPTER_VOICE_TRUST_PROXY_HEADERS, false);

  const fallbackProto = (req.socket as any)?.encrypted ? 'https' : 'http';
  const proto = (trustProxyHeaders ? sanitizeForwardedProto(headers['x-forwarded-proto']) : undefined) ?? fallbackProto;

  const forwardedHost = trustProxyHeaders ? sanitizeHostHeader(headers['x-forwarded-host']) : undefined;
  const host = forwardedHost ?? sanitizeHostHeader(headers.host) ?? 'localhost';

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

  function getWebhookValidationRequired(): boolean {
    return normalizeFlag(process.env.LLM_ADAPTER_VOICE_WEBHOOK_VALIDATION_REQUIRED, true);
  }

  function getWsTokenTtlSeconds(): number {
    const maxTtlSeconds = 86400;
    const raw = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS ?? '').trim();
    if (!raw) return 300;
    const n = Number(raw);
    const ttlSeconds = Math.floor(n);
    if (!Number.isFinite(n) || ttlSeconds <= 0 || ttlSeconds > maxTtlSeconds) {
      throw new Error(`Invalid LLM_ADAPTER_VOICE_WS_TOKEN_TTL_SECONDS (max ${maxTtlSeconds})`);
    }
    return ttlSeconds;
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
        throw makeHttpError({ message: 'Request body too large', statusCode: 413, code: 'payload_too_large' });
      }
      input += chunk;
    }
    return input;
  })();

  try {
    if (timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(makeHttpError({ message: 'Request body read timed out', statusCode: 408, code: 'body_read_timeout' }));
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

      const providerPlugins = ctx.providerPlugins ?? createVoiceProviderPlugins({
        pluginsPath: ctx.pluginsPath,
        logger: {
          warning: (message: string, data?: any) => {
            void (async () => {
              try {
                const logger = await resolveLogger();
                safeLog(logger, 'warning', message, data);
              } catch {}
            })();
          }
        }
      });

    const voiceDefaults = readVoiceExtensionDefaults(httpConfig);

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

  const voiceEventsDefaults = asPlainObject((voiceDefaults as any)?.events) ?? {};
  const eventsDefaultIncludeDeltas = voiceEventsDefaults.includeDeltas === true;

  const eventsHub: VoiceCallEventHub = (() => {
    const injected = (ctx as any)?.eventsHub;
    if (injected && typeof injected.emit === 'function' && typeof injected.subscribe === 'function') {
      return injected as VoiceCallEventHub;
    }

    const maxActiveCallsRaw = voiceEventsDefaults.maxActiveCalls;
    const maxActiveCalls = Number.isFinite(Number(maxActiveCallsRaw)) ? Math.max(1, Math.floor(Number(maxActiveCallsRaw))) : undefined;

    const maxBufferedEventsPerCallRaw = voiceEventsDefaults.maxBufferedEventsPerCall;
    const maxBufferedEventsPerCall = Number.isFinite(Number(maxBufferedEventsPerCallRaw))
      ? Math.max(0, Math.floor(Number(maxBufferedEventsPerCallRaw)))
      : undefined;

    const callTtlMsRaw = voiceEventsDefaults.callTtlMs;
    const callTtlMs = Number.isFinite(Number(callTtlMsRaw)) ? Math.max(0, Math.floor(Number(callTtlMsRaw))) : undefined;

    return createVoiceCallEventHub({
      ...(maxActiveCalls !== undefined ? { maxActiveCalls } : {}),
      ...(maxBufferedEventsPerCall !== undefined ? { maxBufferedEventsPerCall } : {}),
      ...(callTtlMs !== undefined ? { callTtlMs } : {})
    });
  })();

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
      eventsHub.close();
    } catch {}
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

          const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
          const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

          const logger = await resolveLogger(callConfigId);
          safeLog(logger, 'info', 'voice.webhook.request', { callConfigId, voiceProvider, method, ...(requestId ? { requestId } : {}) });

          const compat = await providerPlugins.getCompat(voiceProvider);
          const params: Record<string, string> = {};
          if (method === 'POST') {
            const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
            if (contentType.includes('application/x-www-form-urlencoded')) {
              const rawBody = await readTextBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });
              if (rawBody) {
                const form = new URLSearchParams(rawBody);
                for (const [k, v] of form.entries()) {
                  params[String(k)] = String(v);
                }
              }
            }
          }

          try {
            const validateWebhookRequest = (compat as any)?.validateWebhookRequest;
            if (typeof validateWebhookRequest !== 'function') {
              if (getWebhookValidationRequired()) {
                throw makeHttpError({
                  message: 'Voice compat missing validateWebhookRequest()',
                  statusCode: 501,
                  code: 'webhook_validation_unavailable'
                });
              }
            } else {
              const httpBaseUrl = getPublicHttpBaseUrl(req);
              const publicUrl = new URL(req.url ?? '/voice/webhook', httpBaseUrl).toString();

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
                  { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
                );
                throw error;
              }
            }

            const httpBaseUrl = getPublicHttpBaseUrl(req);
            const token = mintVoiceMediaToken({ callConfigId, voiceProvider });
            const mediaWsUrl = toWsUrl(httpBaseUrl, '/voice/media', { token });

            const response = await (async () => {
              try {
                return await compat.createWebhookResponse({ req, callConfigId, callConfig, voiceProvider, mediaWsUrl, params });
              } catch (error: any) {
                metrics.compatError('webhook_response', voiceProvider);
                throw error;
              }
            })();
            const status = Number(response?.status ?? 200);
            const headers = (response?.headers && typeof response.headers === 'object') ? response.headers : {};
            const body = String(response?.body ?? '');

            safeLog(logger, 'info', 'voice.webhook.response', { callConfigId, voiceProvider, status, ...(requestId ? { requestId } : {}) });

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
                { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
              );
            }
            throw error;
          }
        }

        if (pathname === '/voice/webhook/recording') {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'POST') {
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

          const voiceProvider = String((callConfig as any)?.voiceProvider ?? '').trim();
          if (!voiceProvider) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
            return true;
          }

          const logger = await resolveLogger(callConfigId);
          const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
          const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

          const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
          if (!contentType.includes('application/x-www-form-urlencoded')) {
            writeJson(res, 400, { type: 'error', error: { message: 'Unsupported content-type', code: 'validation_error' } });
            return true;
          }

          const rawBody = await readTextBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });
          const params: Record<string, string> = {};
          if (rawBody) {
            const form = new URLSearchParams(rawBody);
            for (const [k, v] of form.entries()) {
              params[String(k)] = String(v);
            }
          }

          const compat = await providerPlugins.getCompat(voiceProvider);
          try {
            const validateWebhookRequest = (compat as any)?.validateWebhookRequest;
            if (typeof validateWebhookRequest !== 'function') {
              if (getWebhookValidationRequired()) {
                throw makeHttpError({
                  message: 'Voice compat missing validateWebhookRequest()',
                  statusCode: 501,
                  code: 'webhook_validation_unavailable'
                });
              }
            } else {
              const httpBaseUrl = getPublicHttpBaseUrl(req);
              const publicUrl = new URL(`${url.pathname}${url.search}`, httpBaseUrl).toString();

              let providerDefaults: any | undefined;
              try {
                const manifest = await providerPlugins.getManifest?.(voiceProvider);
                providerDefaults = (manifest as any)?.defaults;
              } catch {}

              await validateWebhookRequest({ req, method, url: publicUrl, params, callConfigId, callConfig, voiceProvider, providerDefaults });
            }
          } catch (error: any) {
            const statusCode = Number(error?.statusCode ?? 500);
            const code = error?.code !== undefined ? String(error.code) : undefined;
            safeLog(
              logger,
              statusCode >= 500 ? 'error' : 'warning',
              'voice.webhook.recording.error',
              { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
            );
            throw error;
          }

          const recordingCfg = (callConfig as any)?.recording;
          if (!(recordingCfg && typeof recordingCfg === 'object' && (recordingCfg as any).enabled === true)) {
            writeJson(res, 409, { type: 'error', error: { message: 'Recording is not enabled for this call', code: 'recording_not_enabled' } });
            return true;
          }

          const parseRecordingWebhook = (compat as any)?.parseRecordingWebhook;
          if (typeof parseRecordingWebhook !== 'function') {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice compat missing parseRecordingWebhook()', code: 'recording_parse_unavailable' } });
            return true;
          }

          let parsed: any;
          try {
            parsed = await parseRecordingWebhook({ params, callConfigId, callConfig, voiceProvider });
          } catch (error: any) {
            const statusCode = Number(error?.statusCode ?? 500);
            const code = error?.code !== undefined ? String(error.code) : undefined;
            safeLog(
              logger,
              statusCode >= 500 ? 'error' : 'warning',
              'voice.webhook.recording.parse_failed',
              { callConfigId, voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
            );
            throw error;
          }

          const recordingId = String(parsed?.recordingId ?? '').trim();
          const recordingUrl = String(parsed?.recordingUrl ?? '').trim();
          const recordingStatus = String(parsed?.recordingStatus ?? '').trim();
          const providerCallId = String(parsed?.providerCallId ?? (callConfig as any)?.providerCallId ?? '').trim();
          if (!recordingId || !recordingUrl) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing recording fields', code: 'validation_error' } });
            return true;
          }

          const updatedRecording = {
            ...(recordingCfg as any),
            providerRecording: {
              id: recordingId,
              url: recordingUrl,
              ...(recordingStatus ? { status: recordingStatus } : {})
            }
          };

          const expiresAtMs = Number((callConfig as any)?.expiresAtMs);
          const ttlRemainingSeconds = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
            ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000))
            : 60;
          await store.putConfig({ ...(callConfig as any), recording: updatedRecording } as any, { ttlSeconds: ttlRemainingSeconds });

          eventsHub.emit(callConfigId, { type: 'voice.recording.ready', recordingId, ...(providerCallId ? { providerCallId } : {}) });

          safeLog(logger, 'info', 'voice.webhook.recording.received', {
            callConfigId,
            voiceProvider,
            recordingId,
            ...(providerCallId ? { providerCallId } : {}),
            ...(requestId ? { requestId } : {})
          });

          writeJson(res, 200, { ok: true });
          return true;
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

          if (!authConfig?.enabled) {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice metrics endpoint requires server auth to be enabled', code: 'not_implemented' } });
            return true;
          }

          await assertAuthorizedAndRateLimited(req);

          const snapshot = metrics.snapshot();
          writeJson(res, 200, { ok: true, enabled: snapshot.enabled, metrics: snapshot.metrics });
          return true;
        }

        const callPathParts = pathname.split('/').filter(Boolean);

        if (
          callPathParts.length === 4 &&
          callPathParts[0] === 'voice' &&
          callPathParts[1] === 'calls' &&
          callPathParts[2] &&
          callPathParts[3] === 'events'
        ) {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'GET') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          if (!authConfig?.enabled) {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice call events endpoint requires server auth to be enabled', code: 'not_implemented' } });
            return true;
          }

          await assertAuthorizedAndRateLimited(req);

          const callConfigId = String(callPathParts[2]).trim();
          const callConfig = await store.getConfig(callConfigId);
          if (!callConfig) {
            writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
            return true;
          }

          const includeDeltasRaw = url.searchParams.get('includeDeltas');
          const includeDeltas = includeDeltasRaw === null
            ? eventsDefaultIncludeDeltas
            : normalizeFlag(includeDeltasRaw, eventsDefaultIncludeDeltas);

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          });

          const sanitizeEventName = (value: string): string =>
            String(value ?? '')
              .replace(/[\r\n]/g, '')
              .trim()
              .slice(0, 128) || 'message';

          const writeEvent = (envelope: VoiceCallEventEnvelope) => {
            try {
              const name = sanitizeEventName(envelope.event?.type);
              const data = JSON.stringify(envelope);
              res.write(`event: ${name}\n`);
              res.write(`data: ${data}\n\n`);
            } catch {}
          };

          const sub = eventsHub.subscribe(callConfigId, { includeDeltas }, (evt) => writeEvent(evt));
          for (const evt of sub.replay) {
            writeEvent(evt);
          }

          let closed = false;
          let keepAliveTimer: any | undefined;
          const cleanup = () => {
            if (closed) return;
            closed = true;
            try { if (keepAliveTimer) clearInterval(keepAliveTimer); } catch {}
            try { sub.unsubscribe(); } catch {}
          };

          keepAliveTimer = setInterval(() => {
            try {
              res.write(': keepalive\n\n');
            } catch {}
          }, 15000);
          if (typeof (keepAliveTimer as any)?.unref === 'function') {
            (keepAliveTimer as any).unref();
          }

          req.on?.('close', cleanup);
          res.on?.('close', cleanup);
          res.on?.('error', cleanup);

          return true;
        }

        if (
          callPathParts.length === 4 &&
          callPathParts[0] === 'voice' &&
          callPathParts[1] === 'calls' &&
          callPathParts[2] &&
          callPathParts[3] === 'end'
        ) {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'POST') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          if (!authConfig?.enabled) {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice call end endpoint requires server auth to be enabled', code: 'not_implemented' } });
            return true;
          }

          await assertAuthorizedAndRateLimited(req);

          const callConfigId = String(callPathParts[2]).trim();
          const callConfig = await store.getConfig(callConfigId);
          if (!callConfig) {
            writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
            return true;
          }

          const voiceProvider = String((callConfig as any)?.voiceProvider ?? '').trim();
          if (!voiceProvider) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
            return true;
          }

          const providerCallId = String((callConfig as any)?.providerCallId ?? '').trim();
          if (!providerCallId) {
            writeJson(res, 409, { type: 'error', error: { message: 'Call is missing providerCallId', code: 'not_ready' } });
            return true;
          }

          let providerDefaults: any | undefined;
          try {
            const manifest = await providerPlugins.getManifest(voiceProvider);
            providerDefaults = (manifest as any)?.defaults;
          } catch {
            writeJson(res, 400, { type: 'error', error: { message: 'Unknown voiceProvider', code: 'validation_error' } });
            return true;
          }

          const compat = await providerPlugins.getCompat(voiceProvider);
          const endCall = (compat as any)?.endCall;
          if (typeof endCall !== 'function') {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice provider does not support call termination', code: 'not_implemented' } });
            return true;
          }

          await endCall({ callConfigId, callConfig, voiceProvider, providerCallId, providerDefaults });
          eventsHub.emit(callConfigId, { type: 'voice.call.end_requested', reason: 'client_request', providerCallId });

          writeJson(res, 200, { ok: true });
          return true;
        }

        if (
          callPathParts.length === 4 &&
          callPathParts[0] === 'voice' &&
          callPathParts[1] === 'calls' &&
          callPathParts[2] &&
          callPathParts[3] === 'recording'
        ) {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'GET') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          if (!authConfig?.enabled) {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice recording endpoint requires server auth to be enabled', code: 'not_implemented' } });
            return true;
          }

          await assertAuthorizedAndRateLimited(req);

          const callConfigId = String(callPathParts[2]).trim();
          const callConfig = await store.getConfig(callConfigId);
          if (!callConfig) {
            writeJson(res, 404, { type: 'error', error: { message: 'Unknown callConfigId', code: 'not_found' } });
            return true;
          }

          const voiceProvider = String((callConfig as any)?.voiceProvider ?? '').trim();
          if (!voiceProvider) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing voiceProvider in call config', code: 'validation_error' } });
            return true;
          }

          const recordingCfg = (callConfig as any)?.recording;
          if (!(recordingCfg && typeof recordingCfg === 'object' && (recordingCfg as any).enabled === true)) {
            writeJson(res, 409, { type: 'error', error: { message: 'Recording is not enabled for this call', code: 'recording_not_enabled' } });
            return true;
          }

          const providerRecording = (recordingCfg as any)?.providerRecording;
          const hasProviderArtifact = providerRecording && typeof providerRecording === 'object'
            && (typeof (providerRecording as any).url === 'string' || typeof (providerRecording as any).id === 'string');
          if (!hasProviderArtifact) {
            writeJson(res, 409, { type: 'error', error: { message: 'Recording is not ready', code: 'recording_not_ready' } });
            return true;
          }

          let providerDefaults: any | undefined;
          try {
            const manifest = await providerPlugins.getManifest(voiceProvider);
            providerDefaults = (manifest as any)?.defaults;
          } catch {
            writeJson(res, 400, { type: 'error', error: { message: 'Unknown voiceProvider', code: 'validation_error' } });
            return true;
          }

          const compat = await providerPlugins.getCompat(voiceProvider);
          const getRecordingDownloadRequest = (compat as any)?.getRecordingDownloadRequest;
          if (typeof getRecordingDownloadRequest !== 'function') {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice provider does not support recording download', code: 'not_implemented' } });
            return true;
          }

          const download = await getRecordingDownloadRequest({ callConfigId, callConfig, voiceProvider, providerDefaults });
          const downloadUrl = String(download?.url ?? '').trim();
          if (!downloadUrl) {
            writeJson(res, 502, { type: 'error', error: { message: 'Voice provider did not return a recording URL', code: 'provider_error' } });
            return true;
          }

          const upstream = await fetch(downloadUrl, {
            method: 'GET',
            headers: (download?.headers && typeof download.headers === 'object') ? download.headers : undefined
          });
          if (!upstream.ok) {
            const text = await upstream.text().catch(() => '');
            writeJson(res, 502, { type: 'error', error: { message: `Upstream recording download failed (${upstream.status})`, code: 'provider_error', ...(text ? { detail: text.slice(0, 500) } : {}) } });
            return true;
          }

          const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
          const format = (recordingCfg as any)?.format === 'wav' ? 'wav' : 'mp3';

          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename=\"${callConfigId}.${format}\"`
          });

          if (!upstream.body) {
            res.end();
            return true;
          }

          const stream = Readable.fromWeb(upstream.body as any);
          try {
            await pipeline(stream, res);
          } catch {
            try { res.end(); } catch {}
          }
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
          const assistantFirstTurn = normalizeAssistantFirstTurn({
            raw: body?.assistantFirstTurn,
            defaults: (voiceDefaults as any)?.assistantFirstTurn
          });
          const timeouts = normalizeVoiceCallTimeouts({
            raw: body?.timeouts,
            defaults: (voiceDefaults as any)?.timeouts
          });
          const recording = normalizeVoiceCallRecording({
            raw: body?.recording,
            defaults: (voiceDefaults as any)?.recording
          });

          const ttlSecondsRaw = body?.ttlSeconds;
          const ttlSeconds = ttlSecondsRaw === undefined || ttlSecondsRaw === null ? 900 : Number(ttlSecondsRaw);

            const requestIdFromBodyRaw = readTrimmedStringProperty(body?.metadata, 'requestId');
            const requestIdFromBody = requestIdFromBodyRaw ? normalizeRequestId(requestIdFromBodyRaw) : undefined;
            const requestIdFromHeader = readRequestId(req);
            const requestId = requestIdFromBody ?? requestIdFromHeader;

          if (!to || !from || !voiceProvider || !realtimeSpec) {
            writeJson(res, 400, { type: 'error', error: { message: 'Missing required fields', code: 'validation_error' } });
            return true;
          }

          if (recording?.enabled && recording.mode === 'adapter') {
            writeJson(res, 501, { type: 'error', error: { message: 'Adapter-side recording is not implemented', code: 'not_implemented' } });
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
            const idempotencyKeyNormalized = normalizeIdempotencyKey(idempotencyKeyTrimmed);

          let callConfigId: string | undefined;
          let logger: VoiceLogger | undefined;

          try {
              if (idempotencyKeyNormalized) {
                const existing = await store.getIdempotency(idempotencyKeyNormalized);
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
                const lockOk = await store.consumeNonceOnce(`idem:${idempotencyKeyNormalized}`, { ttlSeconds: lockTtlSeconds });
                if (!lockOk) {
                  const start = Date.now();
                  while (Date.now() - start < idempotencyWaitMs) {
                    const ready = await store.getIdempotency(idempotencyKeyNormalized);
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
                hasIdempotencyKey: Boolean(idempotencyKeyNormalized),
                ...(requestId ? { requestId } : {})
              });

              const metadata = (() => {
                const raw = body?.metadata;
                const out = raw && typeof raw === 'object' && !Array.isArray(raw)
                  ? { ...(raw as Record<string, any>) }
                  : undefined;

                const existingRaw = readTrimmedStringProperty(out, 'requestId');
                const existing = existingRaw ? normalizeRequestId(existingRaw) : undefined;
                const requestIdToStore = existing ?? requestId;
                if (!requestIdToStore) return out;
                return { ...(out ?? {}), requestId: requestIdToStore };
              })();

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
                ...(metadata ? { metadata } : {}),
                ...(assistantFirstTurn ? { assistantFirstTurn } : {}),
                ...(timeouts ? { timeouts } : {}),
                ...(recording ? { recording } : {})
              } as any,
              { ttlSeconds }
            );

            const httpBaseUrl = getPublicHttpBaseUrl(req);
            const token = mintVoiceMediaToken({ callConfigId, voiceProvider });
            const mediaWsUrl = toWsUrl(httpBaseUrl, '/voice/media', { token });
            const recordingStatusCallbackUrl =
              recording?.enabled && recording.mode === 'provider'
                ? new URL(`/voice/webhook/recording?callConfigId=${encodeURIComponent(callConfigId)}`, httpBaseUrl).toString()
                : undefined;

            const compat = await providerPlugins.getCompat(voiceProvider);
            const callConfig = await store.getConfig(callConfigId);
            if (!callConfig) {
              throw makeHttpError({ message: 'Failed to load stored call config', statusCode: 500 });
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
                  ...(recordingStatusCallbackUrl ? { recordingStatusCallbackUrl } : {}),
                  providerDefaults
                });
              } catch (error: any) {
                metrics.compatError('outbound_call', voiceProvider);
                throw error;
              }
            })();
            const providerCallId = String(outbound?.providerCallId ?? '').trim();
            if (!providerCallId) {
              throw makeHttpError({ message: 'Voice provider did not return providerCallId', statusCode: 502, code: 'provider_error' });
            }

            safeLog(logger, 'info', 'voice.calls.queued', { callConfigId, voiceProvider, providerCallId, ...(requestId ? { requestId } : {}) });

            try {
              const expiresAtMs = Number((callConfig as any)?.expiresAtMs);
              const ttlRemainingSeconds = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
                ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000))
                : ttlSeconds;

              await store.putConfig(
                { ...(callConfig as any), providerCallId } as any,
                { ttlSeconds: ttlRemainingSeconds }
              );
            } catch (error: any) {
              safeLog(logger, 'warning', 'voice.calls.persist_provider_call_id_failed', {
                callConfigId,
                voiceProvider,
                providerCallId,
                message: error?.message ?? String(error),
                ...(requestId ? { requestId } : {})
              });
            }

            const response = { callConfigId, providerCallId, status: 'queued' };
              if (idempotencyKeyNormalized) {
                await store.putIdempotency(idempotencyKeyNormalized, response, { ttlSeconds });
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
              { ...(callConfigId ? { callConfigId } : {}), voiceProvider, statusCode, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}) }
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

          const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
          const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

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
        let providerDefaults: any | undefined;
        try {
          const manifest = await providerPlugins.getManifest?.(voiceProvider);
          providerDefaults = (manifest as any)?.defaults;
        } catch {}

        wss.handleUpgrade(req, socket, head, (ws: any) => {
          releasePending();
          activeMediaWs += 1;

          const releaseActive = () => {
            activeMediaWs = Math.max(0, activeMediaWs - 1);
          };

          metrics.mediaWsConnected(voiceProvider);
          safeLog(logger, 'info', 'voice.media.connected', { callConfigId, voiceProvider, ...(requestId ? { requestId } : {}) });
          try {
            ws.on?.('close', (code: number) => {
              releaseActive();
              metrics.mediaWsClosed(voiceProvider);
              safeLog(logger, 'info', 'voice.media.closed', { callConfigId, voiceProvider, code: Number(code), ...(requestId ? { requestId } : {}) });
            });
            ws.on?.('error', (err: any) => {
              metrics.mediaWsError(voiceProvider);
              safeLog(logger, 'error', 'voice.media.ws_error', { callConfigId, voiceProvider, message: err?.message ?? String(err), ...(requestId ? { requestId } : {}) });
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
                providerDefaults,
                store,
                logger,
                events: {
                  emit: (event: any) => eventsHub.emit(callConfigId, event)
                },
                metrics
              })
            )
            .catch((err) => {
              metrics.compatError('media_connection', voiceProvider);
              safeLog(logger, 'error', 'voice.media.error', {
                callConfigId,
                voiceProvider,
                ...(requestId ? { requestId } : {}),
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
