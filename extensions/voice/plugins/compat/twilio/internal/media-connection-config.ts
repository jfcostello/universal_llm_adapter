import { makeHttpError } from '../../../../../../modules/shared/index.js';

import { makeProviderConfigError } from './shared.js';

export function resolveMediaConnectionConfig(options: {
  callConfig: any;
  providerDefaults?: any;
  outboundBufferMaxFramesCap: number;
}): {
  callTimeoutMs: number | undefined;
  silenceTimeoutMs: number | undefined;
  firstTurnGraceMs: number | undefined;
  silenceAssistantAudioEndFallbackMs: number | undefined;
  silenceAssistantAudioStartFallbackMs: number | undefined;
  assistantFirstTurnCfg: any;
  assistantFirstTurnEnabled: boolean;
  outboundBufferMaxFrames: number | undefined;
} {
  const callConfig = options.callConfig ?? {};

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

  const firstTurnGraceMs =
    firstTurnGraceMsExplicit !== undefined
      ? Math.floor(firstTurnGraceMsExplicit)
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

  const outboundBufferMaxFramesCap = options.outboundBufferMaxFramesCap;
  const parseOutboundBufferMaxFrames = (value: any, label: string, errorKind: 'validation' | 'provider'): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    const out = Math.floor(n);
    if (!Number.isFinite(n) || out <= 0) {
      if (errorKind === 'provider') {
        throw makeProviderConfigError(`Invalid ${label}`);
      }
      throw makeHttpError({ message: `Invalid ${label}`, statusCode: 400, code: 'validation_error' });
    }
    if (outboundBufferMaxFramesCap > 0 && out > outboundBufferMaxFramesCap) {
      const message = `Invalid ${label} (max allowed: ${outboundBufferMaxFramesCap})`;
      if (errorKind === 'provider') {
        throw makeProviderConfigError(message);
      }
      throw makeHttpError({ message, statusCode: 400, code: 'validation_error' });
    }
    return out;
  };

  const providerDefaultsRaw = options.providerDefaults;
  const providerDefaults =
    providerDefaultsRaw && typeof providerDefaultsRaw === 'object' && !Array.isArray(providerDefaultsRaw)
      ? providerDefaultsRaw
      : {};
  const providerMediaStreamsRaw = (providerDefaults as any)?.mediaStreams;
  const mediaStreamsDefaults =
    providerMediaStreamsRaw === undefined || providerMediaStreamsRaw === null
      ? {}
      : providerMediaStreamsRaw && typeof providerMediaStreamsRaw === 'object' && !Array.isArray(providerMediaStreamsRaw)
        ? providerMediaStreamsRaw
        : (() => { throw makeProviderConfigError('Invalid defaults.mediaStreams'); })();
  const defaultOutboundBufferMaxFrames = parseOutboundBufferMaxFrames(
    (mediaStreamsDefaults as any).outboundBufferMaxFrames,
    'defaults.mediaStreams.outboundBufferMaxFrames',
    'provider'
  );

  const providerConfigRaw = (callConfig as any)?.providerConfig;
  const providerConfig =
    providerConfigRaw && typeof providerConfigRaw === 'object' && !Array.isArray(providerConfigRaw)
      ? providerConfigRaw
      : {};
  const providerMediaCfgRaw = (providerConfig as any)?.mediaStreams;
  const mediaStreamsCfg =
    providerMediaCfgRaw === undefined || providerMediaCfgRaw === null
      ? {}
      : providerMediaCfgRaw && typeof providerMediaCfgRaw === 'object' && !Array.isArray(providerMediaCfgRaw)
        ? providerMediaCfgRaw
        : (() => { throw makeHttpError({ message: 'Invalid providerConfig.mediaStreams', statusCode: 400, code: 'validation_error' }); })();
  const outboundBufferMaxFrames = parseOutboundBufferMaxFrames(
    (mediaStreamsCfg as any).outboundBufferMaxFrames,
    'providerConfig.mediaStreams.outboundBufferMaxFrames',
    'validation'
  ) ?? defaultOutboundBufferMaxFrames;

  return {
    callTimeoutMs,
    silenceTimeoutMs,
    firstTurnGraceMs,
    silenceAssistantAudioEndFallbackMs: silenceAssistantAudioEndFallbackMs === undefined ? undefined : Math.floor(silenceAssistantAudioEndFallbackMs),
    silenceAssistantAudioStartFallbackMs: silenceAssistantAudioStartFallbackMs === undefined ? undefined : Math.floor(silenceAssistantAudioStartFallbackMs),
    assistantFirstTurnCfg,
    assistantFirstTurnEnabled,
    outboundBufferMaxFrames
  };
}

