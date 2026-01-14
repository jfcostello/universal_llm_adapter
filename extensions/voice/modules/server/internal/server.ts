import type http from 'http';
import type net from 'net';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { createRequire } from 'module';

import { mapErrorToHttp } from '../../../../../modules/transport/index.js';
import { createSignedWsToken, verifySignedWsToken } from '../../../../../modules/security/index.js';
import { calculateBackoffDelay, isPlainObject, makeHttpError, normalizeFlag, readTrimmedStringProperty, sleep, validateE164 } from '../../../../../modules/shared/index.js';
import {
  applyCors,
  applySecurityHeaders,
  assertAuthorized,
  createRateLimiter,
  getClientIp,
  readJsonBody,
  writeHttpUpgradeResponse
} from '../../../../../modules/server/index.js';

import type { VoiceProviderPlugins } from '../../provider-plugins/index.js';
import { createVoiceProviderPlugins } from '../../provider-plugins/index.js';
import {
  VOICE_EXTENSION_PLUGIN_ROOTS,
  StringChunkQueue
} from '../../shared/index.js';
import {
  validateEndMode,
  validateTransferMode,
  validateMaxWaitMs,
  validateCancelOnUserSpeechServer,
  type GracefulEndMode,
  type GracefulTransferMode
} from '../../graceful-mode-validation/index.js';
import type {
  VoiceAssistantFirstTurnConfig,
  VoiceCallConfigStore,
  VoiceCallRecordingConfig,
  VoiceCallTimeoutsConfig
} from '../../call-config-store/index.js';
import { createVoiceCallConfigStoreFromEnv } from '../../call-config-store/index.js';
import { createVoiceCallEventHub, type VoiceCallEventHub, type VoiceCallEventEnvelope } from '../../call-events/index.js';
import { createVoiceMetrics } from '../../observability/index.js';
import { scheduleDeferredAction } from '../../deferred-action/index.js';

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

function findDeepStringValueByKey(options: { value: unknown; key: string; maxDepth: number }): string | undefined {
  const keyLower = String(options.key).toLowerCase();
  const maxDepth = Math.max(0, Math.floor(options.maxDepth));

  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > maxDepth) return undefined;
    if (!value || typeof value !== 'object') return undefined;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }

    for (const [k, v] of Object.entries(value as any)) {
      if (String(k).toLowerCase() === keyLower) {
        if (typeof v === 'string') {
          const trimmed = v.trim();
          if (trimmed) return trimmed;
        }
      }
      const found = visit(v, depth + 1);
      if (found) return found;
    }

    return undefined;
  };

  return visit(options.value, 0);
}

function tryParseWsMessageJson(data: any): any | undefined {
  try {
    const buf = Buffer.from(data as any);
    const text = buf.toString('utf-8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function approxWsMessageBytes(data: any): number {
  return Buffer.byteLength(data as any);
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
  if (!isPlainObject(value)) return undefined;
  return value as Record<string, any>;
}

function readVoiceExtensionDefaults(httpConfig: any): Record<string, any> {
  const extensions = asPlainObject(httpConfig?.extensions);
  const voice = asPlainObject(extensions?.voice);
  return voice ?? {};
}

function readPositiveInt(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  const out = Math.floor(n);
  if (!Number.isFinite(n) || out <= 0) {
    throw makeHttpError({ message: `Invalid ${label}`, statusCode: 400, code: 'validation_error' });
  }
  return out;
}

function readNonNegativeInt(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  const out = Math.floor(n);
  if (!Number.isFinite(n) || out < 0) {
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
  const firstTurnGraceMsRaw =
    raw?.firstTurnGraceMs !== undefined
      ? raw.firstTurnGraceMs
      : defaults?.firstTurnGraceMs;
  const silenceAssistantAudioStartFallbackMsRaw =
    raw?.silenceAssistantAudioStartFallbackMs !== undefined
      ? raw.silenceAssistantAudioStartFallbackMs
      : defaults?.silenceAssistantAudioStartFallbackMs;
  const silenceAssistantAudioEndFallbackMsRaw =
    raw?.silenceAssistantAudioEndFallbackMs !== undefined
      ? raw.silenceAssistantAudioEndFallbackMs
      : defaults?.silenceAssistantAudioEndFallbackMs;

  const out: VoiceCallTimeoutsConfig = {};
  if (callTimeoutMsRaw !== undefined && callTimeoutMsRaw !== null && callTimeoutMsRaw !== '') {
    out.callTimeoutMs = readPositiveInt(callTimeoutMsRaw, 'timeouts.callTimeoutMs');
  }
  if (silenceTimeoutMsRaw !== undefined && silenceTimeoutMsRaw !== null && silenceTimeoutMsRaw !== '') {
    out.silenceTimeoutMs = readPositiveInt(silenceTimeoutMsRaw, 'timeouts.silenceTimeoutMs');
  }
  if (firstTurnGraceMsRaw !== undefined && firstTurnGraceMsRaw !== null && firstTurnGraceMsRaw !== '') {
    out.firstTurnGraceMs = readNonNegativeInt(firstTurnGraceMsRaw, 'timeouts.firstTurnGraceMs');
  }
  if (
    silenceAssistantAudioStartFallbackMsRaw !== undefined &&
    silenceAssistantAudioStartFallbackMsRaw !== null &&
    silenceAssistantAudioStartFallbackMsRaw !== ''
  ) {
    out.silenceAssistantAudioStartFallbackMs = readPositiveInt(
      silenceAssistantAudioStartFallbackMsRaw,
      'timeouts.silenceAssistantAudioStartFallbackMs'
    );
  }
  if (
    silenceAssistantAudioEndFallbackMsRaw !== undefined &&
    silenceAssistantAudioEndFallbackMsRaw !== null &&
    silenceAssistantAudioEndFallbackMsRaw !== ''
  ) {
    out.silenceAssistantAudioEndFallbackMs = readPositiveInt(
      silenceAssistantAudioEndFallbackMsRaw,
      'timeouts.silenceAssistantAudioEndFallbackMs'
    );
  }

  return Object.keys(out).length > 0 ? out : {};
}

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
}): VoiceAssistantFirstTurnConfig | undefined {
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

  const out: VoiceAssistantFirstTurnConfig = {
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
  voicePluginRoots?: string | string[];
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

  let cachedVoiceLoggingModule: { getVoiceLogger: (correlationId?: string) => VoiceLogger; closeVoiceLogger: () => Promise<void> } | undefined;
  const resolveLogger = async (correlationId?: string): Promise<VoiceLogger | undefined> => {
    if (ctx.logging?.getLogger) {
      try {
        // Await to properly catch rejected promises (not just synchronous throws)
        return await ctx.logging.getLogger(correlationId);
      } catch {
        return undefined;
      }
    }

    try {
      if (!cachedVoiceLoggingModule) {
        cachedVoiceLoggingModule = await import('../../logger/index.js');
      }
      return cachedVoiceLoggingModule.getVoiceLogger(correlationId);
    } catch {
      return undefined;
    }
  };

  const safeLog = (
    logger: VoiceLogger | undefined,
    level: 'debug' | 'info' | 'warning' | 'error',
    message: string,
    data?: any
  ): void => {
    try {
      const fn = logger?.[level];
      if (typeof fn === 'function') fn(message, data);
    } catch {}
  };

  const providerPlugins =
    ctx.providerPlugins ??
    createVoiceProviderPlugins({
      pluginRoots: ctx.voicePluginRoots ?? VOICE_EXTENSION_PLUGIN_ROOTS,
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

  const voiceMediaWsDefaults = asPlainObject((voiceDefaults as any)?.mediaWs) ?? {};
  const mediaWsTokenFromMessageTimeoutMs = (() => {
    const raw = (voiceMediaWsDefaults as any)?.tokenFromMessageTimeoutMs;
    if (raw === undefined || raw === null || raw === '') return 5000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 5000;
    const out = Math.floor(n);
    if (out < 0) return 5000;
    return out;
  })();

  let draining = false;
  let activeMediaWs = 0;
  let pendingMediaWs = 0;

  const metrics = createVoiceMetrics({
    enabled: normalizeFlag(process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED, false)
  });

  const voiceEventsDefaults = asPlainObject((voiceDefaults as any)?.events) ?? {};
  const eventsDefaultIncludeDeltas = voiceEventsDefaults.includeDeltas === true;
  const eventsKeepAliveIntervalMs = (() => {
    const raw = (voiceEventsDefaults as any)?.keepAliveIntervalMs;
    if (raw === undefined || raw === null || raw === '') return 15000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 15000;
    const out = Math.floor(n);
    if (out <= 0) return 0;
    return out;
  })();
  const eventsMaxWriteQueueBytes = (() => {
    const raw = (voiceEventsDefaults as any)?.maxWriteQueueBytes;
    if (raw === undefined || raw === null || raw === '') return 256 * 1024;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 256 * 1024;
    const out = Math.floor(n);
    if (out <= 0) return 256 * 1024;
    return out;
  })();
  const recordingProxyTimeoutMs = (() => {
    const raw = String(process.env.LLM_ADAPTER_VOICE_RECORDING_PROXY_TIMEOUT_MS ?? '').trim();
    if (!raw) return 30000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 30000;
    const out = Math.floor(n);
    if (out <= 0) return 30000;
    return out;
  })();

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
      ...(callTtlMs !== undefined ? { callTtlMs } : {}),
      onSaturation: ({ callConfigId, maxActiveCalls, activeCalls }) => {
        void (async () => {
          try {
            const logger = await resolveLogger(callConfigId);
            safeLog(logger, 'warning', 'voice.call_events.saturated', { callConfigId, maxActiveCalls, activeCalls });
          } catch {}
        })();
      }
    });
  })();

  // Mode types are imported from ../../graceful-mode-validation/index.js
  // type GracefulEndMode = 'immediate' | 'after_assistant_audio' | 'after_playback';
  // type GracefulTransferMode = 'immediate' | 'after_playback';

  const emitCallEvent = (callConfigId: string, event: any): void => {
    eventsHub.emit(callConfigId, event);
  };

  const pendingEndRequests = new Map<string, { cancel: () => void }>();
  const pendingTransferRequests = new Map<string, { cancel: () => void }>();

  const close = async () => {
    draining = true;
    const clients: any[] = Array.from(wss.clients);
    for (const client of clients) {
      try { client.terminate(); } catch {}
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    activeMediaWs = 0;
    pendingMediaWs = 0;
    for (const pending of pendingEndRequests.values()) {
      try {
        pending.cancel();
      } catch {}
    }
    pendingEndRequests.clear();
    for (const pending of pendingTransferRequests.values()) {
      try {
        pending.cancel();
      } catch {}
    }
    pendingTransferRequests.clear();
    try {
      eventsHub.close();
    } catch {}
    try {
      await storeInit.close?.();
    } catch {}
    try {
      await cachedVoiceLoggingModule?.closeVoiceLogger?.();
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
          let webhookBodyText: string | undefined;
          let webhookBody: any | undefined;
          if (method === 'POST') {
            const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
            if (contentType.includes('application/x-www-form-urlencoded')) {
              webhookBodyText = await readTextBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });
              if (webhookBodyText) {
                const form = new URLSearchParams(webhookBodyText);
                for (const [k, v] of form.entries()) {
                  params[String(k)] = String(v);
                }
              }
            } else if (contentType.includes('application/json') || contentType.includes('+json')) {
              const bodyText = await readTextBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });
              webhookBodyText = bodyText;
              const raw = bodyText.trim();
              if (!raw) {
                webhookBody = {};
              } else {
                try {
                  webhookBody = JSON.parse(raw);
                } catch {}
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
                await validateWebhookRequest({
                  req,
                  method,
                  url: publicUrl,
                  params,
                  ...(webhookBody !== undefined ? { body: webhookBody } : {}),
                  ...(webhookBodyText !== undefined ? { bodyText: webhookBodyText } : {}),
                  callConfigId,
                  callConfig,
                  voiceProvider,
                  providerDefaults,
                  store,
                  logger,
                  metrics
                });
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
                return await compat.createWebhookResponse({
                  req,
                  callConfigId,
                  callConfig,
                  voiceProvider,
                  mediaWsUrl,
                  params,
                  ...(webhookBody !== undefined ? { body: webhookBody } : {}),
                  ...(webhookBodyText !== undefined ? { bodyText: webhookBodyText } : {}),
                  registry: ctx.registry,
                  store,
                  logger,
                  events: { emit: (event: any) => emitCallEvent(callConfigId, event) },
                  metrics
                });
              } catch (error: any) {
                metrics.compatError('webhook_response', voiceProvider);
                throw error;
              }
            })();
            const status = Number(response?.status ?? 200);
            const headers = (response?.headers && typeof response.headers === 'object') ? response.headers : {};
            const responseBody = String(response?.body ?? '');

            safeLog(logger, 'info', 'voice.webhook.response', { callConfigId, voiceProvider, status, ...(requestId ? { requestId } : {}) });

            res.writeHead(status, headers);
            res.end(responseBody);
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

          let providerDefaults: any | undefined;
          try {
            const manifest = await providerPlugins.getManifest?.(voiceProvider);
            providerDefaults = (manifest as any)?.defaults;
          } catch {}

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
            parsed = await parseRecordingWebhook({ params, callConfigId, callConfig, voiceProvider, providerDefaults });
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

          emitCallEvent(callConfigId, { type: 'voice.recording.ready', recordingId, ...(providerCallId ? { providerCallId } : {}) });

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

          const eventTypes = (() => {
            const raw = String(url.searchParams.get('eventTypes') ?? '').trim();
            if (!raw) return undefined;
            const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
            return parts.length > 0 ? parts.slice(0, 100) : undefined;
          })();

          const sanitizeEventName = (value: string): string =>
            String(value ?? '')
              .replace(/[\r\n]/g, '')
              .trim()
              .slice(0, 128) || 'message';

          let closed = false;
          let keepAliveTimer: any | undefined;
          let sub: { accepted: boolean; replay: VoiceCallEventEnvelope[]; unsubscribe: () => void } | undefined;
          let drainingWrites = false;
          let inFlightBytes = 0;
          const queuedChunks = new StringChunkQueue();
          const queuedEnvelopes: VoiceCallEventEnvelope[] = [];
          let canWriteEvents = false;

          const cleanup = () => {
            if (closed) return;
            closed = true;
            try { if (keepAliveTimer) clearInterval(keepAliveTimer); } catch {}
            try { sub?.unsubscribe(); } catch {}
            try { res.off?.('drain', onDrain); } catch {}
          };

          const closeResponse = () => {
            cleanup();
            try { res.end(); } catch {}
          };

          const checkQueueLimit = () => {
            const pendingBytes = inFlightBytes + queuedChunks.byteLength();
            if (pendingBytes <= eventsMaxWriteQueueBytes) return;
            closeResponse();
          };

          const attachDrain = () => {
            res.on?.('drain', onDrain);
          };

          const flushQueued = () => {
            while (true) {
              const next = queuedChunks.shift();
              if (!next) break;
              const { chunk, bytes } = next;
              try {
                const ok = res.write(chunk);
                if (ok === false) {
                  drainingWrites = true;
                  inFlightBytes = bytes;
                  attachDrain();
                  checkQueueLimit();
                  return;
                }
              } catch {
                closeResponse();
                return;
              }
            }
          };

          function onDrain() {
            if (closed) return;
            drainingWrites = false;
            inFlightBytes = 0;
            try {
              res.off?.('drain', onDrain);
            } catch {}
            flushQueued();
          }

          const writeChunk = (chunk: string) => {
            if (closed) return;

            if (drainingWrites) {
              queuedChunks.push(chunk);
              checkQueueLimit();
              return;
            }

            try {
              const ok = res.write(chunk);
              if (ok === false) {
                drainingWrites = true;
                inFlightBytes = Buffer.byteLength(chunk, 'utf8');
                attachDrain();
                checkQueueLimit();
              }
            } catch {
              closeResponse();
            }
          };

          const writeEvent = (envelope: VoiceCallEventEnvelope) => {
            if (!canWriteEvents) {
              queuedEnvelopes.push(envelope);
              return;
            }
            try {
              const name = sanitizeEventName(envelope.event?.type);
              const data = JSON.stringify(envelope);
              writeChunk(`event: ${name}\ndata: ${data}\n\n`);
            } catch {}
          };

          sub = eventsHub.subscribe(callConfigId, { includeDeltas, ...(eventTypes ? { eventTypes } : {}) }, (evt) => writeEvent(evt));
          if (!sub.accepted) {
            writeJson(res, 503, {
              type: 'error',
              error: { message: 'Voice call events hub is saturated', code: 'call_events_saturated' }
            });
            return true;
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          canWriteEvents = true;

          for (const evt of sub.replay) {
            writeEvent(evt);
          }
          for (const evt of queuedEnvelopes) {
            writeEvent(evt);
          }
          queuedEnvelopes.length = 0;

          if (closed) return true;

          if (eventsKeepAliveIntervalMs > 0) {
            keepAliveTimer = setInterval(() => {
              writeChunk(': keepalive\n\n');
            }, eventsKeepAliveIntervalMs);
            if (typeof (keepAliveTimer as any)?.unref === 'function') {
              (keepAliveTimer as any).unref();
            }
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

          const endDefaults = asPlainObject((voiceDefaults as any)?.end) ?? {};
          const defaultMode: GracefulEndMode = (() => {
            const raw = String((endDefaults as any)?.defaultMode ?? '').trim();
            if (raw === 'after_playback') return 'after_playback';
            if (raw === 'after_assistant_audio') return 'after_assistant_audio';
            if (raw === 'immediate') return 'immediate';
            return 'immediate';
          })();
          const defaultMaxWaitMs = (() => {
            const raw = (endDefaults as any)?.defaultMaxWaitMs;
            if (raw === undefined || raw === null || raw === '') return 5000;
            const n = Number(raw);
            if (!Number.isFinite(n)) return 5000;
            const out = Math.floor(n);
            if (out < 0) return 5000;
            return out;
          })();
          const defaultCancelOnUserSpeech = validateCancelOnUserSpeechServer((endDefaults as any)?.defaultCancelOnUserSpeech, false);

          const maxWaitMsLimit = 60000;
          const body = await readJsonBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });

          let mode: GracefulEndMode;
          let maxWaitMs: number;
          let cancelOnUserSpeech: boolean;

          try {
            const modeRaw = body?.mode !== undefined && body?.mode !== null ? String(body.mode).trim() : '';
            mode = validateEndMode(modeRaw || undefined, defaultMode);
            maxWaitMs = validateMaxWaitMs(body?.maxWaitMs, defaultMaxWaitMs, maxWaitMsLimit);
            cancelOnUserSpeech = validateCancelOnUserSpeechServer(body?.cancelOnUserSpeech, defaultCancelOnUserSpeech);
          } catch (err: any) {
            const mapped = mapErrorToHttp(err);
            writeJson(res, mapped.status, mapped.body);
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

          if (mode === 'immediate') {
            // Cancel any pending graceful request for this call before immediate execution
            const pending = pendingEndRequests.get(callConfigId);
            if (pending) {
              pending.cancel();
              pendingEndRequests.delete(callConfigId);
            }
            try {
              await endCall({ callConfigId, callConfig, voiceProvider, providerCallId, providerDefaults });
            } catch (err: any) {
              const mapped = mapErrorToHttp(err);
              writeJson(res, mapped.status, mapped.body);
              return true;
            }
            emitCallEvent(callConfigId, { type: 'voice.call.end_requested', reason: 'client_request', providerCallId });
            writeJson(res, 200, { ok: true, result: 'ended', mode, maxWaitMs, cancelOnUserSpeech, fallback: false });
            return true;
          }

          const eventTypes = (() => {
            const types: string[] = [];
            if (mode === 'after_playback') types.push('voice.playback.drained');
            if (mode === 'after_assistant_audio') types.push('voice.assistant_audio.ended');
            if (cancelOnUserSpeech) types.push('user_speech.started');
            return types;
          })();

          const triggerEvents = (() => {
            const types: string[] = [];
            if (mode === 'after_playback') types.push('voice.playback.drained');
            if (mode === 'after_assistant_audio') types.push('voice.assistant_audio.ended');
            return types;
          })();

          let deferredResult: 'scheduled' | 'noop' | 'executed';
          try {
            deferredResult = await scheduleDeferredAction({
              callConfigId,
              providerCallId,
              voiceProvider,
              eventTypes,
              maxWaitMs,
              cancelOnUserSpeech,
              triggerEvents,
              pendingRequests: pendingEndRequests,
              eventsHub,
              execute: async () => {
                await endCall({ callConfigId, callConfig, voiceProvider, providerCallId, providerDefaults });
              },
              onScheduled: () => {
                emitCallEvent(callConfigId, { type: 'voice.call.end_scheduled', mode, maxWaitMs, cancelOnUserSpeech, providerCallId });
              },
              onExecuted: (reason) => {
                emitCallEvent(callConfigId, { type: 'voice.call.end_requested', reason, providerCallId });
              },
              onCanceled: (reason) => {
                emitCallEvent(callConfigId, { type: 'voice.call.end_canceled', reason, providerCallId });
              },
              onFailed: async (err, reason) => {
                const message = err?.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200);
                const code = err?.code !== undefined ? String(err.code).slice(0, 64) : undefined;
                const statusCode = Number(err?.statusCode ?? err?.status ?? 0) || undefined;
                const logger = await resolveLogger(callConfigId);
                safeLog(logger, 'error', 'voice.calls.end_failed', {
                  callConfigId,
                  voiceProvider,
                  providerCallId,
                  reason,
                  message,
                  ...(code ? { code } : {}),
                  ...(statusCode ? { statusCode } : {})
                });
                emitCallEvent(callConfigId, {
                  type: 'voice.call.end_failed',
                  reason,
                  providerCallId,
                  message,
                  ...(code ? { code } : {}),
                  ...(statusCode ? { statusCode } : {})
                });
              }
            });
          } catch (err: any) {
            // Execution failed when subscription was rejected - return error to client
            const mapped = mapErrorToHttp(err);
            writeJson(res, mapped.status, mapped.body);
            return true;
          }

          if (deferredResult === 'noop') {
            writeJson(res, 200, { ok: true, result: 'noop', mode, maxWaitMs, cancelOnUserSpeech });
            return true;
          }

          if (deferredResult === 'executed') {
            writeJson(res, 200, { ok: true, result: 'ended', mode, maxWaitMs, cancelOnUserSpeech, fallback: true });
            return true;
          }

          writeJson(res, 200, { ok: true, result: 'scheduled', mode, maxWaitMs, cancelOnUserSpeech, fallback: false });
          return true;
        }

        if (
          callPathParts.length === 4 &&
          callPathParts[0] === 'voice' &&
          callPathParts[1] === 'calls' &&
          callPathParts[2] &&
          callPathParts[3] === 'transfer'
        ) {
          const method = (req.method ?? 'GET').toUpperCase();
          if (method !== 'POST') {
            writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed', code: 'method_not_allowed' } });
            return true;
          }

          if (!authConfig?.enabled) {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice call transfer endpoint requires server auth to be enabled', code: 'not_implemented' } });
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

          const transferDefaults = asPlainObject((voiceDefaults as any)?.transfer) ?? {};
          const defaultTimeoutSeconds = (() => {
            const raw = (transferDefaults as any)?.defaultTimeoutSeconds;
            if (raw === undefined || raw === null || raw === '') return 30;
            const n = Number(raw);
            if (!Number.isFinite(n)) return 30;
            const out = Math.floor(n);
            if (out < 1 || out > 600) return 30;
            return out;
          })();
          const defaultMode: GracefulTransferMode = (() => {
            const raw = String((transferDefaults as any)?.defaultMode ?? '').trim();
            if (raw === 'after_playback') return 'after_playback';
            if (raw === 'immediate') return 'immediate';
            return 'immediate';
          })();
          const defaultMaxWaitMs = (() => {
            const raw = (transferDefaults as any)?.defaultMaxWaitMs;
            if (raw === undefined || raw === null || raw === '') return 5000;
            const n = Number(raw);
            if (!Number.isFinite(n)) return 5000;
            const out = Math.floor(n);
            if (out < 0) return 5000;
            return out;
          })();
          const defaultCancelOnUserSpeech = validateCancelOnUserSpeechServer((transferDefaults as any)?.defaultCancelOnUserSpeech, false);

          const maxWaitMsLimit = 60000;
          const body = await readJsonBody(req, { maxBytes: maxRequestBytes, timeoutMs: bodyReadTimeoutMs });

          const targetNumberResult = validateE164(body?.targetNumber);
          if (!targetNumberResult.ok) {
            writeJson(res, 400, { type: 'error', error: { message: targetNumberResult.error, code: 'validation_error' } });
            return true;
          }
          const targetNumber = targetNumberResult.value;

          const callerIdRaw = body?.callerId !== undefined ? String(body.callerId ?? '').trim() : undefined;
          const callerId = callerIdRaw || undefined;

          const timeoutRaw = body?.timeout;
          let timeout: number;
          if (timeoutRaw === undefined || timeoutRaw === null || timeoutRaw === '') {
            timeout = defaultTimeoutSeconds;
          } else {
            const n = Number(timeoutRaw);
            if (!Number.isFinite(n) || n < 1 || n > 600) {
              writeJson(res, 400, { type: 'error', error: { message: 'Invalid timeout (must be 1-600 seconds)', code: 'validation_error' } });
              return true;
            }
            timeout = Math.floor(n);
          }

          let mode: GracefulTransferMode;
          let maxWaitMs: number;
          let cancelOnUserSpeech: boolean;

          try {
            const modeRaw = body?.mode !== undefined && body?.mode !== null ? String(body.mode).trim() : '';
            mode = validateTransferMode(modeRaw || undefined, defaultMode);
            maxWaitMs = validateMaxWaitMs(body?.maxWaitMs, defaultMaxWaitMs, maxWaitMsLimit);
            cancelOnUserSpeech = validateCancelOnUserSpeechServer(body?.cancelOnUserSpeech, defaultCancelOnUserSpeech);
          } catch (err: any) {
            const mapped = mapErrorToHttp(err);
            writeJson(res, mapped.status, mapped.body);
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
          const transferCall = (compat as any)?.transferCall;
          if (typeof transferCall !== 'function') {
            writeJson(res, 501, { type: 'error', error: { message: 'Voice provider does not support call transfer', code: 'not_implemented' } });
            return true;
          }

          if (mode === 'immediate') {
            // Cancel any pending graceful request for this call before immediate execution
            const pending = pendingTransferRequests.get(callConfigId);
            if (pending) {
              pending.cancel();
              pendingTransferRequests.delete(callConfigId);
            }
            try {
              await transferCall({ providerCallId, targetNumber, callerId, timeout, providerDefaults });
            } catch (err: any) {
              const mapped = mapErrorToHttp(err);
              writeJson(res, mapped.status, mapped.body);
              return true;
            }
            emitCallEvent(callConfigId, { type: 'voice.call.transferred', targetNumber, providerCallId });
            writeJson(res, 200, { ok: true, result: 'transferred', targetNumber, mode, maxWaitMs, cancelOnUserSpeech, fallback: false });
            return true;
          }

          const eventTypes = (() => {
            const types: string[] = ['voice.playback.drained'];
            if (cancelOnUserSpeech) types.push('user_speech.started');
            return types;
          })();

          let deferredResult: 'scheduled' | 'noop' | 'executed';
          try {
            deferredResult = await scheduleDeferredAction({
              callConfigId,
              providerCallId,
              voiceProvider,
              eventTypes,
              maxWaitMs,
              cancelOnUserSpeech,
              triggerEvents: ['voice.playback.drained'],
              pendingRequests: pendingTransferRequests,
              eventsHub,
              execute: async () => {
                await transferCall({ providerCallId, targetNumber, callerId, timeout, providerDefaults });
              },
              onScheduled: () => {
                emitCallEvent(callConfigId, { type: 'voice.call.transfer_scheduled', targetNumber, mode, maxWaitMs, cancelOnUserSpeech, providerCallId });
              },
              onExecuted: (reason) => {
                emitCallEvent(callConfigId, { type: 'voice.call.transferred', targetNumber, reason, providerCallId });
              },
              onCanceled: (reason) => {
                emitCallEvent(callConfigId, { type: 'voice.call.transfer_canceled', targetNumber, reason, providerCallId });
              },
              onFailed: async (err, reason) => {
                const message = err?.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200);
                const code = err?.code !== undefined ? String(err.code).slice(0, 64) : undefined;
                const statusCode = Number(err?.statusCode ?? err?.status ?? 0) || undefined;
                const logger = await resolveLogger(callConfigId);
                safeLog(logger, 'error', 'voice.calls.transfer_failed', {
                  callConfigId,
                  voiceProvider,
                  providerCallId,
                  targetNumber,
                  reason,
                  message,
                  ...(code ? { code } : {}),
                  ...(statusCode ? { statusCode } : {})
                });
                emitCallEvent(callConfigId, {
                  type: 'voice.call.transfer_failed',
                  targetNumber,
                  reason,
                  providerCallId,
                  message,
                  ...(code ? { code } : {}),
                  ...(statusCode ? { statusCode } : {})
                });
              }
            });
          } catch (err: any) {
            // Execution failed when subscription was rejected - return error to client
            const mapped = mapErrorToHttp(err);
            writeJson(res, mapped.status, mapped.body);
            return true;
          }

          if (deferredResult === 'noop') {
            writeJson(res, 200, { ok: true, result: 'noop', targetNumber, mode, maxWaitMs, cancelOnUserSpeech });
            return true;
          }

          if (deferredResult === 'executed') {
            writeJson(res, 200, { ok: true, result: 'transferred', targetNumber, mode, maxWaitMs, cancelOnUserSpeech, fallback: true });
            return true;
          }

          writeJson(res, 200, { ok: true, result: 'scheduled', targetNumber, mode, maxWaitMs, cancelOnUserSpeech, fallback: false });
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

          const controller = new AbortController();
          let didClientDisconnect = false;
          let didTimeout = false;

          const handleClientDisconnect = () => {
            didClientDisconnect = true;
            try { controller.abort(); } catch {}
          };
          req.on?.('aborted', handleClientDisconnect);
          req.on?.('close', handleClientDisconnect);
          res.on?.('close', handleClientDisconnect);

          const timeoutId = setTimeout(() => {
            didTimeout = true;
            try { controller.abort(); } catch {}
          }, recordingProxyTimeoutMs);
          if (typeof (timeoutId as any)?.unref === 'function') {
            (timeoutId as any).unref();
          }

          try {
            const upstream = await fetch(downloadUrl, {
              method: 'GET',
              headers: (download?.headers && typeof download.headers === 'object') ? download.headers : undefined,
              signal: controller.signal
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
          } catch (err: any) {
            if (didClientDisconnect) return true;
            if (err?.name === 'AbortError' && didTimeout) {
              if (!res.headersSent) {
                writeJson(res, 502, { type: 'error', error: { message: 'Upstream recording download timed out', code: 'provider_error' } });
              } else {
                try { res.end(); } catch {}
              }
              return true;
            }

            if (err?.name === 'AbortError') {
              if (!res.headersSent) {
                writeJson(res, 502, { type: 'error', error: { message: 'Upstream recording download aborted', code: 'provider_error' } });
              } else {
                try { res.end(); } catch {}
              }
              return true;
            }

            const message = err?.message ? String(err.message).slice(0, 200) : 'Upstream recording download failed';
            writeJson(res, 502, { type: 'error', error: { message, code: 'provider_error' } });
            return true;
          } finally {
            clearTimeout(timeoutId);
            req.off?.('aborted', handleClientDisconnect);
            req.off?.('close', handleClientDisconnect);
            res.off?.('close', handleClientDisconnect);
          }
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
                let attempt = 0;
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

                  const elapsed = Date.now() - start;
                  const remainingMs = Math.max(0, idempotencyWaitMs - elapsed);
                  if (remainingMs <= 0) break;

                  const delayMs = Math.min(calculateBackoffDelay(attempt, 25, 250), remainingMs);
                  attempt += 1;
                  await sleep(delayMs);
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
              ...(requestId ? { requestId } : {}),
              ...(systemPrompt !== undefined ? { systemPrompt } : {})
            });

            const metadataRaw = (body as any)?.metadata;
            const metadataObj =
              metadataRaw === undefined || metadataRaw === null
                ? undefined
                : asPlainObject(metadataRaw);
            if (metadataRaw !== undefined && metadataRaw !== null && !metadataObj) {
              throw makeHttpError({ message: 'Invalid metadata', statusCode: 400, code: 'validation_error' });
            }

            const metadata = (() => {
              const out = metadataObj ? { ...(metadataObj as Record<string, any>) } : undefined;

              const existingRaw = readTrimmedStringProperty(out, 'requestId');
              const existing = existingRaw ? normalizeRequestId(existingRaw) : undefined;
              const requestIdToStore = existing ?? requestId;
              if (!requestIdToStore) return out;
              return { ...(out ?? {}), requestId: requestIdToStore };
            })();

            const providerConfigRaw = (body as any)?.providerConfig;
            const providerConfig =
              providerConfigRaw === undefined || providerConfigRaw === null
                ? undefined
                : asPlainObject(providerConfigRaw);
            if (providerConfigRaw !== undefined && providerConfigRaw !== null && !providerConfig) {
              throw makeHttpError({ message: 'Invalid providerConfig', statusCode: 400, code: 'validation_error' });
            }

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
                ...(providerConfig ? { providerConfig } : {}),
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

            safeLog(logger, 'info', 'voice.calls.queued', {
              callConfigId,
              voiceProvider,
              providerCallId,
              ...(requestId ? { requestId } : {}),
              ...(systemPrompt !== undefined ? { systemPrompt } : {})
            });

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

              // This is a first-class reliability problem: without a persisted providerCallId, call control and
              // recording retrieval may be broken. Attempt best-effort cleanup and fail the request.
              try {
                const endCall = (compat as any)?.endCall;
                if (typeof endCall === 'function') {
                  await endCall({ callConfigId, callConfig, voiceProvider, providerCallId, providerDefaults });
                }
              } catch (endErr: any) {
                safeLog(logger, 'error', 'voice.calls.cleanup_end_call_failed', {
                  callConfigId,
                  voiceProvider,
                  providerCallId,
                  message: endErr?.message ?? String(endErr),
                  ...(requestId ? { requestId } : {})
                });
              }

              try {
                await store.deleteConfig(callConfigId);
              } catch {}

              throw makeHttpError({
                message: 'Failed to persist providerCallId for outbound call',
                statusCode: 500,
                code: 'provider_call_id_persist_failed'
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
              {
                ...(callConfigId ? { callConfigId } : {}),
                voiceProvider,
                statusCode,
                ...(code ? { code } : {}),
                ...(requestId ? { requestId } : {}),
                ...(systemPrompt !== undefined ? { systemPrompt } : {})
              }
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

        const beginMediaSession = (options: {
          wsReal: any;
          wsForCompat: any;
          callConfigId: string;
          callConfig: any;
          voiceProvider: string;
          requestId?: string;
          logger: VoiceLogger | undefined;
          compat: any;
          providerDefaults?: any;
        }) => {
          releasePending();
          activeMediaWs += 1;

          const releaseActive = () => {
            activeMediaWs = Math.max(0, activeMediaWs - 1);
          };

          metrics.mediaWsConnected(options.voiceProvider);
          safeLog(options.logger, 'info', 'voice.media.connected', {
            callConfigId: options.callConfigId,
            voiceProvider: options.voiceProvider,
            ...(options.requestId ? { requestId: options.requestId } : {})
          });
          try {
            options.wsReal.on?.('close', (code: number) => {
              releaseActive();
              metrics.mediaWsClosed(options.voiceProvider);
              safeLog(options.logger, 'info', 'voice.media.closed', {
                callConfigId: options.callConfigId,
                voiceProvider: options.voiceProvider,
                code: Number(code),
                ...(options.requestId ? { requestId: options.requestId } : {})
              });
            });
            options.wsReal.on?.('error', (err: any) => {
              metrics.mediaWsError(options.voiceProvider);
              safeLog(options.logger, 'error', 'voice.media.ws_error', {
                callConfigId: options.callConfigId,
                voiceProvider: options.voiceProvider,
                message: err?.message ?? String(err),
                ...(options.requestId ? { requestId: options.requestId } : {})
              });
            });
          } catch {}

          void Promise.resolve()
            .then(() =>
              options.compat.handleMediaConnection({
                ws: options.wsForCompat,
                req,
                callConfigId: options.callConfigId,
                callConfig: options.callConfig,
                voiceProvider: options.voiceProvider,
                registry: ctx.registry,
                providerDefaults: options.providerDefaults,
                store,
                logger: options.logger,
                events: {
                  emit: (event: any) => emitCallEvent(options.callConfigId, event)
                },
                metrics
              })
            )
            .catch((err: any) => {
              metrics.compatError('media_connection', options.voiceProvider);
              safeLog(options.logger, 'error', 'voice.media.error', {
                callConfigId: options.callConfigId,
                voiceProvider: options.voiceProvider,
                ...(options.requestId ? { requestId: options.requestId } : {}),
                code: err?.code !== undefined ? String(err.code) : undefined,
                message: err?.message ?? 'Media handler failed'
              });
              try { options.wsReal.close(); } catch {}
            });
        };

        const urlToken = String(url.searchParams.get('token') ?? '').trim();
        if (urlToken) {
          const verified = verifyVoiceMediaToken(urlToken);
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
            beginMediaSession({
              wsReal: ws,
              wsForCompat: ws,
              callConfigId,
              callConfig,
              voiceProvider,
              requestId,
              logger,
              compat,
              providerDefaults
            });
          });

          return true;
        }

        // Some providers cannot preserve WS URL query parameters. Allow the token to be provided
        // via the first WS message (e.g. `voiceMediaToken`) before delegating to the compat.
        if (mediaWsTokenFromMessageTimeoutMs <= 0) {
          writeHttpUpgradeResponse(socket, 401, 'Unauthorized', 'Unauthorized');
          socket.destroy();
          return true;
        }

        if (activeMediaWs + pendingMediaWs >= mediaWsMaxConcurrentSessions) {
          writeHttpUpgradeResponse(socket, 503, 'Service Unavailable', 'Service Unavailable');
          socket.destroy();
          return true;
        }

        pendingMediaWs += 1;
        pendingReserved = true;
        wss.handleUpgrade(req, socket, head, (ws: any) => {
          const tokenKey = 'voiceMediaToken';
          const maxDepth = 8;
          const maxBufferedBytes = Math.min(256 * 1024, Math.max(0, Math.floor(mediaWsMaxMessageBytes)));

          let buffered: any[][] = [];
          let bufferedBytes = 0;
          let bufferFlushed = false;
          let bufferingEnabled = true;

          const messageListeners: Array<(...args: any[]) => void> = [];

          let tokenResolved = false;
          let resolveToken: ((token: string) => void) | undefined;
          let rejectToken: ((error: any) => void) | undefined;
          const tokenPromise = new Promise<string>((resolve, reject) => {
            resolveToken = resolve;
            rejectToken = reject;
          });

          const closeWith = (code: number, reason: string) => {
            try { ws.close(code, reason); } catch {}
          };

          const timeout = setTimeout(() => {
            closeWith(1008, 'Unauthorized');
            rejectToken?.(new Error('missing_ws_token'));
          }, Math.floor(mediaWsTokenFromMessageTimeoutMs));
          if (typeof (timeout as any)?.unref === 'function') {
            (timeout as any).unref();
          }

          const flushBufferTo = (cb: (...args: any[]) => void) => {
            if (bufferFlushed) return;
            bufferFlushed = true;
            bufferingEnabled = false;
            const items = buffered;
            buffered = [];
            bufferedBytes = 0;
            for (const args of items) {
              try { cb(...args); } catch {}
            }
          };

          const wsProxy: any = {
            get readyState() {
              return ws.readyState;
            },
            send: (...args: any[]) => ws.send(...args),
            close: (code?: number, reason?: string) => ws.close(code, reason),
            terminate: () => ws.terminate?.(),
            on: (event: string, cb: (...args: any[]) => void) => {
              if (event === 'message') {
                messageListeners.push(cb);
                flushBufferTo(cb);
                return wsProxy;
              }
              ws.on?.(event, cb);
              return wsProxy;
            },
            off: (event: string, cb: (...args: any[]) => void) => {
              if (event === 'message') {
                const idx = messageListeners.indexOf(cb);
                if (idx >= 0) messageListeners.splice(idx, 1);
                return wsProxy;
              }
              ws.off?.(event, cb);
              return wsProxy;
            },
            once: (event: string, cb: (...args: any[]) => void) => {
              if (event === 'message') {
                const wrapper = (...args: any[]) => {
                  wsProxy.off('message', wrapper);
                  cb(...args);
                };
                wsProxy.on('message', wrapper);
                return wsProxy;
              }
              ws.once?.(event, cb);
              return wsProxy;
            },
            emit: (...args: any[]) => ws.emit?.(...args)
          };

          const onMessage = (...args: any[]) => {
            const data = args[0];

            if (bufferingEnabled) {
              buffered.push(args);
              bufferedBytes += approxWsMessageBytes(data);
              if (bufferedBytes > maxBufferedBytes) {
                closeWith(1009, 'Message too large');
                return;
              }
            }

            if (messageListeners.length > 0) {
              for (const cb of messageListeners) {
                try { cb(...args); } catch {}
              }
            }

            if (!tokenResolved) {
              const parsed = tryParseWsMessageJson(data);
              const token = parsed
                ? findDeepStringValueByKey({ value: parsed, key: tokenKey, maxDepth })
                : undefined;
              if (token) {
                tokenResolved = true;
                clearTimeout(timeout);
                resolveToken?.(token);
              }
            }
          };

          ws.on?.('message', onMessage);
          ws.on?.('close', () => {
            clearTimeout(timeout);
            rejectToken?.(new Error('ws_closed'));
          });
          ws.on?.('error', (err: any) => {
            clearTimeout(timeout);
            rejectToken?.(err ?? new Error('ws_error'));
          });

          void (async () => {
            let token: string;
            try {
              token = await tokenPromise;
            } catch {
              releasePending();
              return;
            }

            const verified = verifyVoiceMediaToken(token);
            if (!verified.ok) {
              releasePending();
              closeWith(1008, 'Unauthorized');
              return;
            }

            const { callConfigId, voiceProvider, nonce, exp } = verified.payload;

            const nowSeconds = Math.floor(Date.now() / 1000);
            const ttlSeconds = Math.max(1, Math.ceil(exp - nowSeconds));
            const nonceOk = await store.consumeNonceOnce(nonce, { ttlSeconds });
            if (!nonceOk) {
              const logger = await resolveLogger(callConfigId);
              safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'nonce_replay' });
              releasePending();
              closeWith(1008, 'Unauthorized');
              return;
            }

            const callConfig = await store.getConfig(callConfigId);
            if (!callConfig) {
              const logger = await resolveLogger(callConfigId);
              safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'unknown_call_config' });
              releasePending();
              closeWith(1008, 'Not Found');
              return;
            }

            const requestIdFromConfig = readTrimmedStringProperty((callConfig as any)?.metadata, 'requestId');
            const requestId = requestIdFromConfig ? normalizeRequestId(requestIdFromConfig) : undefined;

            if (String((callConfig as any).voiceProvider ?? '') !== voiceProvider) {
              const logger = await resolveLogger(callConfigId);
              safeLog(logger, 'warning', 'voice.media.rejected', { callConfigId, voiceProvider, reason: 'voice_provider_mismatch' });
              releasePending();
              closeWith(1008, 'Unauthorized');
              return;
            }

            const logger = await resolveLogger(callConfigId);
            const compat = await providerPlugins.getCompat(voiceProvider);
            let providerDefaults: any | undefined;
            try {
              const manifest = await providerPlugins.getManifest?.(voiceProvider);
              providerDefaults = (manifest as any)?.defaults;
            } catch {}

            // Ensure downstream compats that verify the token via `req.url` still work.
            const injected = parseUrl(req.url) ?? new URL('/voice/media', 'http://localhost');
            injected.searchParams.set('token', token);
            req.url = `${injected.pathname}${injected.search}`;

            beginMediaSession({
              wsReal: ws,
              wsForCompat: wsProxy,
              callConfigId,
              callConfig,
              voiceProvider,
              requestId,
              logger,
              compat,
              providerDefaults
            });
          })().catch(() => {
            releasePending();
            closeWith(1011, 'Internal Error');
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
