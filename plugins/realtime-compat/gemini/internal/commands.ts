import type { RealtimeAudioFrame, RealtimeSessionSpec, UnifiedTool } from '../../../../modules/kernel/index.js';
import { serializeToolsForSDK } from '../../../modules/google-tooling/index.js';

type SessionAudioConfig = {
  input: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
  output: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>;
};

function renderHistoryForSystemInstruction(history: NonNullable<RealtimeSessionSpec['history']>): string {
  const lines = history.map(item => `${String(item.role).toUpperCase()}: ${String(item.text)}`);
  return ['--- Injected conversation history (for context) ---', ...lines, '--- End injected conversation history ---'].join('\n');
}

export function buildGeminiSetupMessage(options: {
  model: string;
  spec: RealtimeSessionSpec;
  tools?: UnifiedTool[];
}): { message: any; audio: SessionAudioConfig } {
  const audio = normalizeSessionAudio(options.spec.audio);

  const setup: any = {
    model: normalizeModel(options.model),
    generationConfig: {
      responseModalities: ['AUDIO']
    }
  };

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

  if (options.tools && options.tools.length > 0) {
    setup.tools = serializeToolsForSDK(options.tools);
  }

  const mode = options.spec.turnDetection?.mode ?? 'manual_commit';
  if (mode === 'manual_commit') {
    setup.realtimeInputConfig = {
      automaticActivityDetection: { disabled: true }
    };
  }

  if (options.spec.transcription?.enabled) {
    setup.inputAudioTranscription = {};
    setup.outputAudioTranscription = {};
  }

  return { message: { setup }, audio };
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

export function buildGeminiRealtimeAudioMessage(options: { audioBase64: string; mimeType: string; includeActivityStart?: boolean }): any {
  const realtimeInput: any = {
    audio: {
      mimeType: options.mimeType,
      data: String(options.audioBase64 ?? '')
    }
  };

  if (options.includeActivityStart) {
    realtimeInput.activityStart = {};
  }

  return { realtimeInput };
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
