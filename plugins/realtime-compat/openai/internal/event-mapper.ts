import type { JsonObject, RealtimeAudioFrame, RealtimeEvent } from '../../../../kernel/index.js';

export interface OpenAIRealtimeMapperState {
  audio: { input: RealtimeAudioFrame; output: RealtimeAudioFrame };
  functionNameByCallId: Map<string, string>;
  toolNameByProviderName: Map<string, string>;
}

function resolveToolNameFromProviderName(providerName: string, state: OpenAIRealtimeMapperState): string {
  const direct = state.toolNameByProviderName.get(providerName);
  if (direct) return direct;

  if (!providerName) return providerName;

  let match: string | undefined;
  for (const candidate of state.toolNameByProviderName.keys()) {
    if (candidate.startsWith(`${providerName}_`) || candidate.startsWith(`${providerName}-`)) {
      if (match) return providerName;
      match = candidate;
    }
  }

  if (match) return state.toolNameByProviderName.get(match)!;

  return providerName;
}

function parseJsonObject(text: string): JsonObject {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as JsonObject;
}

export function mapOpenAIRealtimeServerEvent(
  evt: any,
  state: OpenAIRealtimeMapperState
): RealtimeEvent[] {
  const type = String(evt?.type ?? '');

  switch (type) {
    case 'error': {
      const message = String(evt?.error?.message ?? 'Realtime error');
      const code = evt?.error?.code ? String(evt.error.code) : undefined;
      return [{ type: 'error', message, ...(code ? { code } : {}) }];
    }
    case 'input_audio_buffer.speech_started': {
      const audioStartMsRaw = (evt as any)?.audio_start_ms;
      const audioStartMs = typeof audioStartMsRaw === 'number' ? audioStartMsRaw : undefined;
      return [{ type: 'user_speech.started', ...(audioStartMs !== undefined ? { audioStartMs } : {}) }];
    }
    case 'input_audio_buffer.speech_stopped': {
      const audioEndMsRaw = (evt as any)?.audio_end_ms;
      const audioEndMs = typeof audioEndMsRaw === 'number' ? audioEndMsRaw : undefined;
      return [{ type: 'user_speech.stopped', ...(audioEndMs !== undefined ? { audioEndMs } : {}) }];
    }
    case 'conversation.item.input_audio_transcription.delta': {
      const delta = String(evt?.delta ?? '');
      if (!delta) return [];
      return [{ type: 'user_transcript.delta', textDelta: delta }];
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const transcript = String(evt?.transcript ?? '');
      if (!transcript) return [];
      return [{ type: 'user_transcript.final', text: transcript }];
    }
    case 'response.output_audio.delta': {
      const delta = String(evt?.delta ?? '');
      if (!delta) return [];
      return [
        {
          type: 'assistant_audio.chunk',
          frame: {
            format: state.audio.output.format,
            sampleRateHz: state.audio.output.sampleRateHz,
            channels: state.audio.output.channels,
            dataBase64: delta
          }
        }
      ];
    }
    case 'response.output_audio.done':
      return [{ type: 'assistant_audio.end' }];
    case 'response.output_audio_transcript.delta': {
      const delta = String(evt?.delta ?? '');
      if (!delta) return [];
      return [{ type: 'assistant_transcript.delta', textDelta: delta }];
    }
    case 'response.output_audio_transcript.done': {
      const transcript = String(evt?.transcript ?? '');
      if (!transcript) return [];
      return [{ type: 'assistant_transcript.final', text: transcript }];
    }
    case 'response.output_text.delta': {
      const delta = String(evt?.delta ?? '');
      if (!delta) return [];
      return [{ type: 'assistant_text.delta', textDelta: delta }];
    }
    case 'response.output_text.done': {
      const text = String(evt?.text ?? '');
      if (!text) return [];
      return [{ type: 'assistant_text.final', text }];
    }
    case 'response.output_item.added': {
      const item = evt?.item;
      if (item?.type !== 'function_call') return [];
      const callId = String(item?.call_id ?? item?.id ?? '');
      const providerName = String(item?.name ?? '');
      const name = resolveToolNameFromProviderName(providerName, state);
      if (!callId || !name) return [];
      state.functionNameByCallId.set(callId, name);
      return [{ type: 'tool_call.start', toolCallId: callId, name }];
    }
    case 'response.function_call_arguments.delta': {
      const callId = String(evt?.call_id ?? '');
      const delta = String(evt?.delta ?? '');
      if (!callId || !delta) return [];
      return [{ type: 'tool_call.arguments_delta', toolCallId: callId, jsonDelta: delta }];
    }
    case 'response.function_call_arguments.done': {
      const callId = String(evt?.call_id ?? '');
      const argsText = String(evt?.arguments ?? '');
      if (!callId || !argsText) return [];
      const name = state.functionNameByCallId.get(callId) ?? 'unknown';
      // Prevent unbounded per-session growth for long-running sessions.
      state.functionNameByCallId.delete(callId);
      const argumentsObj = parseJsonObject(argsText);
      return [{ type: 'tool_call.end', toolCallId: callId, name, arguments: argumentsObj }];
    }
    case 'response.done': {
      const usage = evt?.response?.usage;
      if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return [];
      return [
        {
          type: 'usage',
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
          outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
          metadata: usage
        }
      ];
    }
    default:
      return [];
  }
}
