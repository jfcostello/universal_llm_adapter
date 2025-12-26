import type { RealtimeAudioFrame, RealtimeEvent } from '../../../../kernel/index.js';
import { convertProviderAudioToSessionOutput } from './audio.js';

type GeminiFunctionCall = { id?: string; name?: string; args?: any };

export interface GeminiRealtimeMapperState {
  audio: { input: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'>; output: Omit<RealtimeAudioFrame, 'dataBase64' | 'timestampMs'> };
  unifiedToolNameByProviderName: Map<string, string>;
  toolNameByCallId: Map<string, string>;
  toolCallSeq: number;
  sawUsageThisTurn: boolean;
  pendingUsage?: { inputTokens?: number; outputTokens?: number; metadata?: Record<string, number> };
  userTranscriptRaw: string;
  userTranscript: string;
  pendingUserTranscriptFinal: boolean;
  assistantTranscriptRaw: string;
  assistantTranscript: string;
}

function safeString(v: any): string {
  return typeof v === 'string' ? v : '';
}

function safeObject(v: any): Record<string, any> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, any>;
}

function tryParseJsonObject(value: any): Record<string, any> | null {
  const obj = safeObject(value);
  if (obj) return obj;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return safeObject(parsed);
  } catch {
    return null;
  }
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

  const captureUsage = (usage: any) => {
    const u = safeObject(usage);
    if (!u) return;
    const inputTokens = typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined;
    const outputTokens = typeof u.responseTokenCount === 'number' ? u.responseTokenCount : undefined;

    const metadata: Record<string, number> = {};
    if (typeof u.totalTokenCount === 'number') metadata.totalTokenCount = u.totalTokenCount;
    if (typeof u.cachedContentTokenCount === 'number') metadata.cachedContentTokenCount = u.cachedContentTokenCount;

    state.pendingUsage = {
      inputTokens,
      outputTokens,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    };
    state.sawUsageThisTurn = true;
  };

  // usageMetadata can be attached to any server message.
  if (message.usageMetadata) captureUsage(message.usageMetadata);

  if (message.goAway && typeof message.goAway === 'object') {
    const timeLeftMs = typeof message.goAway.timeLeft === 'string' ? message.goAway.timeLeft : undefined;
    if (state.pendingUsage) {
      events.push({ type: 'usage', ...state.pendingUsage });
      state.pendingUsage = undefined;
      state.sawUsageThisTurn = false;
    }
    events.push({
      type: 'error',
      message: 'Server requested disconnect',
      code: timeLeftMs ? `go_away:${timeLeftMs}` : 'go_away'
    });
    return events;
  }

  const toolCallPayload = safeObject(message.toolCall) ?? safeObject(message.serverContent?.toolCall);
  if (toolCallPayload) {
    const calls = Array.isArray(toolCallPayload.functionCalls) ? toolCallPayload.functionCalls : [];
    for (const call of calls as GeminiFunctionCall[]) {
      const rawId = (call as any)?.id;
      if (rawId !== undefined && rawId !== null && typeof rawId !== 'string') continue;
      const providerName = safeString(call?.name);
      const args = tryParseJsonObject(call?.args);
      if (!providerName || !args) continue;
      const id = safeString(call?.id) || `call_${++state.toolCallSeq}`;
      state.toolNameByCallId.set(id, providerName);
      const unifiedName = state.unifiedToolNameByProviderName.get(providerName) ?? providerName;
      events.push({ type: 'tool_call.start', toolCallId: id, name: unifiedName });
      events.push({ type: 'tool_call.end', toolCallId: id, name: unifiedName, arguments: args });
    }
    return events;
  }

  if (message.serverContent && typeof message.serverContent === 'object') {
    const sc = message.serverContent;
    if (sc.usageMetadata) captureUsage(sc.usageMetadata);

    if (sc.interrupted === true) {
      events.push({ type: 'playback.clear_requested', reason: 'barge_in', atMs: Date.now() });
      // Reset output buffers so subsequent deltas are sane.
      state.assistantTranscriptRaw = '';
      state.assistantTranscript = '';
    }

    if (sc.inputTranscription && typeof sc.inputTranscription === 'object') {
      const next = safeString(sc.inputTranscription.text ?? sc.inputTranscription.transcript ?? sc.inputTranscription.value);
      const delta = diffAsDelta(state.userTranscriptRaw, next);
      state.userTranscriptRaw = next;
      if (delta) {
        state.userTranscript += delta;
        events.push({ type: 'user_transcript.delta', textDelta: delta });
      }
    }

    if (sc.outputTranscription && typeof sc.outputTranscription === 'object') {
      const next = safeString(sc.outputTranscription.text);
      const delta = diffAsDelta(state.assistantTranscriptRaw, next);
      state.assistantTranscriptRaw = next;
      if (delta) {
        state.assistantTranscript += delta;
        events.push({ type: 'assistant_transcript.delta', textDelta: delta });
      }
    }

    const modelTurn = sc.modelTurn;
    if (modelTurn && typeof modelTurn === 'object' && Array.isArray(modelTurn.parts)) {
      for (const part of modelTurn.parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.functionCall && typeof part.functionCall === 'object') {
          const rawId = (part.functionCall as any)?.id;
          if (rawId === undefined || rawId === null || typeof rawId === 'string') {
            const providerName = safeString(part.functionCall.name);
            const args = tryParseJsonObject(part.functionCall.args);
            if (providerName && args) {
              const id = safeString(part.functionCall.id) || `call_${++state.toolCallSeq}`;
              state.toolNameByCallId.set(id, providerName);
              const unifiedName = state.unifiedToolNameByProviderName.get(providerName) ?? providerName;
              events.push({ type: 'tool_call.start', toolCallId: id, name: unifiedName });
              events.push({ type: 'tool_call.end', toolCallId: id, name: unifiedName, arguments: args });
            }
          }
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
      if (state.pendingUserTranscriptFinal && state.userTranscript.trim()) {
        events.push({ type: 'user_transcript.final', text: state.userTranscript });
        state.userTranscript = '';
        state.userTranscriptRaw = '';
        state.pendingUserTranscriptFinal = false;
      }
      if (state.assistantTranscript) {
        events.push({ type: 'assistant_transcript.final', text: state.assistantTranscript });
        state.assistantTranscriptRaw = '';
        state.assistantTranscript = '';
      }
      events.push({ type: 'assistant_audio.end' });

      // Emit `usage` last so clients/tests can treat it as a stable end-of-turn marker.
      if (state.pendingUsage) {
        events.push({ type: 'usage', ...state.pendingUsage });
      } else {
        // Some Live messages (notably interrupted turns) omit usage metadata; still emit a usage marker
        // so clients/tests have a consistent turn-completion signal.
        events.push({ type: 'usage' });
      }
      state.pendingUsage = undefined;
      state.sawUsageThisTurn = false;
    }

    return events;
  }

  return events;
}
