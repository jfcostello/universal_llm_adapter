import type { RealtimeAudioFrame, RealtimeEvent } from '../../../../modules/kernel/index.js';
import { convertProviderAudioToSessionOutput } from './audio.js';

type GeminiFunctionCall = { id?: string; name?: string; args?: any };

export interface GeminiRealtimeMapperState {
  audio: { input: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>; output: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'> };
  toolNameByCallId: Map<string, string>;
  userTranscript: string;
  assistantTranscript: string;
  assistantText: string;
}

function safeString(v: any): string {
  return typeof v === 'string' ? v : '';
}

function diffAsDelta(prev: string, next: string): string {
  if (!next) return '';
  if (!prev) return next;
  return next.startsWith(prev) ? next.slice(prev.length) : next;
}

export function mapGeminiLiveServerMessage(message: any, state: GeminiRealtimeMapperState): RealtimeEvent[] {
  if (!message || typeof message !== 'object') return [];

  // setupComplete is server-side ack; session emits ready independently.
  if (message.setupComplete) {
    return [];
  }

  const events: RealtimeEvent[] = [];

  // usageMetadata can be attached to any server message; map it once.
  if (message.usageMetadata && typeof message.usageMetadata === 'object') {
    const usage = message.usageMetadata;
    const inputTokens = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined;
    const outputTokens = typeof usage.responseTokenCount === 'number' ? usage.responseTokenCount : undefined;
    events.push({
      type: 'usage',
      inputTokens,
      outputTokens,
      metadata: {
        totalTokenCount: typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : undefined,
        cachedContentTokenCount: typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : undefined
      }
    });
  }

  if (message.goAway && typeof message.goAway === 'object') {
    const timeLeftMs = typeof message.goAway.timeLeft === 'string' ? message.goAway.timeLeft : undefined;
    events.push({
      type: 'error',
      message: 'Server requested disconnect',
      code: timeLeftMs ? `go_away:${timeLeftMs}` : 'go_away'
    });
    return events;
  }

  if (message.toolCall && typeof message.toolCall === 'object') {
    const calls = Array.isArray(message.toolCall.functionCalls) ? message.toolCall.functionCalls : [];
    for (const call of calls as GeminiFunctionCall[]) {
      const id = safeString(call?.id);
      const name = safeString(call?.name);
      const args = call?.args;
      if (!id || !name || !args || typeof args !== 'object' || Array.isArray(args)) continue;
      state.toolNameByCallId.set(id, name);
      events.push({ type: 'tool_call.start', toolCallId: id, name });
      events.push({ type: 'tool_call.end', toolCallId: id, name, arguments: args });
    }
    return events;
  }

  if (message.serverContent && typeof message.serverContent === 'object') {
    const sc = message.serverContent;

    if (sc.interrupted === true) {
      events.push({ type: 'playback.clear_requested', reason: 'barge_in', atMs: Date.now() });
      // Reset output buffers so subsequent deltas are sane.
      state.assistantTranscript = '';
      state.assistantText = '';
    }

    if (sc.inputTranscription && typeof sc.inputTranscription === 'object') {
      const next = safeString(sc.inputTranscription.text);
      const delta = diffAsDelta(state.userTranscript, next);
      state.userTranscript = next;
      if (delta) events.push({ type: 'user_transcript.delta', textDelta: delta });
    }

    if (sc.outputTranscription && typeof sc.outputTranscription === 'object') {
      const next = safeString(sc.outputTranscription.text);
      const delta = diffAsDelta(state.assistantTranscript, next);
      state.assistantTranscript = next;
      if (delta) events.push({ type: 'assistant_transcript.delta', textDelta: delta });
    }

    const modelTurn = sc.modelTurn;
    if (modelTurn && typeof modelTurn === 'object' && Array.isArray(modelTurn.parts)) {
      for (const part of modelTurn.parts) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string' && part.text.length > 0) {
          state.assistantText += part.text;
          events.push({ type: 'assistant_text.delta', textDelta: part.text });
        }
        if (part.inlineData && typeof part.inlineData === 'object') {
          const mimeType = safeString(part.inlineData.mimeType);
          const data = safeString(part.inlineData.data);
          if (!mimeType || !data) continue;
          if (!mimeType.toLowerCase().startsWith('audio/')) continue;
          const frame = convertProviderAudioToSessionOutput({
            providerAudioBase64: data,
            providerMimeType: mimeType,
            desired: state.audio.output
          });
          events.push({ type: 'assistant_audio.chunk', frame });
        }
      }
    }

    if (sc.turnComplete === true || sc.generationComplete === true) {
      if (state.assistantTranscript) {
        events.push({ type: 'assistant_transcript.final', text: state.assistantTranscript });
        state.assistantTranscript = '';
      }
      if (state.assistantText) {
        events.push({ type: 'assistant_text.final', text: state.assistantText });
        state.assistantText = '';
      }
      events.push({ type: 'assistant_audio.end' });
    }

    return events;
  }

  return events;
}

