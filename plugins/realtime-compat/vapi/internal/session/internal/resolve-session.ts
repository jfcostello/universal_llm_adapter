import type { IRealtimeCompat, RealtimeAudioFrame, RealtimeSessionSpec } from '../../../../../../kernel/index.js';
import { parseRealtimeSessionSettings } from '../../../../../../kernel/index.js';

import type { VapiTransportAudioFormat } from './api.js';
import { buildVapiCreateCallBody } from './api.js';
import { resolveModel, resolveSessionAudio, resolveWhitelistedProvider, VAPI_SESSION_SETTINGS_DEFINITIONS } from './settings.js';
import { ensureJsonObject, serializeTools } from './tools.js';

type VapiTransportAudioFormatBase = Omit<VapiTransportAudioFormat, 'sampleRate'>;

const PROVIDER_AUDIO_BASE: VapiTransportAudioFormatBase = {
  format: 'pcm_s16le',
  container: 'raw'
};

export type ResolvedVapiSessionPlan = {
  provider: Parameters<IRealtimeCompat['createSession']>[0]['provider'];
  spec: RealtimeSessionSpec;
  sessionAudio: { input: RealtimeAudioFrame; output: RealtimeAudioFrame };
  providerAudio: VapiTransportAudioFormat;
  keepaliveEnabled: boolean;
  keepaliveIntervalMs: number;
  wsHandshakeTimeoutMs: number;
  toolFallbackDelayMs: number;
  controlUrlPollMs: number;
  controlUrlMaxWaitMs: number;
  unifiedToolNameByProviderName: Map<string, string>;
  toolsWithMessageParam: Set<string>;
  body: any;
};

export function resolveVapiSessionPlan(options: Parameters<IRealtimeCompat['createSession']>[0]): ResolvedVapiSessionPlan {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const endpoint = provider.endpoint;
  if (!endpoint?.urlTemplate) {
    throw new Error(`Provider '${provider.id}' missing realtime endpoint configuration`);
  }

  const settingsParse = parseRealtimeSessionSettings(spec.settings, VAPI_SESSION_SETTINGS_DEFINITIONS);
  const settings = settingsParse.values as any;

  const model = resolveModel(spec, provider);
  const supportedModelProviders = (provider.metadata as any)?.supportedModelProviders;
  const modelProvider = resolveWhitelistedProvider(
    String(settings.modelProvider ?? (provider.metadata as any)?.defaultModelProvider ?? 'openai').trim() || 'openai',
    supportedModelProviders,
    'modelProvider'
  );
  const voiceProvider =
    String(settings.voiceProvider ?? (provider.metadata as any)?.defaultVoiceProvider ?? modelProvider).trim() || modelProvider;
  const voice = String(settings.voice ?? (provider.metadata as any)?.defaultVoice ?? 'alloy').trim() || 'alloy';
  const temp = settings.temperature === undefined || settings.temperature === null ? NaN : Number(settings.temperature);
  const temperature = Number.isFinite(temp) ? temp : undefined;

  const keepaliveFromProvider = (provider.metadata as any)?.keepalive;
  const controlUrlFromProvider = (provider.metadata as any)?.controlUrl;
  const keepaliveEnabled: boolean = settings.keepaliveEnabled === undefined
    ? Boolean(keepaliveFromProvider?.enabled ?? true)
    : Boolean(settings.keepaliveEnabled);
  const keepaliveIntervalMsRaw =
    settings.keepaliveIntervalMs ?? keepaliveFromProvider?.intervalMs ?? 250;
  const keepaliveIntervalMs = Math.max(
    50,
    Math.floor(Number.isFinite(Number(keepaliveIntervalMsRaw)) ? Number(keepaliveIntervalMsRaw) : 250)
  );

  const wsHandshakeTimeoutMsRaw =
    settings.wsHandshakeTimeoutMs ?? (provider.metadata as any)?.wsHandshakeTimeoutMs ?? 0;
  const wsHandshakeTimeoutMs = Math.max(
    0,
    Math.floor(Number.isFinite(Number(wsHandshakeTimeoutMsRaw)) ? Number(wsHandshakeTimeoutMsRaw) : 0)
  );

  const toolFallbackDelayMsRaw = settings.toolFallbackDelayMs ?? 5000;
  const toolFallbackDelayMs = Math.max(0, Math.floor(toolFallbackDelayMsRaw));

  const controlUrlPollMsRaw =
    settings.controlUrlPollMs ?? controlUrlFromProvider?.pollMs ?? 500;
  const controlUrlPollMs = Math.max(
    100,
    Math.floor(Number.isFinite(Number(controlUrlPollMsRaw)) ? Number(controlUrlPollMsRaw) : 500)
  );
  const controlUrlMaxWaitMsRaw =
    settings.controlUrlMaxWaitMs ?? controlUrlFromProvider?.maxWaitMs ?? 20000;
  const controlUrlMaxWaitMs = Math.max(
    controlUrlPollMs,
    Math.floor(Number.isFinite(Number(controlUrlMaxWaitMsRaw)) ? Number(controlUrlMaxWaitMsRaw) : 20000)
  );

  const transcriberProvider =
    String(spec.transcription?.provider ?? settings.transcriberProvider ?? (provider.metadata as any)?.defaultTranscriberProvider ?? 'deepgram').trim() || 'deepgram';
  const transcriberModel =
    String(spec.transcription?.model ?? settings.transcriberModel ?? (provider.metadata as any)?.defaultTranscriberModel ?? 'nova-2').trim() || 'nova-2';
  const sessionAudio = resolveSessionAudio(spec);
  const providerAudio: VapiTransportAudioFormat = {
    ...PROVIDER_AUDIO_BASE,
    sampleRate: Math.floor(sessionAudio.input.sampleRateHz)
  };

  const clientMessages = [
    'model-output',
    'transcript',
    'speech-update',
    'tool-calls',
    'tool-calls-result',
    'status-update',
    'conversation-update'
  ];
  const { toolsForModel, unifiedToolNameByProviderName, toolsWithMessageParam } = serializeTools(options.tools, spec.toolChoice);

  const body = buildVapiCreateCallBody({
    modelProvider,
    model,
    voiceProvider,
    voice,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(Array.isArray(spec.history) && spec.history.length > 0 ? { history: spec.history } : {}),
    ...(toolsForModel ? { tools: toolsForModel } : {}),
    clientMessages,
    audioFormat: providerAudio
  });

  if (settings.backgroundSound !== undefined) {
    (body.assistant as any).backgroundSound = settings.backgroundSound;
  }

  if (settings.maxOutputTokens !== undefined) {
    (body.assistant as any).model.maxTokens = settings.maxOutputTokens;
  }
  if (settings.emotionRecognitionEnabled !== undefined) {
    (body.assistant as any).model.emotionRecognitionEnabled = settings.emotionRecognitionEnabled;
  }

  if (settings.speed !== undefined) {
    (body.assistant as any).voice.speed = settings.speed;
  }
  if (settings.inputMinCharacters !== undefined) {
    const voiceObj = (body.assistant as any).voice;
    const chunkPlan = ensureJsonObject(voiceObj.chunkPlan);
    voiceObj.chunkPlan = { ...chunkPlan, minCharacters: settings.inputMinCharacters };
  }

  const startSpeakingPlan: any = {};
  let hasStartSpeakingPlan = false;
  if (settings.startSpeakingWaitSeconds !== undefined) {
    startSpeakingPlan.waitSeconds = settings.startSpeakingWaitSeconds;
    hasStartSpeakingPlan = true;
  }
  if (settings.startSpeakingSmartEndpointingEnabled !== undefined) {
    startSpeakingPlan.smartEndpointingEnabled = settings.startSpeakingSmartEndpointingEnabled;
    hasStartSpeakingPlan = true;
  }
  const transcriptionEndpointingPlan: any = {};
  let hasEndpointingPlan = false;
  if (settings.transcriptionEndpointingOnPunctuationSeconds !== undefined) {
    transcriptionEndpointingPlan.onPunctuationSeconds = settings.transcriptionEndpointingOnPunctuationSeconds;
    hasEndpointingPlan = true;
  }
  if (settings.transcriptionEndpointingOnNoPunctuationSeconds !== undefined) {
    transcriptionEndpointingPlan.onNoPunctuationSeconds = settings.transcriptionEndpointingOnNoPunctuationSeconds;
    hasEndpointingPlan = true;
  }
  if (settings.transcriptionEndpointingOnNumberSeconds !== undefined) {
    transcriptionEndpointingPlan.onNumberSeconds = settings.transcriptionEndpointingOnNumberSeconds;
    hasEndpointingPlan = true;
  }
  if (hasEndpointingPlan) {
    startSpeakingPlan.transcriptionEndpointingPlan = transcriptionEndpointingPlan;
    hasStartSpeakingPlan = true;
  }
  if (hasStartSpeakingPlan) {
    (body.assistant as any).startSpeakingPlan = startSpeakingPlan;
  }

  const stopSpeakingPlan: any = {};
  let hasStopSpeakingPlan = false;
  if (settings.stopSpeakingNumWords !== undefined) {
    stopSpeakingPlan.numWords = settings.stopSpeakingNumWords;
    hasStopSpeakingPlan = true;
  }
  if (settings.stopSpeakingVoiceSeconds !== undefined) {
    stopSpeakingPlan.voiceSeconds = settings.stopSpeakingVoiceSeconds;
    hasStopSpeakingPlan = true;
  }
  if (settings.stopSpeakingBackoffSeconds !== undefined) {
    stopSpeakingPlan.backoffSeconds = settings.stopSpeakingBackoffSeconds;
    hasStopSpeakingPlan = true;
  }
  if (hasStopSpeakingPlan) {
    (body.assistant as any).stopSpeakingPlan = stopSpeakingPlan;
  }

  if (spec.transcription?.enabled) {
    (body.assistant as any).artifactPlan = {
      transcriptPlan: { enabled: true }
    };
    (body.assistant as any).transcriber = {
      provider: transcriberProvider,
      model: transcriberModel,
      language: String(spec.transcription?.language ?? 'en'),
      smartFormat: true
    };

    if (String(transcriberProvider).trim().toLowerCase() === 'deepgram') {
      if (settings.transcriberEagerEotThreshold !== undefined) {
        (body.assistant as any).transcriber.eagerEotThreshold = settings.transcriberEagerEotThreshold;
      }
      if (settings.transcriberEotThreshold !== undefined) {
        (body.assistant as any).transcriber.eotThreshold = settings.transcriberEotThreshold;
      }
      if (settings.transcriberEotTimeoutMs !== undefined) {
        (body.assistant as any).transcriber.eotTimeoutMs = settings.transcriberEotTimeoutMs;
      }
    }
  }

  return {
    provider,
    spec,
    sessionAudio,
    providerAudio,
    keepaliveEnabled,
    keepaliveIntervalMs,
    wsHandshakeTimeoutMs,
    toolFallbackDelayMs,
    controlUrlPollMs,
    controlUrlMaxWaitMs,
    unifiedToolNameByProviderName,
    toolsWithMessageParam,
    body
  };
}

