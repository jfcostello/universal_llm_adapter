import type http from 'http';

import { createAuthenticator, createRateLimiter, getClientIp } from '../../../../../../modules/server/index.js';
import type { AuthContext } from '../../../../../../modules/server/index.js';

import { makeHttpError, normalizeFlag } from '../../../../../../modules/shared/index.js';

import type { VoiceProviderPlugins } from '../../../provider-plugins/index.js';
import { createVoiceProviderPlugins } from '../../../provider-plugins/index.js';
import { VOICE_EXTENSION_PLUGIN_ROOTS } from '../../../shared/index.js';

import type { VoiceCallConfigStore } from '../../../call-config-store/index.js';
import { createVoiceCallConfigStoreFromEnv } from '../../../call-config-store/index.js';

import { createVoiceCallEventHub, type VoiceCallEventHub } from '../../../call-events/index.js';
import { createVoiceMetrics } from '../../../observability/index.js';

import { readVoiceExtensionDefaults } from './config-normalize.js';
import type { VoiceServerContext } from './context.js';
import { createVoiceHttpHandler } from './http-handler.js';
import { createVoiceLoggerResolver } from './logger.js';
import type { VoiceLogging, VoiceServerRegistration } from './types.js';
import { asPlainObject } from './utils-ws.js';
import { createVoiceMediaWs } from './ws-media.js';

export async function createVoiceServerRegistration(ctx: {
  server: http.Server;
  registry: any;
  /**
   * @deprecated Unused. Prefer `voicePluginRoots` or `providerPlugins`.
   */
  pluginsPath?: string;
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
    authorize?: ((ctx: AuthContext, req: http.IncomingMessage) => boolean | Promise<boolean>) | undefined;
  };
}): Promise<VoiceServerRegistration> {
  const storeInit = ctx.store ? { store: ctx.store, close: undefined } : await createVoiceCallConfigStoreFromEnv();
  const store = storeInit.store;
  const httpConfig = ctx.httpConfig ?? {};
  const maxRequestBytes = httpConfig.maxRequestBytes ?? Number.POSITIVE_INFINITY;
  const bodyReadTimeoutMs = httpConfig.bodyReadTimeoutMs ?? 0;
  const authConfig = httpConfig.auth ?? { mode: 'none' };
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
  const authenticator = createAuthenticator(authConfig);

  const voiceLogging = createVoiceLoggerResolver({ logging: ctx.logging });

  const providerPlugins =
    ctx.providerPlugins ??
    createVoiceProviderPlugins({
      pluginRoots: ctx.voicePluginRoots ?? VOICE_EXTENSION_PLUGIN_ROOTS,
      logger: {
        warning: (message: string, data?: any) => {
          void (async () => {
            try {
              const logger = await voiceLogging.resolveLogger();
              voiceLogging.safeLog(logger, 'warning', message, data);
            } catch {}
          })();
        }
      }
    });

  const voiceDefaults = readVoiceExtensionDefaults(httpConfig);

  const assertAuthorizedAndRateLimited = async (req: http.IncomingMessage): Promise<string | undefined> => {
    const authCtx = await authenticator.authenticate(req as any);
    if (authorize) {
      const allowed = await (authorize as any)(authCtx, req);
      if (!allowed) {
        throw makeHttpError({ statusCode: 403, message: 'Forbidden', code: 'forbidden' });
      }
    }
    const clientIp = getClientIp(req, Boolean(rateLimitConfig?.trustProxyHeaders));
    const key = authCtx.subject ?? clientIp ?? 'unknown';
    if (rateLimitConfig?.enabled) {
      rateLimiter.check(key);
    }
    return authCtx.subject;
  };

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
            const logger = await voiceLogging.resolveLogger(callConfigId);
            voiceLogging.safeLog(logger, 'warning', 'voice.call_events.saturated', { callConfigId, maxActiveCalls, activeCalls });
          } catch {}
        })();
      }
    });
  })();

  const emitCallEvent = (callConfigId: string, event: any): void => {
    eventsHub.emit(callConfigId, event);
  };

  const pendingEndRequests = new Map<string, { cancel: () => void }>();
  const pendingTransferRequests = new Map<string, { cancel: () => void }>();

  const handlerCtx: VoiceServerContext = {
    registry: ctx.registry,
    store,
    providerPlugins,
    resolveLogger: voiceLogging.resolveLogger,
    safeLog: voiceLogging.safeLog,
    metrics,
    eventsHub,
    emitCallEvent,
    maxRequestBytes,
    bodyReadTimeoutMs,
    authConfig,
    rateLimitConfig,
    corsConfig,
    securityHeadersEnabled,
    idempotencyWaitMs,
    idempotencyLockTtlSeconds,
    voiceDefaults,
    assertAuthorizedAndRateLimited,
    eventsDefaultIncludeDeltas,
    eventsKeepAliveIntervalMs,
    eventsMaxWriteQueueBytes,
    recordingProxyTimeoutMs,
    pendingEndRequests,
    pendingTransferRequests
  };

  const handleHttp = createVoiceHttpHandler(handlerCtx);
  const mediaWs = createVoiceMediaWs(handlerCtx);

  const close = async () => {
    try {
      await mediaWs.close();
    } catch {}

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
      await voiceLogging.close();
    } catch {}
  };

  return {
    handleHttp,
    handleUpgrade: mediaWs.handleUpgrade,
    close
  };
}

