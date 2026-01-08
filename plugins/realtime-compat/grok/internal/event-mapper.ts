import type { JsonObject, RealtimeAudioFrame, RealtimeEvent } from '../../../../kernel/index.js';

export interface GrokRealtimeMapperState {
  audio: { input: RealtimeAudioFrame; output: RealtimeAudioFrame };
  toolNameByProviderName: Map<string, string>;
  functionNameByCallId: Map<string, string>;
  userTranscript: string;
  pendingUserTranscriptFinal: boolean;
  userTranscriptFinalEmitted: boolean;
  assistantTranscript: string;
  assistantAudioInProgress: boolean;
}

function parseJsonObject(text: string): JsonObject {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as JsonObject;
}

function coerceJsonObject(value: any): JsonObject {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') return parseJsonObject(value);
  if (typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  throw new Error('Tool arguments must be a JSON object');
}

function maybeEmitUserTranscriptFinal(events: RealtimeEvent[], state: GrokRealtimeMapperState): void {
  if (!state.pendingUserTranscriptFinal) return;
  // If we've already emitted a final transcript for this turn, drop any pending flush attempts.
  if (state.userTranscriptFinalEmitted) {
    state.pendingUserTranscriptFinal = false;
    state.userTranscript = '';
    return;
  }

  const text = state.userTranscript.trim();
  state.pendingUserTranscriptFinal = false;
  state.userTranscript = '';
  if (!text) return;
  state.userTranscriptFinalEmitted = true;
  events.push({ type: 'user_transcript.final', text });
}

function safeJsonObject(value: any): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function buildUsageEvent(evt: any): Extract<RealtimeEvent, { type: 'usage' }> {
  const usage = safeJsonObject(evt?.response?.usage);
  const inputTokens = usage && typeof (usage as any).input_tokens === 'number' ? (usage as any).input_tokens : undefined;
  const outputTokens = usage && typeof (usage as any).output_tokens === 'number' ? (usage as any).output_tokens : undefined;

  return {
    type: 'usage',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(usage ? { metadata: usage } : {})
  };
}

export function mapGrokRealtimeServerEvent(evt: any, state: GrokRealtimeMapperState): RealtimeEvent[] {
  const type = String(evt?.type ?? '');

  switch (type) {
    case 'error': {
      const message = String(evt?.error?.message ?? 'Realtime error');
      const code = evt?.error?.code ? String(evt.error.code) : undefined;
      return [{ type: 'error', message, ...(code ? { code } : {}) }];
    }
    case 'input_audio_buffer.speech_started':
      state.userTranscript = '';
      state.pendingUserTranscriptFinal = false;
      state.userTranscriptFinalEmitted = false;
      {
        const audioStartMsRaw = (evt as any)?.audio_start_ms;
        const audioStartMs = typeof audioStartMsRaw === 'number' ? audioStartMsRaw : undefined;
        return [{ type: 'user_speech.started', ...(audioStartMs !== undefined ? { audioStartMs } : {}) }];
      }
    case 'input_audio_buffer.speech_stopped':
      state.pendingUserTranscriptFinal = true;
      {
        const audioEndMsRaw = (evt as any)?.audio_end_ms;
        const audioEndMs = typeof audioEndMsRaw === 'number' ? audioEndMsRaw : undefined;
        return [{ type: 'user_speech.stopped', ...(audioEndMs !== undefined ? { audioEndMs } : {}) }];
      }
    case 'conversation.item.input_audio_transcription.delta': {
      const delta = String(evt?.delta ?? '');
      if (!delta) return [];
      state.userTranscript += delta;
      return [{ type: 'user_transcript.delta', textDelta: delta }];
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const transcript = String(evt?.transcript ?? '');
      if (!transcript) return [];
      if (state.userTranscriptFinalEmitted) return [];
      state.userTranscriptFinalEmitted = true;
      state.pendingUserTranscriptFinal = false;
      state.userTranscript = '';
      return [{ type: 'user_transcript.final', text: transcript }];
    }
    case 'response.output_audio.delta': {
      const delta = String(evt?.delta ?? '');
      if (!delta) return [];
      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);
      state.assistantAudioInProgress = true;
      events.push({
        type: 'assistant_audio.chunk',
        frame: {
          format: state.audio.output.format,
          sampleRateHz: state.audio.output.sampleRateHz,
          channels: state.audio.output.channels,
          dataBase64: delta
        }
      });
      return events;
    }
    case 'response.output_audio.done':
      {
        const events: RealtimeEvent[] = [];
        maybeEmitUserTranscriptFinal(events, state);
        state.assistantAudioInProgress = false;
        events.push({ type: 'assistant_audio.end' });
        return events;
      }
    case 'response.output_audio_transcript.delta': {
      const delta = String(evt?.delta ?? '');
      if (!delta) return [];
      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);
      state.assistantTranscript += delta;
      events.push({ type: 'assistant_transcript.delta', textDelta: delta });
      return events;
    }
    case 'response.output_audio_transcript.done': {
      const transcript = String(evt?.transcript ?? '');
      if (!transcript) return [];
      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);
      state.assistantTranscript = '';
      events.push({ type: 'assistant_transcript.final', text: transcript });
      return events;
    }
    case 'response.output_item.added': {
      const item = evt?.item;
      if (item?.type !== 'function_call') return [];
      const callId = String(item?.call_id ?? item?.id ?? '');
      const providerName = String(item?.name ?? '');
      const name = state.toolNameByProviderName.get(providerName) ?? providerName;
      if (!callId || !name) return [];
      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);
      state.functionNameByCallId.set(callId, name);
      events.push({ type: 'tool_call.start', toolCallId: callId, name });
      return events;
    }
    case 'response.function_call_arguments.delta': {
      const callId = String(evt?.call_id ?? '');
      const delta = String(evt?.delta ?? '');
      if (!callId || !delta) return [];
      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);
      events.push({ type: 'tool_call.arguments_delta', toolCallId: callId, jsonDelta: delta });
      return events;
    }
    case 'response.function_call_arguments.done': {
      const callId = String(evt?.call_id ?? '');
      const argsText = String(evt?.arguments ?? '');
      if (!callId || !argsText) return [];
      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);
      const name = state.functionNameByCallId.get(callId) ?? 'unknown';
      // Prevent unbounded per-session growth for long-running sessions.
      state.functionNameByCallId.delete(callId);
      const argumentsObj = parseJsonObject(argsText);
      events.push({ type: 'tool_call.end', toolCallId: callId, name, arguments: argumentsObj });
      return events;
    }
    case 'response.output_item.done': {
      const item = evt?.item;
      if (item?.type !== 'function_call') return [];

      const callId = String(item?.call_id ?? item?.id ?? '');
      const providerName = String(item?.name ?? '');
      const name = state.toolNameByProviderName.get(providerName) ?? providerName;
      if (!callId || !name) return [];

      const rawArgs = item?.arguments ?? item?.args ?? item?.arguments_json;
      const argumentsObj = coerceJsonObject(rawArgs);

      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);
      if (!state.functionNameByCallId.has(callId)) {
        state.functionNameByCallId.set(callId, name);
        events.push({ type: 'tool_call.start', toolCallId: callId, name });
      }

      state.functionNameByCallId.delete(callId);
      events.push({ type: 'tool_call.end', toolCallId: callId, name, arguments: argumentsObj });
      return events;
    }
    case 'response.done': {
      const events: RealtimeEvent[] = [];
      maybeEmitUserTranscriptFinal(events, state);

      const status = String(evt?.response?.status ?? '').toLowerCase();
      const cancelled = status === 'cancelled' || status === 'canceled';

      if (!cancelled && state.assistantTranscript.trim()) {
        events.push({ type: 'assistant_transcript.final', text: state.assistantTranscript });
      }
      state.assistantTranscript = '';

      if (state.assistantAudioInProgress) {
        state.assistantAudioInProgress = false;
        events.push({ type: 'assistant_audio.end' });
      }

      // Emit `usage` last so clients/tests can treat it as a stable end-of-turn marker.
      events.push(buildUsageEvent(evt));
      return events;
    }
    default:
      return [];
  }
}
