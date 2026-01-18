import type { IRealtimeCompat, RealtimeAudioFrame, RealtimeSessionSpec } from '../../../../../../kernel/index.js';

export const VAPI_SESSION_SETTINGS_DEFINITIONS = {
  temperature: { type: 'number' },
  maxOutputTokens: { type: 'number', aliases: ['maxTokens', 'max_output_tokens'] },
  voice: { type: 'string' },
  speed: { type: 'number' },
  inputMinCharacters: { type: 'number', aliases: ['input_min_characters'] },
  backgroundSound: { type: 'string', aliases: ['background_sound'] },
  modelProvider: { type: 'string', aliases: ['model_provider'] },
  voiceProvider: { type: 'string', aliases: ['voice_provider'] },
  emotionRecognitionEnabled: { type: 'boolean', aliases: ['emotion_recognition_enabled'] },
  transcriberProvider: { type: 'string', aliases: ['transcriber_provider'] },
  transcriberModel: { type: 'string', aliases: ['transcriber_model'] },
  transcriberEagerEotThreshold: { type: 'number', aliases: ['transcriber_eager_eot_threshold'] },
  transcriberEotThreshold: { type: 'number', aliases: ['transcriber_eot_threshold'] },
  transcriberEotTimeoutMs: { type: 'number', aliases: ['transcriber_eot_timeout_ms'] },
  startSpeakingWaitSeconds: { type: 'number', aliases: ['start_speaking_wait_seconds'] },
  startSpeakingSmartEndpointingEnabled: { type: 'boolean', aliases: ['smartEndpointingEnabled', 'smart_endpointing_enabled'] },
  transcriptionEndpointingOnPunctuationSeconds: { type: 'number', aliases: ['transcription_endpointing_on_punctuation_seconds'] },
  transcriptionEndpointingOnNoPunctuationSeconds: { type: 'number', aliases: ['transcription_endpointing_on_no_punctuation_seconds'] },
  transcriptionEndpointingOnNumberSeconds: { type: 'number', aliases: ['transcription_endpointing_on_number_seconds'] },
  stopSpeakingNumWords: { type: 'number', aliases: ['stop_speaking_num_words'] },
  stopSpeakingVoiceSeconds: { type: 'number', aliases: ['stop_speaking_voice_seconds'] },
  stopSpeakingBackoffSeconds: { type: 'number', aliases: ['stop_speaking_backoff_seconds'] },
  keepaliveEnabled: { type: 'boolean', aliases: ['keepalive_enabled'] },
  keepaliveIntervalMs: { type: 'int', aliases: ['keepalive_interval_ms'] },
  wsHandshakeTimeoutMs: { type: 'int', aliases: ['ws_handshake_timeout_ms'] },
  toolFallbackDelayMs: { type: 'int', aliases: ['tool_fallback_delay_ms'] },
  controlUrlPollMs: { type: 'int', aliases: ['control_url_poll_ms'] },
  controlUrlMaxWaitMs: { type: 'int', aliases: ['control_url_max_wait_ms'] }
} as const;

export function generateSessionId(): string {
  return `sess_local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function resolveSessionAudio(spec: RealtimeSessionSpec): { input: RealtimeAudioFrame; output: RealtimeAudioFrame } {
  const fallback = { format: 'pcm16', sampleRateHz: 24000, channels: 1 } as const;

  const input = (spec.audio?.input ?? spec.audio?.output ?? fallback) as any;
  const output = (spec.audio?.output ?? spec.audio?.input ?? fallback) as any;

  const validate = (label: string, frame: any) => {
    const format = String(frame?.format ?? '');
    const sampleRateHz = Number(frame?.sampleRateHz ?? NaN);
    const channels = frame?.channels;

    if (format !== 'pcm16') {
      throw new Error(`${label} audio requires format=pcm16`);
    }
    if (channels !== 1) {
      throw new Error(`${label} audio requires channels=1`);
    }
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error(`${label} audio requires a positive sampleRateHz`);
    }
  };

  validate('input', input);
  validate('output', output);

  return { input, output };
}

export function resolveModel(spec: RealtimeSessionSpec, provider: Parameters<IRealtimeCompat['createSession']>[0]['provider']): string {
  const model = String(spec.model ?? (provider.metadata as any)?.defaultModel ?? '').trim();
  if (!model) {
    throw new Error(`Realtime session requires 'model' for provider '${provider.id}'`);
  }
  return model;
}

export function resolveWhitelistedProvider(value: string, allowed: any, label: string): string {
  const raw = String(value).trim();
  if (!Array.isArray(allowed) || allowed.length === 0) return raw;
  const cleaned = allowed.map(v => String(v ?? '').trim()).filter(Boolean);
  const found = cleaned.find(v => v.toLowerCase() === raw.toLowerCase());
  if (!found) {
    throw new Error(`Unsupported ${label} '${raw}'. Allowed: ${cleaned.join(', ')}`);
  }
  return found;
}

