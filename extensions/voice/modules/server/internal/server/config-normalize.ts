import { makeHttpError } from '../../../../../../modules/shared/index.js';

import type { VoiceAssistantFirstTurnConfig, VoiceCallRecordingConfig, VoiceCallTimeoutsConfig } from '../../../call-config-store/index.js';

import { asPlainObject } from './utils-ws.js';

export function readVoiceExtensionDefaults(httpConfig: any): Record<string, any> {
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

export function normalizeVoiceCallTimeouts(options: { raw: unknown; defaults: unknown }): VoiceCallTimeoutsConfig | undefined {
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

export function normalizeVoiceCallRecording(options: { raw: unknown; defaults: unknown }): VoiceCallRecordingConfig | undefined {
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

export function normalizeAssistantFirstTurn(options: { raw: unknown; defaults: unknown }): VoiceAssistantFirstTurnConfig | undefined {
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
