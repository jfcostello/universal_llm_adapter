import crypto from 'crypto';
import type http from 'http';
import fs from 'fs';
import path from 'path';

import { ProviderExecutionError } from '../../../kernel/index.js';
import { calculateBackoffDelay, makeHttpError } from '../../../modules/shared/index.js';
import { createRealtimeSession } from '../../../modules/realtime/index.js';
import { createTwilioMediaStreamsBridge } from '../../voice-modules/twilio-media-streams/index.js';
import { wrapAssistantFirstTurnEvents } from './internal/assistant-first-turn-events.js';

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function splitMediaWsUrl(mediaWsUrl: string): { wsUrl: string; token: string } {
  const raw = String(mediaWsUrl);
  try {
    const url = new URL(raw);
    const token = String(url.searchParams.get('token') ?? '').trim();
    url.searchParams.delete('token');
    return { wsUrl: url.toString(), token };
  } catch {
    return { wsUrl: raw, token: '' };
  }
}

function buildTwiMLConnectStream(options: { wsUrl: string; parameters: Record<string, string> }): string {
  const wsUrl = escapeXmlAttr(String(options.wsUrl));

  const params = Object.entries(options.parameters)
    .filter(([_, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `      <Parameter name=\"${escapeXmlAttr(String(k))}\" value=\"${escapeXmlAttr(String(v))}\" />`)
    .join('\n');

  return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Connect>\n    <Stream url=\"${wsUrl}\">\n${params}\n    </Stream>\n  </Connect>\n</Response>\n`;
}

function requireVoiceWsTokenSecret(): string {
  const secret = String(process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET ?? '').trim();
  if (!secret) {
    throw new Error('Missing LLM_ADAPTER_VOICE_WS_TOKEN_SECRET');
  }
  return secret;
}

function basicAuthHeader(username: string, password: string): string {
  const raw = `${username}:${password}`;
  const token = Buffer.from(raw, 'utf-8').toString('base64');
  return `Basic ${token}`;
}

function sanitizeFsToken(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 128);
}

function sleepUnref(ms: number): Promise<void> | undefined {
  const durationMs = Math.max(0, Math.floor(ms));
  if (durationMs <= 0) return undefined;

  return new Promise<void>((resolve) => {
    const timeoutId: any = setTimeout(resolve, durationMs);
    if (timeoutId && typeof timeoutId.unref === 'function') {
      try {
        timeoutId.unref();
      } catch {}
    }
  });
}

function makeProviderConfigError(message: string): Error {
  return makeHttpError({ message, statusCode: 500, code: 'provider_config_error' });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // keep timing roughly consistent
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeUnauthorizedError(message: string): Error {
  return makeHttpError({ message, statusCode: 401, code: 'unauthorized' });
}

function computeRequestSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map(k => `${k}${params[k] ?? ''}`).join('');
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export default class TwilioVoiceCompat {
  private async fetchJsonWithRetry(options: {
    url: string;
    headers: Record<string, string>;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }): Promise<any> {
    const maxRetries = Math.max(0, Math.floor(options.maxRetries));
    const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs));
    const maxDelayMs = Math.max(0, Math.floor(options.maxDelayMs));

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.fetchJson(options.url, options.headers);
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : undefined;
        const retryable = status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
        if (!retryable || attempt >= maxRetries) {
          throw err;
        }

        const delayMs = calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs);
        await (sleepUnref(delayMs) ?? Promise.resolve());
        attempt += 1;
      }
    }
  }

  private async fetchJson(url: string, headers: Record<string, string>): Promise<any> {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error: any = new Error(`Request failed (${res.status})`);
      error.status = res.status;
      error.body = text;
      throw error;
    }

    try {
      return await res.json();
    } catch (err: any) {
      const error: any = new Error('Malformed response: invalid JSON');
      error.status = res.status;
      error.cause = err;
      throw error;
    }
  }

  private async fetchPaginatedJson(options: {
    initialUrl: string;
    headers: Record<string, string>;
    apiBaseUrl: string;
    maxPages: number;
    retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  }): Promise<{ pages: any[] }> {
    const pages: any[] = [];
    let url: string | null = options.initialUrl;
    const maxPages = Math.max(1, Math.floor(options.maxPages));
    const seen = new Set<string>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!url) break;

      if (pages.length >= maxPages) {
        break;
      }

      if (seen.has(url)) {
        break;
      }
      seen.add(url);

      const json = await this.fetchJsonWithRetry({
        url,
        headers: options.headers,
        ...options.retry
      });
      pages.push(json);

      const nextRaw = (json as any)?.next_page_uri;
      const next = typeof nextRaw === 'string' ? nextRaw.trim() : '';
      if (!next) break;

      url = next.startsWith('http://') || next.startsWith('https://')
        ? next
        : `${options.apiBaseUrl.replace(/\/+$/g, '')}${next.startsWith('/') ? '' : '/'}${next}`;
    }

    return { pages };
  }

  private writeJsonFile(filePath: string, data: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async persistCallLogs(options: {
    callConfigId: string;
    providerCallId: string;
    providerDefaults?: any;
    logger?: any;
  }): Promise<void> {
    const providerCallId = String(options.providerCallId ?? '').trim();
    if (!providerCallId) return;

    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const accountSid = String((defaults as any).accountSid ?? '').trim();
    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!accountSid || !authToken) {
      // Best-effort: if credentials are missing, skip call log capture.
      return;
    }

    const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';

    const headers = { Authorization: basicAuthHeader(accountSid, authToken) };

    let stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      const { createIsoFilenameStamp } = await import('../../../modules/logging/index.js');
      stamp = createIsoFilenameStamp();
    } catch {
      // best-effort
    }

    const dirName = `call-${sanitizeFsToken(providerCallId)}-${stamp}`;
    const callDir = path.join(process.cwd(), 'logs', 'voice', 'twilio', dirName);
    fs.mkdirSync(callDir, { recursive: true });

    const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
    const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}/Events.json`;
    const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}/Recordings.json`;
    const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}/Debugger/Events.json`;

    const maxPages = (() => {
      const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_PAGES;
      const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
    })();
    const retry = {
      maxRetries: (() => {
        const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_RETRIES;
        const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
      })(),
      baseDelayMs: (() => {
        const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_BASE_DELAY_MS;
        const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 250;
      })(),
      maxDelayMs: (() => {
        const raw = process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_MAX_DELAY_MS;
        const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2000;
      })()
    };

    const safeLog = (level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any) => {
      try {
        const fn = options.logger?.[level];
        if (typeof fn === 'function') fn(message, data);
      } catch {}
    };

    const capture = async (name: string, fn: () => Promise<any>): Promise<void> => {
      try {
        const result = await fn();
        this.writeJsonFile(path.join(callDir, `${name}.json`), result);
      } catch (err: any) {
        // Best-effort: persist the failure so debugging is still possible.
        const status = typeof err?.status === 'number' ? err.status : undefined;
        this.writeJsonFile(path.join(callDir, `${name}.json`), {
          error: {
            message: err?.message ?? String(err),
            ...(status ? { status } : {}),
            ...(err?.body ? { body: String(err.body).slice(0, 10_000) } : {})
          }
        });

        safeLog('warning', `voice.twilio.call_logs.${name}_failed`, {
          callConfigId: String(options.callConfigId ?? ''),
          providerCallId,
          ...(status ? { status } : {}),
          message: err?.message ?? String(err)
        });
      }
    };

    await capture('call', async () => await this.fetchJsonWithRetry({ url: callUrl, headers, ...retry }));
    await capture('events', async () =>
      await this.fetchPaginatedJson({ initialUrl: eventsUrl, headers, apiBaseUrl, maxPages, retry })
    );
    await capture('recordings', async () =>
      await this.fetchPaginatedJson({ initialUrl: recordingsUrl, headers, apiBaseUrl, maxPages, retry })
    );
    await capture('debugger-events', async () =>
      await this.fetchPaginatedJson({ initialUrl: debuggerEventsUrl, headers, apiBaseUrl, maxPages, retry })
    );

    // Apply retention parity (best-effort).
    try {
      const { applyRetentionOnce, VOICE_MAX_FILES, VOICE_MAX_AGE_DAYS } = await import('../../../modules/logging/index.js');
      applyRetentionOnce(path.join(process.cwd(), 'logs', 'voice', 'twilio'), {
        includeDirs: true,
        match: (d: any) => d.isDirectory() && d.name.startsWith('call-'),
        maxFiles: VOICE_MAX_FILES,
        maxAgeDays: VOICE_MAX_AGE_DAYS,
        exclude: [callDir]
      });
    } catch {
      // best-effort
    }
  }

  async validateWebhookRequest(options: {
    req: http.IncomingMessage;
    url: string;
    params?: Record<string, string>;
    providerDefaults?: any;
  }): Promise<void> {
    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!authToken) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const signatureHeader = options.req?.headers?.['x-twilio-signature'];
    const signature =
      typeof signatureHeader === 'string'
        ? signatureHeader.trim()
        : Array.isArray(signatureHeader)
          ? String(signatureHeader[0] ?? '').trim()
          : '';

    if (!signature) {
      throw makeUnauthorizedError('Unauthorized: missing signature');
    }

    const params = options.params && typeof options.params === 'object' ? options.params : {};
    const expected = computeRequestSignature(authToken, String(options.url), params);
    if (!safeEqual(signature, expected)) {
      throw makeUnauthorizedError('Unauthorized: invalid signature');
    }
  }

  async parseRecordingWebhook(options: {
    params?: Record<string, string>;
    callConfig?: any;
    providerDefaults?: any;
  }): Promise<{ recordingId: string; recordingUrl: string; recordingStatus?: string; providerCallId?: string }> {
    const params = options.params && typeof options.params === 'object' ? options.params : {};

    const recordingId = String(params.RecordingSid ?? params.recordingSid ?? '').trim();
    const recordingUrl = String(params.RecordingUrl ?? params.recordingUrl ?? '').trim();
    const recordingStatus = String(params.RecordingStatus ?? params.recordingStatus ?? '').trim();
    const providerCallId = String(params.CallSid ?? params.callSid ?? options.callConfig?.providerCallId ?? '').trim();

    if (!recordingId || !recordingUrl) {
      throw makeHttpError({ message: 'Missing recording fields', statusCode: 400, code: 'validation_error' });
    }

    let parsed: URL;
    try {
      parsed = new URL(recordingUrl);
    } catch {
      throw makeHttpError({ message: 'Invalid recordingUrl', statusCode: 400, code: 'validation_error' });
    }

    if (parsed.protocol !== 'https:') {
      throw makeHttpError({ message: 'Invalid recordingUrl protocol', statusCode: 400, code: 'validation_error' });
    }

    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';
    let allowedOrigin: string;
    try {
      allowedOrigin = new URL(apiBaseUrl).origin;
    } catch {
      throw makeProviderConfigError('Invalid apiBaseUrl');
    }

    if (parsed.origin !== allowedOrigin) {
      throw makeHttpError({ message: 'Invalid recordingUrl origin', statusCode: 400, code: 'validation_error' });
    }

    return {
      recordingId,
      recordingUrl: parsed.toString(),
      ...(recordingStatus ? { recordingStatus } : {}),
      ...(providerCallId ? { providerCallId } : {})
    };
  }

  async createWebhookResponse(options: {
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    mediaWsUrl: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const callConfigId = String(options.callConfigId);
    const callConfig = options.callConfig ?? {};
    const to = typeof callConfig.to === 'string' ? callConfig.to : '';
    const from = typeof callConfig.from === 'string' ? callConfig.from : '';
    const direction = String(callConfig.direction ?? '');

    const split = splitMediaWsUrl(String(options.mediaWsUrl));

    const xml = buildTwiMLConnectStream({
      wsUrl: split.wsUrl,
      parameters: {
        callConfigId,
        to,
        from,
        direction,
        voiceMediaToken: split.token
      }
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xml
    };
  }

  async handleMediaConnection(options: {
    ws: any;
    req: http.IncomingMessage;
    callConfigId: string;
    callConfig: any;
    voiceProvider: string;
    registry: any;
    providerDefaults?: any;
    events?: { emit?: (event: any) => void };
    logger?: any;
    metrics?: any;
  }): Promise<void> {
	    const callConfig = options.callConfig ?? {};
	    const systemPrompt = callConfig.systemPrompt;
	    const realtimeSpec = callConfig.realtimeSpec ?? {};
	    const requestId = typeof callConfig?.metadata?.requestId === 'string'
	      ? String(callConfig.metadata.requestId).trim()
	      : '';

    const logger = options.logger;
    const safeLog = (level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any) => {
      try {
        const fn = logger?.[level];
        if (typeof fn === 'function') fn(message, data);
      } catch {}
    };
    const metrics = options.metrics;
    const safeMetric = (name: string, ...args: any[]) => {
      try {
        const fn = metrics?.[name];
        if (typeof fn === 'function') fn(...args);
      } catch {}
    };
	    const baseFields = {
	      callConfigId: String(options.callConfigId),
	      voiceProvider: String(options.voiceProvider),
	      ...(requestId ? { requestId } : {})
	    };
	    const systemPromptField = systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {};

    const emitEvent = (event: any) => {
      try {
        const fn = options.events?.emit;
        if (typeof fn === 'function') fn(event);
      } catch {}
    };

    const timeouts = (callConfig as any)?.timeouts;
    const callTimeoutMsRaw = timeouts?.callTimeoutMs;
    const callTimeoutMs = callTimeoutMsRaw === undefined || callTimeoutMsRaw === null || callTimeoutMsRaw === '' ? undefined : Number(callTimeoutMsRaw);
    if (callTimeoutMs !== undefined && (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0)) {
      throw makeHttpError({ message: 'Invalid timeouts.callTimeoutMs', statusCode: 400, code: 'validation_error' });
    }

    const silenceTimeoutMsRaw = timeouts?.silenceTimeoutMs;
    const silenceTimeoutMs = silenceTimeoutMsRaw === undefined || silenceTimeoutMsRaw === null || silenceTimeoutMsRaw === '' ? undefined : Number(silenceTimeoutMsRaw);
    if (silenceTimeoutMs !== undefined && (!Number.isFinite(silenceTimeoutMs) || silenceTimeoutMs <= 0)) {
      throw makeHttpError({ message: 'Invalid timeouts.silenceTimeoutMs', statusCode: 400, code: 'validation_error' });
    }

    const firstTurnGraceMsRaw = (timeouts as any)?.firstTurnGraceMs;
    const firstTurnGraceMsExplicit =
      firstTurnGraceMsRaw === undefined || firstTurnGraceMsRaw === null || firstTurnGraceMsRaw === ''
        ? undefined
        : Number(firstTurnGraceMsRaw);
    if (firstTurnGraceMsExplicit !== undefined && (!Number.isFinite(firstTurnGraceMsExplicit) || firstTurnGraceMsExplicit < 0)) {
      throw makeHttpError({ message: 'Invalid timeouts.firstTurnGraceMs', statusCode: 400, code: 'validation_error' });
    }

    const realtimeProvider = String((realtimeSpec as any)?.provider ?? '').trim();
    const firstTurnGraceMs =
      firstTurnGraceMsExplicit !== undefined
        ? Math.floor(firstTurnGraceMsExplicit)
        : realtimeProvider === 'grok'
          ? 500
          : undefined;

    const silenceAssistantAudioEndFallbackMsRaw = (timeouts as any)?.silenceAssistantAudioEndFallbackMs;
    const silenceAssistantAudioEndFallbackMs =
      silenceAssistantAudioEndFallbackMsRaw === undefined || silenceAssistantAudioEndFallbackMsRaw === null || silenceAssistantAudioEndFallbackMsRaw === ''
        ? undefined
        : Number(silenceAssistantAudioEndFallbackMsRaw);
    if (
      silenceAssistantAudioEndFallbackMs !== undefined &&
      (!Number.isFinite(silenceAssistantAudioEndFallbackMs) || silenceAssistantAudioEndFallbackMs <= 0)
    ) {
      throw makeHttpError({
        message: 'Invalid timeouts.silenceAssistantAudioEndFallbackMs',
        statusCode: 400,
        code: 'validation_error'
      });
    }

    const silenceAssistantAudioStartFallbackMsRaw = (timeouts as any)?.silenceAssistantAudioStartFallbackMs;
    const silenceAssistantAudioStartFallbackMs =
      silenceAssistantAudioStartFallbackMsRaw === undefined || silenceAssistantAudioStartFallbackMsRaw === null || silenceAssistantAudioStartFallbackMsRaw === ''
        ? undefined
        : Number(silenceAssistantAudioStartFallbackMsRaw);
    if (
      silenceAssistantAudioStartFallbackMs !== undefined &&
      (!Number.isFinite(silenceAssistantAudioStartFallbackMs) || silenceAssistantAudioStartFallbackMs <= 0)
    ) {
      throw makeHttpError({
        message: 'Invalid timeouts.silenceAssistantAudioStartFallbackMs',
        statusCode: 400,
        code: 'validation_error'
      });
    }

    const assistantFirstTurnCfg = (callConfig as any)?.assistantFirstTurn;
    const assistantFirstTurnEnabled =
      Boolean(assistantFirstTurnCfg && typeof assistantFirstTurnCfg === 'object' && (assistantFirstTurnCfg as any).enabled === true) &&
      Boolean(String((assistantFirstTurnCfg as any).prompt ?? '').trim());

    let providerCallId: string | undefined;
    let providerStreamId: string | undefined;

    let callTimeoutTimer: any | undefined;
    let silenceTimer: any | undefined;
    let assistantAudioStartFallbackTimer: any | undefined;
    let assistantAudioEndFallbackTimer: any | undefined;
    let waitingForFirstAssistantAudioEnd = assistantFirstTurnEnabled;
    let assistantAudioActive = false;
    let callEnded = false;

    const clearCallTimeout = () => {
      if (callTimeoutTimer) {
        clearTimeout(callTimeoutTimer);
        callTimeoutTimer = undefined;
      }
    };

    const clearSilenceTimeout = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
      }
    };

    const clearAssistantAudioStartFallback = () => {
      if (assistantAudioStartFallbackTimer) {
        clearTimeout(assistantAudioStartFallbackTimer);
        assistantAudioStartFallbackTimer = undefined;
      }
    };

    const clearAssistantAudioEndFallback = () => {
      if (assistantAudioEndFallbackTimer) {
        clearTimeout(assistantAudioEndFallbackTimer);
        assistantAudioEndFallbackTimer = undefined;
      }
    };

    const clearAllTimers = () => {
      clearCallTimeout();
      clearSilenceTimeout();
      clearAssistantAudioStartFallback();
      clearAssistantAudioEndFallback();
    };

	    const requestEndCallOnce = async (reason: string) => {
	      if (callEnded) return;
	      callEnded = true;
	      clearAllTimers();

      emitEvent({ type: 'voice.call.end_requested', reason, ...(providerCallId ? { providerCallId } : {}) });

	      if (providerCallId) {
	        try {
	          await this.endCall({ providerCallId, providerDefaults: options.providerDefaults });
	        } catch (error: any) {
	          safeLog('error', 'voice.call.end_failed', {
	            ...baseFields,
	            ...systemPromptField,
	            providerCallId,
	            reason,
	            message: error?.message ?? String(error),
	            code: error?.code !== undefined ? String(error.code) : undefined,
	            statusCode: Number(error?.statusCode ?? error?.status ?? 0) || undefined
          });
        }
      }

      try { options.ws?.close?.(); } catch {}
    };

    const startSilenceTimer = (timeoutMs: number) => {
      clearSilenceTimeout();
      silenceTimer = setTimeout(() => void requestEndCallOnce('silence_timeout'), Math.floor(timeoutMs));
      if (typeof (silenceTimer as any)?.unref === 'function') {
        try { (silenceTimer as any).unref(); } catch {}
      }
    };

    const resolveAssistantAudioEndFallbackMs = (timeoutMs: number) => {
      if (silenceAssistantAudioEndFallbackMs !== undefined) {
        return Math.floor(silenceAssistantAudioEndFallbackMs);
      }
      return Math.min(2000, Math.max(500, Math.floor(timeoutMs)));
    };

    const resolveAssistantAudioStartFallbackMs = (timeoutMs: number) => {
      if (silenceAssistantAudioStartFallbackMs !== undefined) {
        return Math.floor(silenceAssistantAudioStartFallbackMs);
      }
      // Give the assistant time to start speaking before arming a silence timer (covers missing assistant audio events).
      // Prefer a stable default that is long enough to avoid racing typical greeting audio.
      return Math.max(3000, Math.floor(timeoutMs));
    };

    const scheduleAssistantAudioStartFallback = (timeoutMs: number) => {
      if (callEnded) return;
      if (!waitingForFirstAssistantAudioEnd) return;

      clearAssistantAudioStartFallback();
      const fallbackMs = resolveAssistantAudioStartFallbackMs(timeoutMs);
      assistantAudioStartFallbackTimer = setTimeout(() => {
        waitingForFirstAssistantAudioEnd = false;
        startSilenceTimer(timeoutMs);
      }, fallbackMs);
      if (typeof (assistantAudioStartFallbackTimer as any)?.unref === 'function') {
        (assistantAudioStartFallbackTimer as any).unref();
      }
    };

    const scheduleAssistantAudioEndFallback = (timeoutMs: number) => {
      if (callEnded) return;
      if (!assistantFirstTurnEnabled) return;
      if (!waitingForFirstAssistantAudioEnd) return;
      clearAssistantAudioEndFallback();

      const fallbackMs = resolveAssistantAudioEndFallbackMs(timeoutMs);
      assistantAudioEndFallbackTimer = setTimeout(() => {
        waitingForFirstAssistantAudioEnd = false;
        startSilenceTimer(timeoutMs);
      }, fallbackMs);
      if (typeof (assistantAudioEndFallbackTimer as any)?.unref === 'function') {
        (assistantAudioEndFallbackTimer as any).unref();
      }
    };

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async ({ metadata }) => {
        const existingMetadataRaw = (realtimeSpec as any)?.metadata;
        const existingMetadata =
          existingMetadataRaw && typeof existingMetadataRaw === 'object' && !Array.isArray(existingMetadataRaw)
            ? existingMetadataRaw
            : {};

        const mergedSpec = {
          ...(realtimeSpec as any),
          ...(systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {}),
          metadata: {
            ...existingMetadata,
            callConfigId: String(options.callConfigId),
            voiceProvider: String(options.voiceProvider),
            providerCallMetadata: metadata
          }
        };
        const session = await createRealtimeSession(options.registry, mergedSpec);
        if (!assistantFirstTurnEnabled) return session;

        const prompt = String((assistantFirstTurnCfg as any).prompt);
        const roleRaw = String((assistantFirstTurnCfg as any).role ?? 'user');
        const role = roleRaw === 'system' ? 'system' : 'user';
        const delayMsRaw = (assistantFirstTurnCfg as any).delayMs;
        const delayMs = delayMsRaw === undefined || delayMsRaw === null || delayMsRaw === '' ? 0 : Number(delayMsRaw);
        if (!Number.isFinite(delayMs) || delayMs < 0) {
          throw makeHttpError({ message: 'Invalid assistantFirstTurn.delayMs', statusCode: 400, code: 'validation_error' });
        }

        const originalEvents = session.events.bind(session);
        session.events = wrapAssistantFirstTurnEvents({
          originalEvents,
          onReady: () => {
            void (async () => {
              try {
                const delay = sleepUnref(delayMs);
                if (delay) await delay;
                await session.sendText({ text: prompt, role });
                await session.commit();
                if (silenceTimeoutMs) scheduleAssistantAudioStartFallback(silenceTimeoutMs);
              } catch (error: any) {
                safeLog('error', 'voice.assistant_first_turn.failed', {
                  ...baseFields,
                  message: error?.message ?? String(error),
                  code: error?.code !== undefined ? String(error.code) : undefined
                });
                await requestEndCallOnce('assistant_first_turn_failed');
              }
            })();
          }
        });

        return session;
      },
      security: {
        tokenSecret: requireVoiceWsTokenSecret(),
        tokenMaxTtlSeconds: 86400,
        expectedTokenPayload: {
          purpose: 'voice_media',
          callConfigId: String(options.callConfigId),
          voiceProvider: String(options.voiceProvider)
        }
      },
      ...(firstTurnGraceMs !== undefined ? { limits: { firstTurnGraceMs } } : {}),
      callbacks: {
	        onCallStart: (metadata) => {
	          providerCallId = metadata.callSid;
	          providerStreamId = metadata.streamSid;

	          safeLog('info', 'voice.media.stream_started', {
	            ...baseFields,
	            providerStreamId: metadata.streamSid,
	            providerCallId: metadata.callSid
	          });

          emitEvent({ type: 'voice.call.connected', providerStreamId: metadata.streamSid, providerCallId: metadata.callSid });

          if (callTimeoutMs && !callTimeoutTimer) {
            callTimeoutTimer = setTimeout(() => void requestEndCallOnce('call_timeout'), Math.floor(callTimeoutMs));
            if (typeof (callTimeoutTimer as any)?.unref === 'function') {
              (callTimeoutTimer as any).unref();
            }
          }

          if (silenceTimeoutMs && !assistantFirstTurnEnabled) {
            startSilenceTimer(silenceTimeoutMs);
          }
        },
	        onMark: ({ name, playedMs, kind }) => {
            if (kind !== 'drain') return;
            emitEvent({
              type: 'voice.playback.drained',
              mark: String(name),
              playedMs,
              ...(providerCallId ? { providerCallId } : {})
            });
          },
	        onRealtimeEvent: ({ event, metadata }) => {
	          if (event?.type === 'ready') {
	            safeLog('info', 'voice.realtime.ready', {
	              ...baseFields,
	              providerStreamId: metadata.streamSid,
	              realtimeSessionId: (event as any).sessionId
	            });
	          }

          const type = String((event as any)?.type ?? '');

          if (type === 'assistant_audio.chunk') {
            if (!assistantAudioActive) {
              assistantAudioActive = true;
              emitEvent({ type: 'voice.assistant_audio.started', ...(providerCallId ? { providerCallId } : {}) });
            }
          } else if (type === 'assistant_audio.end') {
            if (assistantAudioActive) assistantAudioActive = false;
            emitEvent({ type: 'voice.assistant_audio.ended', ...(providerCallId ? { providerCallId } : {}) });
          }

          if (
            type === 'ready' ||
            type === 'closed' ||
            type === 'timeout' ||
            type === 'error' ||
            type === 'user_speech.started' ||
            type === 'user_speech.stopped' ||
            type.startsWith('user_transcript.') ||
            type.startsWith('assistant_transcript.')
          ) {
            emitEvent(event);
          }

          if (silenceTimeoutMs) {
            if (type === 'user_speech.started') {
              clearSilenceTimeout();
              clearAssistantAudioStartFallback();
              clearAssistantAudioEndFallback();
            } else if (type === 'assistant_audio.chunk') {
              clearSilenceTimeout();
              clearAssistantAudioStartFallback();
              scheduleAssistantAudioEndFallback(silenceTimeoutMs);
            } else if (type === 'assistant_audio.end') {
              clearAssistantAudioStartFallback();
              clearAssistantAudioEndFallback();
              if (waitingForFirstAssistantAudioEnd) {
                waitingForFirstAssistantAudioEnd = false;
              }
              if (!waitingForFirstAssistantAudioEnd) {
                startSilenceTimer(silenceTimeoutMs);
              }
            }
          }

          if (type === 'closed') {
            clearAllTimers();
          }
        },
	        onError: ({ message, code, metadata }) => {
	          safeLog('error', 'voice.media.bridge_error', {
	            ...baseFields,
	            ...systemPromptField,
	            ...(metadata?.streamSid ? { providerStreamId: metadata.streamSid } : {}),
	            ...(metadata?.callSid ? { providerCallId: metadata.callSid } : {}),
	            code: String(code),
	            message: String(message)
	          });
          safeMetric('compatError', 'media_bridge', baseFields.voiceProvider);
        }
      }
    });

	    try {
	      await bridge.handleConnection(options.ws, options.req);
	    } finally {
	      clearAllTimers();

	      if (providerCallId) {
	        void (async () => {
	          try {
	            await this.persistCallLogs({
	              callConfigId: String(options.callConfigId),
	              providerCallId,
	              providerDefaults: options.providerDefaults,
	              logger
	            });
	          } catch (error: any) {
	            safeLog('warning', 'voice.twilio.call_logs.persist_failed', {
	              ...baseFields,
	              providerCallId,
	              message: error?.message ?? String(error)
	            });
	          }
	        })();
	      }
	    }
	  }

  async createOutboundCall(options: {
    to: string;
    from: string;
    callConfigId: string;
    callConfig?: any;
    mediaWsUrl: string;
    recordingStatusCallbackUrl?: string;
    providerDefaults?: any;
  }): Promise<{ providerCallId: string }> {
    const to = String(options.to ?? '').trim();
    const from = String(options.from ?? '').trim();
    const callConfigId = String(options.callConfigId ?? '').trim();
    if (!to || !from || !callConfigId) {
      throw makeHttpError({ message: 'Missing required fields for outbound call', statusCode: 400, code: 'validation_error' });
    }

    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const accountSid = String((defaults as any).accountSid ?? '').trim();
    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!accountSid || !authToken) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';

    const outbound = (defaults as any).outbound ?? {};
    const mode = String(outbound?.mode ?? 'twiml').trim().toLowerCase();
    const outboundTimeoutMsRaw = outbound?.timeoutMs;
    const outboundTimeoutMs =
      outboundTimeoutMsRaw === undefined || outboundTimeoutMsRaw === null || outboundTimeoutMsRaw === ''
        ? 15000
        : Number(outboundTimeoutMsRaw);
    if (!Number.isFinite(outboundTimeoutMs) || outboundTimeoutMs <= 0) {
      throw makeProviderConfigError('Invalid outbound timeoutMs');
    }

    const form = new URLSearchParams();
    form.set('To', to);
    form.set('From', from);

    const callConfig = options.callConfig ?? {};
    const timeouts = (callConfig as any)?.timeouts;
    const callTimeoutMsRaw = (timeouts as any)?.callTimeoutMs;
    const callTimeoutMs = callTimeoutMsRaw === undefined || callTimeoutMsRaw === null || callTimeoutMsRaw === '' ? undefined : Number(callTimeoutMsRaw);
    if (callTimeoutMs !== undefined) {
      if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
        throw makeHttpError({ message: 'Invalid timeouts.callTimeoutMs', statusCode: 400, code: 'validation_error' });
      }
      const seconds = Math.max(1, Math.ceil(callTimeoutMs / 1000));
      form.set('TimeLimit', String(seconds));
    }

    const recording = (callConfig as any)?.recording;
    const recordingEnabled = Boolean(recording && typeof recording === 'object' && (recording as any).enabled === true);
    const recordingMode = recordingEnabled ? String((recording as any).mode ?? 'provider') : '';
    if (recordingEnabled && recordingMode === 'provider') {
      form.set('Record', 'true');

      const channelsRaw = String((recording as any).channels ?? 'mono').trim().toLowerCase();
      const channels = channelsRaw === 'dual' ? 'dual' : 'mono';
      form.set('RecordingChannels', channels);

      const callbackUrl = String(options.recordingStatusCallbackUrl ?? '').trim();
      if (callbackUrl) {
        form.set('RecordingStatusCallback', callbackUrl);
        form.set('RecordingStatusCallbackEvent', 'completed');
      }
    }

    if (mode === 'url') {
      const baseUrl = String(outbound?.webhookUrl ?? '').trim();
      if (!baseUrl) {
        throw makeProviderConfigError('Missing outbound webhookUrl for url mode');
      }
      const url = new URL(baseUrl);
      url.searchParams.set('callConfigId', callConfigId);
      form.set('Url', url.toString());
    } else if (mode === 'twiml') {
      const split = splitMediaWsUrl(String(options.mediaWsUrl));
      const twiml = buildTwiMLConnectStream({
        wsUrl: split.wsUrl,
        parameters: { callConfigId, to, from, direction: 'outbound', voiceMediaToken: split.token }
      });
      form.set('Twiml', twiml);
    } else {
      throw makeProviderConfigError(`Unsupported outbound mode '${mode}'`);
    }

    const url = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.floor(outboundTimeoutMs));

    let res: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(accountSid, authToken),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        signal: controller.signal
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new ProviderExecutionError('twilio', `Outbound call create timed out after ${Math.floor(outboundTimeoutMs)}ms`, 504);
      }
      const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
      throw new ProviderExecutionError('twilio', `Outbound call create failed${detail}`, 502);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const suffix = text ? `: ${text.slice(0, 500)}` : '';
      throw new ProviderExecutionError('twilio', `Outbound call create failed (${res.status})${suffix}`, res.status, res.status === 429);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new ProviderExecutionError('twilio', 'Malformed response: invalid JSON', res.status);
    }

    const sid = String(data?.sid ?? '').trim();
    if (!sid) {
      throw new ProviderExecutionError('twilio', 'Malformed response: missing sid', res.status);
    }

    return { providerCallId: sid };
  }

  async endCall(options: { providerCallId: string; providerDefaults?: any }): Promise<{ ok: true }> {
    const providerCallId = String(options.providerCallId ?? '').trim();
    if (!providerCallId) {
      throw makeHttpError({ message: 'Missing providerCallId', statusCode: 400, code: 'validation_error' });
    }

    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const accountSid = String((defaults as any).accountSid ?? '').trim();
    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!accountSid || !authToken) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const apiBaseUrlRaw = String((defaults as any).apiBaseUrl ?? 'https://api.twilio.com').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.twilio.com';

    const url = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
    const form = new URLSearchParams();
    form.set('Status', 'completed');

    let res: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(accountSid, authToken),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      });
    } catch (err: any) {
      const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
      throw new ProviderExecutionError('twilio', `Call terminate failed${detail}`, 502);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const suffix = text ? `: ${text.slice(0, 500)}` : '';
      throw new ProviderExecutionError('twilio', `Call terminate failed (${res.status})${suffix}`, res.status, res.status === 429);
    }

    return { ok: true };
  }

  async getRecordingDownloadRequest(options: { callConfigId: string; callConfig: any; providerDefaults?: any }): Promise<{ url: string; headers: Record<string, string> }> {
    const callConfig = options.callConfig ?? {};
    const recording = (callConfig as any)?.recording;
    const providerRecording = recording && typeof recording === 'object' ? (recording as any).providerRecording : undefined;
    const baseUrl = String(providerRecording?.url ?? '').trim();
    if (!baseUrl) {
      throw makeHttpError({ message: 'Recording is not ready', statusCode: 409, code: 'recording_not_ready' });
    }

    const defaultsRaw = options.providerDefaults;
    const defaults =
      defaultsRaw && typeof defaultsRaw === 'object' && !Array.isArray(defaultsRaw)
        ? defaultsRaw
        : {};

    const accountSid = String((defaults as any).accountSid ?? '').trim();
    const authToken = String((defaults as any).authToken ?? '').trim();
    if (!accountSid || !authToken) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const format = String((recording as any)?.format ?? 'mp3').trim().toLowerCase() === 'wav' ? 'wav' : 'mp3';
    const channelsRaw = String((recording as any)?.channels ?? 'mono').trim().toLowerCase();
    const requestedChannels = channelsRaw === 'dual' ? '2' : undefined;

    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw makeHttpError({ message: 'Invalid recording URL', statusCode: 500, code: 'provider_error' });
    }

    if (!url.pathname.endsWith(`.${format}`)) {
      url.pathname = `${url.pathname}.${format}`;
    }
    if (requestedChannels) {
      url.searchParams.set('RequestedChannels', requestedChannels);
    }

    return {
      url: url.toString(),
      headers: { Authorization: basicAuthHeader(accountSid, authToken) }
    };
  }
}
