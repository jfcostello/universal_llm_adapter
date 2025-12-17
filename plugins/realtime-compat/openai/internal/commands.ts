import type { JsonValue, RealtimeAudioFrame, RealtimeSessionSpec, UnifiedTool } from '../../../../modules/kernel/index.js';

type OpenAIRealtimeClientEvent = Record<string, any>;

function assertValidAudioFrame(config: NonNullable<RealtimeAudioFrame>): void {
  if (config.channels !== 1) {
    throw new Error('Only mono audio (channels=1) is supported');
  }

  if (config.format === 'pcm16') {
    if (config.sampleRateHz !== 24000) {
      throw new Error('pcm16 requires sampleRateHz=24000');
    }
    return;
  }

  if (config.format === 'g711_ulaw' || config.format === 'g711_alaw') {
    if (config.sampleRateHz !== 8000) {
      throw new Error(`${config.format} requires sampleRateHz=8000`);
    }
    return;
  }

  throw new Error(`Unsupported audio format: ${String((config as any).format)}`);
}

function toOpenAIAudioFormat(format: RealtimeAudioFrame['format']): any {
  if (format === 'pcm16') return { type: 'audio/pcm', rate: 24000 };
  if (format === 'g711_ulaw') return { type: 'audio/pcmu' };
  return { type: 'audio/pcma' };
}

function serializeTools(tools?: UnifiedTool[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parametersJsonSchema || { type: 'object', properties: {} }
  }));
}

function serializeToolChoice(choice: RealtimeSessionSpec['toolChoice']): any {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'single') return { type: 'function', name: choice.name };
  if (choice.type === 'required') return 'required';
  return undefined;
}

function resolveAudioConfig(spec: RealtimeSessionSpec): { input: RealtimeAudioFrame; output: RealtimeAudioFrame } {
  const input = spec.audio?.input ?? spec.audio?.output ?? { format: 'pcm16', sampleRateHz: 24000, channels: 1 };
  const output = spec.audio?.output ?? spec.audio?.input ?? { format: 'pcm16', sampleRateHz: 24000, channels: 1 };
  assertValidAudioFrame(input as any);
  assertValidAudioFrame(output as any);
  return { input: input as any, output: output as any };
}

export function buildSessionUpdateEvent(options: {
  spec: RealtimeSessionSpec;
  tools?: UnifiedTool[];
}): { event: OpenAIRealtimeClientEvent; audio: { input: RealtimeAudioFrame; output: RealtimeAudioFrame } } {
  const audio = resolveAudioConfig(options.spec);

  const transcriptionEnabled = options.spec.transcription?.enabled === true;
  const language = options.spec.transcription?.language;

  const turnMode = options.spec.turnDetection?.mode ?? 'manual_commit';
  const turnDetection =
    turnMode === 'server_vad'
      ? {
          type: 'server_vad',
          create_response: true,
          // Keep provider-side interruption off; core owns barge-in semantics.
          interrupt_response: false
        }
      : null;

  const toolsForSession = serializeTools(options.tools);
  const toolChoice = serializeToolChoice(options.spec.toolChoice);

  const event: OpenAIRealtimeClientEvent = {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: options.spec.systemPrompt ?? undefined,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: toOpenAIAudioFormat(audio.input.format),
          ...(transcriptionEnabled
            ? {
                transcription: {
                  model: 'whisper-1',
                  ...(language ? { language } : {})
                }
              }
            : {}),
          turn_detection: turnDetection
        },
        output: {
          format: toOpenAIAudioFormat(audio.output.format)
        }
      },
      ...(toolsForSession ? { tools: toolsForSession } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {})
    }
  };

  return { event, audio };
}

export function buildConversationItemCreateEvent(options: {
  text: string;
  role: 'system' | 'user';
}): OpenAIRealtimeClientEvent {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: options.role,
      content: [{ type: 'input_text', text: options.text }]
    }
  };
}

export function buildInputAudioAppendEvent(frame: RealtimeAudioFrame): OpenAIRealtimeClientEvent {
  return { type: 'input_audio_buffer.append', audio: frame.dataBase64 };
}

export function buildInputAudioCommitEvent(): OpenAIRealtimeClientEvent {
  return { type: 'input_audio_buffer.commit' };
}

export function buildResponseCreateEvent(): OpenAIRealtimeClientEvent {
  return { type: 'response.create' };
}

export function buildResponseCancelEvent(): OpenAIRealtimeClientEvent {
  return { type: 'response.cancel' };
}

export function buildToolResultItemCreateEvent(options: {
  toolCallId: string;
  result: JsonValue;
}): OpenAIRealtimeClientEvent {
  const output = typeof options.result === 'string' ? options.result : JSON.stringify(options.result);
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: options.toolCallId,
      output
    }
  };
}
