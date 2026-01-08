import crypto from 'crypto';
import type http from 'http';

import { LruMap, ProviderExecutionError } from '../../../kernel/index.js';
import { safeEqual } from '../../../modules/security/index.js';
import { makeHttpError } from '../../../modules/shared/index.js';

const ENDED_EVENT_DEDUPE = new LruMap<string, true>(20_000, { label: 'voice.vapi.ended_events' });

function shouldEmitEndedEvent(key: string): boolean {
  const id = String(key).trim();
  if (!id) return true;
  if (ENDED_EVENT_DEDUPE.get(id) === true) return false;
  ENDED_EVENT_DEDUPE.set(id, true);
  return true;
}

function makeProviderConfigError(message: string): Error {
  return makeHttpError({ message, statusCode: 500, code: 'provider_config_error' });
}

function makeUnauthorizedError(message: string): Error {
  return makeHttpError({ message, statusCode: 401, code: 'unauthorized' });
}

function readFirstHeader(req: http.IncomingMessage, name: string): string {
  const raw = (req.headers as any)?.[String(name).toLowerCase()];
  const value =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? String(raw[0] ?? '')
        : '';
  return value.trim();
}

function parseBearerToken(value: string): string {
  const raw = String(value).trim();
  if (!raw) return '';
  const match = /^bearer\s+(.+)$/i.exec(raw);
  if (!match) return '';
  return String(match[1]).trim();
}

function normalizePlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function readSettingString(settings: any, name: string, aliases: string[] = []): string | undefined {
  const s = normalizePlainObject(settings);
  const candidates = [name, ...aliases];
  for (const key of candidates) {
    const raw = s[key];
    if (raw === undefined || raw === null) continue;
    const trimmed = String(raw).trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function readSettingNumber(settings: any, name: string, aliases: string[] = []): number | undefined {
  const raw = readSettingString(settings, name, aliases);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function toWebhookUrlFromMediaWsUrl(options: { mediaWsUrl: string; callConfigId: string }): string {
  const callConfigId = String(options.callConfigId).trim();
  const mediaWsUrl = String(options.mediaWsUrl).trim();
  if (!callConfigId || !mediaWsUrl) return '';

  try {
    const url = new URL(mediaWsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/voice/webhook';
    url.search = '';
    url.searchParams.set('callConfigId', callConfigId);
    return url.toString();
  } catch {
    return '';
  }
}

type WebhookAuthBearer = { type: 'bearer'; token: string };
type WebhookAuthHmac = {
  type: 'hmac';
  secretKey: string;
  algorithm: 'sha256' | 'sha512' | 'sha1';
  signatureHeader: string;
  timestampHeader: string;
  signaturePrefix: string;
  includeTimestamp: boolean;
  payloadFormat: string;
  signatureEncoding: 'hex' | 'base64';
  secretIsBase64: boolean;
  toleranceSeconds: number;
};

function parseWebhookAuth(providerDefaults: any): WebhookAuthBearer | WebhookAuthHmac {
  const defaults = normalizePlainObject(providerDefaults);
  const auth = normalizePlainObject(defaults.webhookAuth);
  const type = String(auth.type ?? 'bearer').trim().toLowerCase();

  if (type === 'hmac') {
    const secretKey = String(auth.secretKey ?? '').trim();
    const algorithmRaw = String(auth.algorithm ?? '').trim().toLowerCase();
    const algorithm = algorithmRaw === 'sha512' ? 'sha512' : algorithmRaw === 'sha1' ? 'sha1' : 'sha256';
    if (!secretKey) {
      throw makeProviderConfigError('Missing defaults.webhookAuth.secretKey');
    }
    if (!algorithmRaw) {
      throw makeProviderConfigError('Missing defaults.webhookAuth.algorithm');
    }

    const signatureHeader = String(auth.signatureHeader ?? 'x-signature').trim() || 'x-signature';
    const timestampHeader = String(auth.timestampHeader ?? 'x-timestamp').trim() || 'x-timestamp';
    const signaturePrefix = String(auth.signaturePrefix ?? '').trim();
    const includeTimestamp = auth.includeTimestamp === undefined ? true : Boolean(auth.includeTimestamp);
    const payloadFormat = String(auth.payloadFormat ?? '{timestamp}.{body}');
    const signatureEncodingRaw = String(auth.signatureEncoding ?? 'hex').trim().toLowerCase();
    const signatureEncoding = signatureEncodingRaw === 'base64' ? 'base64' : 'hex';
    const secretIsBase64 = Boolean(auth.secretIsBase64);
    const toleranceSecondsRaw = auth.toleranceSeconds;
    const toleranceSeconds =
      toleranceSecondsRaw === undefined || toleranceSecondsRaw === null || toleranceSecondsRaw === ''
        ? 300
        : Number(toleranceSecondsRaw);
    const toleranceSecondsNormalized = Number.isFinite(toleranceSeconds) && toleranceSeconds >= 0 ? Math.floor(toleranceSeconds) : 300;

    return {
      type: 'hmac',
      secretKey,
      algorithm,
      signatureHeader,
      timestampHeader,
      signaturePrefix,
      includeTimestamp,
      payloadFormat,
      signatureEncoding,
      secretIsBase64,
      toleranceSeconds: toleranceSecondsNormalized
    };
  }

  const token = String(auth.token ?? '').trim();
  if (!token) {
    throw makeProviderConfigError('Missing defaults.webhookAuth.token');
  }
  return { type: 'bearer', token };
}

function resolveSecretBytes(auth: WebhookAuthHmac): Buffer {
  return auth.secretIsBase64
    ? Buffer.from(auth.secretKey, 'base64')
    : Buffer.from(auth.secretKey, 'utf8');
}

function buildHmacPayload(options: { format: string; bodyText: string; timestamp: string; method: string; url: string; messageId: string }): string {
  return String(options.format)
    .replaceAll('{body}', options.bodyText)
    .replaceAll('{timestamp}', options.timestamp)
    .replaceAll('{method}', options.method)
    .replaceAll('{url}', options.url)
    .replaceAll('{svix-id}', options.messageId);
}

function computeHmacSignature(options: { auth: WebhookAuthHmac; payload: string }): string {
  const key = resolveSecretBytes(options.auth);
  const digest = crypto.createHmac(options.auth.algorithm, key).update(options.payload, 'utf8').digest();
  return options.auth.signatureEncoding === 'base64' ? digest.toString('base64') : digest.toString('hex');
}

function coerceRealtimeSpec(value: any): any {
  const spec = normalizePlainObject(value);
  return spec;
}

function resolveModel(spec: any): string {
  const model = String(spec.model ?? '').trim();
  if (model) return model;
  return 'gpt-4o-mini';
}

function resolveTranscriber(spec: any, settings: any): { provider: string; model: string } {
  const transcription = normalizePlainObject(spec.transcription);
  const provider = String(transcription.provider ?? readSettingString(settings, 'transcriberProvider', ['transcriber_provider']) ?? 'deepgram').trim() || 'deepgram';
  const model = String(transcription.model ?? readSettingString(settings, 'transcriberModel', ['transcriber_model']) ?? 'nova-2').trim() || 'nova-2';
  return { provider, model };
}

function normalizeRecordingChannels(value: any): 'mono' | 'dual' {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'dual' ? 'dual' : 'mono';
}

function resolveRecordingDownloadUrl(call: any, channels: 'mono' | 'dual'): string {
  const callObj = normalizePlainObject(call);
  const artifact = normalizePlainObject(callObj.artifact);

  const recordingFromArtifact = artifact.recording;
  const recObj = normalizePlainObject(recordingFromArtifact);
  const monoObj = normalizePlainObject(recObj.mono);

  const candidates: any[] = [];
  if (channels === 'dual') {
    candidates.push(recObj.stereoUrl, artifact.stereoRecordingUrl, callObj.stereoRecordingUrl);
  }
  candidates.push(monoObj.combinedUrl, recordingFromArtifact, artifact.recordingUrl, callObj.recordingUrl);
  if (channels !== 'dual') {
    candidates.push(recObj.stereoUrl, artifact.stereoRecordingUrl, callObj.stereoRecordingUrl);
  }

  for (const candidate of candidates) {
    const url = typeof candidate === 'string' ? candidate.trim() : '';
    if (url) return url;
  }
  return '';
}

export default class VapiVoiceCompat {
  async validateWebhookRequest(options: {
    req: http.IncomingMessage;
    method?: string;
    url?: string;
    bodyText?: string;
    providerDefaults?: any;
  }): Promise<void> {
    const req = options.req;
    const auth = parseWebhookAuth(options.providerDefaults);

    if (auth.type === 'bearer') {
      const header = readFirstHeader(req, 'authorization');
      const provided = parseBearerToken(header);
      if (!provided) {
        throw makeUnauthorizedError('Unauthorized: missing Authorization bearer token');
      }
      if (!safeEqual(provided, auth.token)) {
        throw makeUnauthorizedError('Unauthorized: invalid Authorization bearer token');
      }
      return;
    }

    const signatureHeaderValue = readFirstHeader(req, auth.signatureHeader);
    const timestampHeaderValue = readFirstHeader(req, auth.timestampHeader);
    const signatureRaw = signatureHeaderValue.trim();
    if (!signatureRaw) {
      throw makeUnauthorizedError('Unauthorized: missing signature');
    }

    const signature = auth.signaturePrefix && signatureRaw.startsWith(auth.signaturePrefix)
      ? signatureRaw.slice(auth.signaturePrefix.length)
      : signatureRaw;

    const timestamp = auth.includeTimestamp ? timestampHeaderValue.trim() : '';
    if (auth.includeTimestamp && !timestamp) {
      throw makeUnauthorizedError('Unauthorized: missing timestamp');
    }

    if (auth.includeTimestamp && auth.toleranceSeconds > 0) {
      const n = Number(timestamp);
      if (!Number.isFinite(n)) {
        throw makeUnauthorizedError('Unauthorized: invalid timestamp');
      }
      const now = Date.now();
      const tsMs = n > 1e12 ? n : n * 1000;
      const diffSeconds = Math.abs(now - tsMs) / 1000;
      if (diffSeconds > auth.toleranceSeconds) {
        throw makeUnauthorizedError('Unauthorized: webhook timestamp outside tolerance');
      }
    }

    const bodyText = String(options.bodyText ?? '');
    const method = String(options.method ?? req.method ?? 'POST').toUpperCase();
    const url = String(options.url ?? '').trim();
    const messageId = readFirstHeader(req, 'svix-id');

    const payload = buildHmacPayload({
      format: auth.payloadFormat,
      bodyText,
      timestamp,
      method,
      url,
      messageId
    });
    const expected = computeHmacSignature({ auth, payload });

    if (!safeEqual(signature, expected)) {
      throw makeUnauthorizedError('Unauthorized: invalid signature');
    }
  }

  async createOutboundCall(options: {
    to: string;
    from: string;
    callConfigId: string;
    callConfig?: any;
    voiceProvider: string;
    mediaWsUrl: string;
    providerDefaults?: any;
  }): Promise<{ providerCallId: string }> {
    const to = String(options.to ?? '').trim();
    const from = String(options.from ?? '').trim();
    const callConfigId = String(options.callConfigId ?? '').trim();
    if (!to || !from || !callConfigId) {
      throw makeHttpError({ message: 'Missing required fields for outbound call', statusCode: 400, code: 'validation_error' });
    }

    const defaults = normalizePlainObject(options.providerDefaults);
    const apiKey = String(defaults.apiKey ?? '').trim();
    const apiBaseUrlRaw = String(defaults.apiBaseUrl ?? 'https://api.vapi.ai').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.vapi.ai';
    if (!apiKey) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const callConfig = normalizePlainObject(options.callConfig);
    const realtimeSpec = coerceRealtimeSpec(callConfig.realtimeSpec);
    const provider = String(realtimeSpec.provider ?? '').trim();
    if (provider !== 'vapi') {
      throw makeHttpError({ message: 'Unsupported realtimeSpec.provider for vapi voice calls', statusCode: 400, code: 'validation_error' });
    }

    const settings = normalizePlainObject(realtimeSpec.settings);

    const modelProvider = readSettingString(settings, 'modelProvider', ['model_provider']) ?? 'openai';
    const model = resolveModel(realtimeSpec);
    const voiceProvider = readSettingString(settings, 'voiceProvider', ['voice_provider']) ?? 'openai';
    const voice = readSettingString(settings, 'voice') ?? 'alloy';
    const temperature = readSettingNumber(settings, 'temperature');
    const speed = readSettingNumber(settings, 'speed');
    const transcriber = resolveTranscriber(realtimeSpec, settings);

    const messages: any[] = [];
    const systemPrompt = String(callConfig.systemPrompt ?? '').trim();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    const assistantFirstTurn = normalizePlainObject(callConfig.assistantFirstTurn);
    const assistantFirstTurnEnabled = Boolean(assistantFirstTurn.enabled);
    let assistantFirstTurnActive = false;
    if (assistantFirstTurnEnabled) {
      const prompt = String(assistantFirstTurn.prompt ?? '').trim();
      const missingPromptBehavior = String(assistantFirstTurn.missingPromptBehavior ?? 'reject').trim().toLowerCase();
      if (!prompt) {
        if (missingPromptBehavior === 'skip') {
          // ignore
        } else {
          throw makeHttpError({ message: 'Missing assistantFirstTurn.prompt', statusCode: 400, code: 'validation_error' });
        }
      } else {
        const roleRaw = String(assistantFirstTurn.role ?? 'user').trim().toLowerCase();
        const role = roleRaw === 'system' ? 'system' : 'user';

        const delayMsRaw = assistantFirstTurn.delayMs;
        const delayMs = delayMsRaw === undefined || delayMsRaw === null || delayMsRaw === '' ? 0 : Number(delayMsRaw);
        if (!Number.isFinite(delayMs) || delayMs < 0) {
          throw makeHttpError({ message: 'Invalid assistantFirstTurn.delayMs', statusCode: 400, code: 'validation_error' });
        }
        if (delayMs > 0) {
          throw makeHttpError({ message: 'assistantFirstTurn.delayMs is not supported for vapi voice calls', statusCode: 400, code: 'validation_error' });
        }

        messages.push({ role, content: prompt });
        assistantFirstTurnActive = true;
      }
    }

    const webhookUrl = toWebhookUrlFromMediaWsUrl({ mediaWsUrl: options.mediaWsUrl, callConfigId });
    if (!webhookUrl) {
      throw makeProviderConfigError('Failed to derive /voice/webhook URL from mediaWsUrl');
    }

    const webhookAuth = parseWebhookAuth(options.providerDefaults);
    if (webhookAuth.type !== 'bearer') {
      throw makeProviderConfigError('Only bearer webhookAuth is supported for createOutboundCall');
    }

    const recordingCfg = normalizePlainObject(callConfig.recording);
    const recordingEnabled = Boolean(recordingCfg.enabled);
    const recordingMode = recordingEnabled ? String(recordingCfg.mode ?? 'provider').trim().toLowerCase() : '';
    const recordingFormatRaw = String(recordingCfg.format ?? '').trim().toLowerCase();
    const recordingFormat = recordingFormatRaw === 'wav' ? 'wav;l16' : 'mp3';
    const artifactPlan = recordingEnabled && recordingMode === 'provider'
      ? { recordingEnabled: true, recordingFormat }
      : undefined;

    const assistant: any = {
      ...(assistantFirstTurnActive ? { firstMessageMode: 'assistant-speaks-first-with-model-generated-message' } : { firstMessageMode: 'assistant-waits-for-user' }),
      modelOutputInMessagesEnabled: true,
      serverMessages: ['status-update', 'speech-update', 'transcript', 'end-of-call-report'],
      server: {
        url: webhookUrl,
        headers: { Authorization: `Bearer ${webhookAuth.token}` }
      },
      ...(artifactPlan ? { artifactPlan } : {}),
      model: {
        provider: modelProvider,
        model,
        ...(messages.length > 0 ? { messages } : {}),
        ...(temperature !== undefined ? { temperature } : {})
      },
      transcriber: {
        provider: transcriber.provider,
        model: transcriber.model
      },
      voice: {
        provider: voiceProvider,
        voiceId: voice,
        ...(speed !== undefined ? { speed } : {})
      }
    };

    const url = `${apiBaseUrl}/call`;
    let res: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumberId: from,
          customer: { number: to },
          assistant
        })
      });
    } catch (err: any) {
      const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
      throw new ProviderExecutionError('vapi', `Outbound call create failed${detail}`, 502);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const suffix = text ? `: ${text.slice(0, 500)}` : '';
      throw new ProviderExecutionError('vapi', `Outbound call create failed (${res.status})${suffix}`, res.status, res.status === 429);
    }

    const payload = await res.json().catch(() => null);
    const providerCallId = String(payload?.id ?? '').trim();
    if (!providerCallId) {
      throw new ProviderExecutionError('vapi', 'Outbound call create response missing id', 502);
    }

    return { providerCallId };
  }

  async createWebhookResponse(options: { callConfigId: string; callConfig?: any; voiceProvider: string; body?: any; bodyText?: string; events?: { emit?: (event: any) => void } }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const body = normalizePlainObject(options.body);
    const message = normalizePlainObject(body.message);
    const type = String(message.type ?? '').trim();

    const call = normalizePlainObject(message.call);
    const providerCallId = String(call.id ?? options.callConfig?.providerCallId ?? '').trim();
    const endedDedupeKey = providerCallId || String(options.callConfigId).trim();
    const emit = (event: any) => {
      try {
        options.events?.emit?.({ ...event, ...(providerCallId ? { providerCallId } : {}) });
      } catch {}
    };

    if (type.startsWith('transcript')) {
      const roleRaw = String(message.role ?? '').trim().toLowerCase();
      const role = roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : '';
      const transcript = String(message.transcript ?? '').trim();

      const transcriptTypeRaw = String(message.transcriptType ?? '').trim().toLowerCase();
      const transcriptType =
        transcriptTypeRaw === 'final' ? 'final' : transcriptTypeRaw === 'partial' ? 'partial' : type.includes('final') ? 'final' : '';

      if (role && transcript && transcriptType) {
        if (role === 'user') {
          if (transcriptType === 'final') {
            emit({ type: 'user_transcript.final', text: transcript });
          } else {
            emit({ type: 'user_transcript.delta', textDelta: transcript });
          }
        } else if (role === 'assistant') {
          if (transcriptType === 'final') {
            emit({ type: 'assistant_transcript.final', text: transcript });
          } else {
            emit({ type: 'assistant_transcript.delta', textDelta: transcript });
          }
        }
      }
    } else if (type === 'speech-update') {
      const roleRaw = String(message.role ?? '').trim().toLowerCase();
      const status = String(message.status ?? '').trim().toLowerCase();
      const role = roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : '';
      if (role === 'user') {
        if (status === 'started') emit({ type: 'user_speech.started' });
        if (status === 'stopped') emit({ type: 'user_speech.stopped' });
      } else if (role === 'assistant') {
        if (status === 'started') emit({ type: 'voice.assistant_audio.started' });
        if (status === 'stopped') {
          emit({ type: 'voice.assistant_audio.ended' });
          emit({ type: 'voice.playback.drained' });
        }
      }
    } else if (type === 'status-update') {
      const status = String(message.status ?? '').trim().toLowerCase();
      if (status === 'in-progress') {
        emit({ type: 'voice.call.connected' });
      } else if (status === 'ended') {
        const endedReason = String(message.endedReason ?? '').trim();
        if (shouldEmitEndedEvent(endedDedupeKey)) {
          emit({ type: 'voice.call.ended', ...(endedReason ? { endedReason } : {}) });
        }
      }
    } else if (type === 'end-of-call-report') {
      const endedReason = String(message.endedReason ?? '').trim();
      if (shouldEmitEndedEvent(endedDedupeKey)) {
        emit({ type: 'voice.call.ended', ...(endedReason ? { endedReason } : {}) });
      }
    }

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  }

  async endCall(options: { callConfigId: string; callConfig?: any; providerCallId: string; voiceProvider: string; providerDefaults?: any }): Promise<void> {
    const providerCallId = String(options.providerCallId ?? options.callConfig?.providerCallId ?? '').trim();
    if (!providerCallId) return;

    const defaults = normalizePlainObject(options.providerDefaults);
    const apiKey = String(defaults.apiKey ?? '').trim();
    const apiBaseUrlRaw = String(defaults.apiBaseUrl ?? 'https://api.vapi.ai').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.vapi.ai';
    if (!apiKey) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    const callUrl = `${apiBaseUrl}/call/${encodeURIComponent(providerCallId)}`;
    const pollMsRaw = defaults.controlUrlPollMs ?? 500;
    const maxWaitMsRaw = defaults.controlUrlMaxWaitMs ?? 20000;
    const pollMs = Math.max(100, Math.floor(Number.isFinite(Number(pollMsRaw)) ? Number(pollMsRaw) : 500));
    const maxWaitMs = Math.max(pollMs, Math.floor(Number.isFinite(Number(maxWaitMsRaw)) ? Number(maxWaitMsRaw) : 20000));

    const deadline = Date.now() + maxWaitMs;
    let controlUrl = '';
    let lastErr: any;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(callUrl, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Vapi call get failed (${res.status}): ${text || res.statusText}`);
        }
        const json = await res.json().catch(() => ({}));
        const monitor = normalizePlainObject((json as any)?.monitor);
        controlUrl = String(monitor.controlUrl ?? '').trim();
        if (controlUrl) break;
      } catch (err: any) {
        lastErr = err;
      }

      await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    }

    if (!controlUrl) {
      const detail = lastErr?.message ? `: ${String(lastErr.message).slice(0, 200)}` : '';
      throw new ProviderExecutionError('vapi', `Vapi controlUrl unavailable${detail}`, 502);
    }

    const res = await fetch(controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'end-call' }) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderExecutionError('vapi', `Vapi control failed (${res.status}): ${text || res.statusText}`, res.status, res.status === 429);
    }
  }

  async getRecordingDownloadRequest(options: { callConfigId: string; callConfig: any; providerDefaults?: any }): Promise<{ url: string; headers: Record<string, string> }> {
    const callConfig = options.callConfig ?? {};

    const providerCallId = String((callConfig as any)?.providerCallId ?? '').trim();
    if (!providerCallId) {
      throw makeHttpError({ message: 'Recording is not ready', statusCode: 409, code: 'recording_not_ready' });
    }

    const defaults = normalizePlainObject(options.providerDefaults);
    const apiKey = String(defaults.apiKey ?? '').trim();
    const apiBaseUrlRaw = String(defaults.apiBaseUrl ?? 'https://api.vapi.ai').trim();
    const apiBaseUrl = apiBaseUrlRaw ? apiBaseUrlRaw.replace(/\/+$/g, '') : 'https://api.vapi.ai';
    if (!apiKey) {
      throw makeProviderConfigError('Missing required provider credentials');
    }

    let apiHost = '';
    try {
      apiHost = new URL(apiBaseUrl).host;
    } catch {
      throw makeProviderConfigError('Invalid provider apiBaseUrl');
    }

    const channels = normalizeRecordingChannels((callConfig as any)?.recording?.channels);
    const url = `${apiBaseUrl}/call/${encodeURIComponent(providerCallId)}`;

    let res: any;
    try {
      res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (err: any) {
      const detail = err?.message ? `: ${String(err.message).slice(0, 200)}` : '';
      throw new ProviderExecutionError('vapi', `Call get failed${detail}`, 502);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const suffix = text ? `: ${text.slice(0, 500)}` : '';
      throw new ProviderExecutionError('vapi', `Call get failed (${res.status})${suffix}`, res.status, res.status === 429);
    }

    const call = await res.json().catch(() => null);
    const recordingUrlRaw = resolveRecordingDownloadUrl(call, channels);
    if (!recordingUrlRaw) {
      throw makeHttpError({ message: 'Recording is not ready', statusCode: 409, code: 'recording_not_ready' });
    }

    let recordingUrl: URL;
    try {
      recordingUrl = new URL(recordingUrlRaw);
    } catch {
      throw makeHttpError({ message: 'Invalid recording URL', statusCode: 500, code: 'provider_error' });
    }
    if (recordingUrl.protocol !== 'https:' && recordingUrl.protocol !== 'http:') {
      throw makeHttpError({ message: 'Invalid recording URL protocol', statusCode: 500, code: 'provider_error' });
    }

    const headers: Record<string, string> = {};
    if (recordingUrl.host === apiHost) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return { url: recordingUrl.toString(), headers };
  }

  async handleMediaConnection(options: { ws: any }) {
    try { options.ws?.close?.(); } catch {}
  }
}
