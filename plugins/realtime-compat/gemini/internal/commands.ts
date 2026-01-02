import type { RealtimeAudioFrame, RealtimeSessionSpec, UnifiedTool } from '../../../../kernel/index.js';
import { parseRealtimeSessionSettings } from '../../../../kernel/index.js';
import { serializeToolsForLiveSDK } from '../../../modules/google-tooling/index.js';

type SessionAudioConfig = {
  input: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
  output: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
};

function renderHistoryForSystemInstruction(history: NonNullable<RealtimeSessionSpec['history']>): string {
  const lines = history.map(item => `${String(item.role).toUpperCase()}: ${String(item.text)}`);
  return ['--- Injected conversation history (for context) ---', ...lines, '--- End injected conversation history ---'].join('\n');
}

function filterToolsForSpec(spec: RealtimeSessionSpec, tools?: UnifiedTool[]): UnifiedTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const choice = spec.toolChoice;
  if (choice === undefined || choice === null) return tools;

  if (typeof choice === 'string') {
    if (choice === 'none') return undefined;
    return tools;
  }

  if (choice.type === 'single') {
    const selected = tools.filter(t => t.name === choice.name);
    return selected.length > 0 ? selected : tools;
  }

  if (choice.type === 'required') {
    if (choice.allowed && choice.allowed.length > 0) {
      const allow = new Set(choice.allowed);
      const selected = tools.filter(t => allow.has(t.name));
      return selected.length > 0 ? selected : tools;
    }
    return tools;
  }

  return tools;
}

export function buildGeminiSetupMessage(options: {
  model: string;
  spec: RealtimeSessionSpec;
  tools?: UnifiedTool[];
}): { message: any; audio: SessionAudioConfig; settingsWarnings: { unknownKeys: string[]; invalidKeys: string[] } } {
  const audio = normalizeSessionAudio(options.spec.audio);

  const tools = filterToolsForSpec(options.spec, options.tools);

  const { values: settingsValues, unknownKeys, invalidKeys } = parseRealtimeSessionSettings(options.spec.settings, {
    temperature: { type: 'number' },
    maxOutputTokens: { type: 'int', aliases: ['maxTokens', 'max_output_tokens'] },
    voice: { type: 'string' },
    topP: { type: 'number', aliases: ['top_p'] },
    topK: { type: 'int', aliases: ['top_k'] },
    enableAffectiveDialog: { type: 'boolean', aliases: ['enable_affective_dialog'] },
    proactiveAudio: { type: 'boolean', aliases: ['proactive_audio'] },
    thinkingBudget: { type: 'int', aliases: ['thinking_budget'] },
    includeThoughts: { type: 'boolean', aliases: ['include_thoughts'] },
    startOfSpeechSensitivity: { type: 'string', aliases: ['start_of_speech_sensitivity'] },
    endOfSpeechSensitivity: { type: 'string', aliases: ['end_of_speech_sensitivity'] },
    vadPrefixPaddingMs: { type: 'int', aliases: ['vad_prefix_padding_ms'] },
    vadSilenceDurationMs: { type: 'int', aliases: ['vad_silence_duration_ms'] }
  });

  const temperature = typeof settingsValues.temperature === 'number' ? settingsValues.temperature : undefined;
  const maxOutputTokens =
    typeof settingsValues.maxOutputTokens === 'number' ? Math.floor(settingsValues.maxOutputTokens) : undefined;
  const voice = typeof settingsValues.voice === 'string' ? settingsValues.voice : undefined;
  const topP = typeof settingsValues.topP === 'number' ? settingsValues.topP : undefined;
  const topK = typeof settingsValues.topK === 'number' ? settingsValues.topK : undefined;
  const enableAffectiveDialog =
    typeof settingsValues.enableAffectiveDialog === 'boolean' ? settingsValues.enableAffectiveDialog : undefined;
  const proactiveAudio =
    typeof settingsValues.proactiveAudio === 'boolean' ? settingsValues.proactiveAudio : undefined;
  const thinkingBudget = typeof settingsValues.thinkingBudget === 'number' ? settingsValues.thinkingBudget : undefined;
  const includeThoughts =
    typeof settingsValues.includeThoughts === 'boolean' ? settingsValues.includeThoughts : undefined;
  const startOfSpeechSensitivity =
    typeof settingsValues.startOfSpeechSensitivity === 'string' ? settingsValues.startOfSpeechSensitivity : undefined;
  const endOfSpeechSensitivity =
    typeof settingsValues.endOfSpeechSensitivity === 'string' ? settingsValues.endOfSpeechSensitivity : undefined;
  const vadPrefixPaddingMs =
    typeof settingsValues.vadPrefixPaddingMs === 'number' ? settingsValues.vadPrefixPaddingMs : undefined;
  const vadSilenceDurationMs =
    typeof settingsValues.vadSilenceDurationMs === 'number' ? settingsValues.vadSilenceDurationMs : undefined;

  const setup: any = {
    model: normalizeModel(options.model),
    generationConfig: {
      responseModalities: ['AUDIO']
    }
  };

  if (temperature !== undefined) setup.generationConfig.temperature = temperature;
  if (maxOutputTokens !== undefined) setup.generationConfig.maxOutputTokens = maxOutputTokens;
  if (topP !== undefined) setup.generationConfig.topP = topP;
  if (topK !== undefined) setup.generationConfig.topK = topK;

  // Apply voice config
  if (voice) {
    setup.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: voice
        }
      }
    };
  }

  // Apply affective dialog
  if (enableAffectiveDialog !== undefined) {
    setup.enableAffectiveDialog = enableAffectiveDialog;
  }

  // Apply proactive audio
  if (proactiveAudio !== undefined) {
    setup.proactivity = { proactiveAudio };
  }

  // Apply thinking config
  if (thinkingBudget !== undefined || includeThoughts !== undefined) {
    setup.thinkingConfig = {};
    if (thinkingBudget !== undefined) setup.thinkingConfig.thinkingBudget = thinkingBudget;
    if (includeThoughts !== undefined) setup.thinkingConfig.includeThoughts = includeThoughts;
  }

  const history = Array.isArray(options.spec.history) ? options.spec.history : [];
  const systemPromptText = options.spec.systemPrompt ? String(options.spec.systemPrompt) : '';
  const historyText = history.length > 0 ? renderHistoryForSystemInstruction(history) : '';
  const combinedSystemInstructionText = [systemPromptText, historyText].filter(Boolean).join('\n\n');

  if (combinedSystemInstructionText) {
    setup.systemInstruction = {
      role: 'user',
      parts: [{ text: combinedSystemInstructionText }]
    };
  }

  if (tools && tools.length > 0) setup.tools = serializeToolsForLiveSDK(tools);

  const mode = options.spec.turnDetection?.mode ?? 'manual_commit';
  if (mode === 'manual_commit') {
    setup.realtimeInputConfig = {
      automaticActivityDetection: { disabled: true }
    };
  } else if (mode === 'server_vad') {
    // Only configure automaticActivityDetection if any VAD settings are provided
    const hasVadSettings =
      startOfSpeechSensitivity !== undefined ||
      endOfSpeechSensitivity !== undefined ||
      vadPrefixPaddingMs !== undefined ||
      vadSilenceDurationMs !== undefined;

    if (hasVadSettings) {
      const aadConfig: any = { disabled: false };
      if (startOfSpeechSensitivity !== undefined) aadConfig.startOfSpeechSensitivity = startOfSpeechSensitivity;
      if (endOfSpeechSensitivity !== undefined) aadConfig.endOfSpeechSensitivity = endOfSpeechSensitivity;
      if (vadPrefixPaddingMs !== undefined) aadConfig.prefixPaddingMs = vadPrefixPaddingMs;
      if (vadSilenceDurationMs !== undefined) aadConfig.silenceDurationMs = vadSilenceDurationMs;

      setup.realtimeInputConfig = { automaticActivityDetection: aadConfig };
    }
  }

  if (options.spec.transcription?.enabled) {
    setup.inputAudioTranscription = {};
    setup.outputAudioTranscription = {};
  }

  return { message: { setup }, audio, settingsWarnings: { unknownKeys, invalidKeys } };
}

export function buildGeminiClientContentMessage(options: { turns: any[]; turnComplete: boolean }): any {
  return {
    clientContent: {
      turns: Array.isArray(options.turns) ? options.turns : [],
      turnComplete: Boolean(options.turnComplete)
    }
  };
}

export function buildGeminiSendTextMessage(options: { text: string; role?: 'system' | 'user' }): any {
  const text = String(options.text ?? '');
  // The API does not have an explicit system role for conversational turns; treat system as user text.
  return buildGeminiClientContentMessage({
    turns: [{ role: 'user', parts: [{ text }] }],
    turnComplete: false
  });
}

export function buildGeminiCommitTextTurnMessage(): any {
  return buildGeminiClientContentMessage({ turns: [], turnComplete: true });
}

export function buildGeminiInterruptMessage(): any {
  // Per protocol, clientContent interrupts any current model generation.
  return buildGeminiClientContentMessage({ turns: [], turnComplete: false });
}

export function buildGeminiActivityStartMessage(): any {
  return { realtimeInput: { activityStart: {} } };
}

export function buildGeminiRealtimeAudioMessage(options: { audioBase64: string; mimeType: string }): any {
  const realtimeInput = {
    audio: {
      mimeType: options.mimeType,
      data: String(options.audioBase64 ?? '')
    }
  };

  return { realtimeInput };
}

export function buildGeminiRealtimeTextMessage(options: { text: string }): any {
  return {
    realtimeInput: {
      text: String(options.text ?? '')
    }
  };
}

export function buildGeminiActivityEndMessage(): any {
  return { realtimeInput: { activityEnd: {} } };
}

export function buildGeminiToolResponseMessage(options: { toolCallId: string; name: string; response: any }): any {
  return {
    toolResponse: {
      functionResponses: [
        {
          id: options.toolCallId,
          name: options.name,
          response: options.response
        }
      ]
    }
  };
}

function normalizeModel(model: string): string {
  const raw = String(model ?? '').trim();
  if (!raw) return raw;
  return raw.startsWith('models/') ? raw : `models/${raw}`;
}

function normalizeSessionAudio(audio?: RealtimeSessionSpec['audio']): SessionAudioConfig {
  const fallback = { format: 'pcm16', sampleRateHz: 24000, channels: 1 } satisfies Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
  const input = audio?.input ?? audio?.output ?? fallback;
  const output = audio?.output ?? audio?.input ?? fallback;

  validateAudio(input);
  validateAudio(output);

  return { input, output };
}

function validateAudio(cfg: any): void {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('audio config must be an object');
  }

  if (cfg.channels !== 1) {
    throw new Error('audio config requires channels=1');
  }

  if (cfg.format === 'pcm16') {
    const sr = Math.max(1, Math.floor(Number(cfg.sampleRateHz)));
    if (!Number.isFinite(sr) || sr <= 0) throw new Error('pcm16 requires a positive sampleRateHz');
    return;
  }

  if (cfg.format === 'g711_ulaw' || cfg.format === 'g711_alaw') {
    if (Number(cfg.sampleRateHz) !== 8000) {
      throw new Error(`${cfg.format} requires sampleRateHz=8000`);
    }
    return;
  }

  throw new Error(`Unsupported audio format: ${String(cfg.format)}`);
}
