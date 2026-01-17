import { ProviderExecutionError } from '../../../../../../kernel/index.js';
import { makeHttpError } from '../../../../../../modules/shared/index.js';

import { parseWebhookAuth } from './webhook-auth.js';
import { makeProviderConfigError, normalizePlainObject } from './shared.js';

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

export async function createOutboundCall(options: {
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
    serverMessages: ['status-update', 'speech-update', 'transcript', 'end-of-call-report', 'tool-calls', 'function-call'],
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

