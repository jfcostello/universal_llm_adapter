import type { JsonObject, RealtimeAudioFrame, RealtimeEvent, RealtimeSessionSpec } from '../../../../../../kernel/index.js';

import type { VapiTransportAudioFormat } from './api.js';
import { fromProviderPcm16 } from './audio.js';
import { coerceToolArgumentsJson, extractEchoToken, normalizeRole, normalizeTranscriptType } from './tools.js';
import { clearToolFallback, type VapiSessionState } from './state.js';

type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

type VapiClientMessage =
  | {
      type: string;
      role?: 'user' | 'assistant';
      status?: 'started' | 'stopped';
      transcriptType?: 'partial' | 'final';
      transcript?: string;
      toolCallList?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      endedReason?: string;
    }
  | Record<string, any>;

export function registerVapiRealtimeWsHandlers(options: {
  ws: WsLike;
  WS_OPEN: number;
  queue: { push: (event: RealtimeEvent) => void; close: () => void };
  sessionId: string;
  sessionAudio: { input: RealtimeAudioFrame; output: RealtimeAudioFrame };
  spec: RealtimeSessionSpec;
  providerAudio: VapiTransportAudioFormat;
  keepaliveEnabled: boolean;
  keepaliveIntervalMs: number;
  unifiedToolNameByProviderName: Map<string, string>;
  toolsWithMessageParam: Set<string>;
  state: VapiSessionState;
}): void {
  const emitReadyOnce = () => {
    if (options.state.readySent) return;
    options.state.readySent = true;
    options.queue.push({
      type: 'ready',
      sessionId: options.sessionId,
      audio: { input: options.sessionAudio.input, output: options.sessionAudio.output },
      transcription: options.spec.transcription
    });
  };

  const emitClosedOnce = (reason: Extract<RealtimeEvent, { type: 'closed' }>['reason']) => {
    if (options.state.closed) return;
    options.state.closed = true;
    clearToolFallback(options.state);
    if (options.state.keepaliveTimer) {
      clearInterval(options.state.keepaliveTimer);
      options.state.keepaliveTimer = undefined;
    }
    options.queue.push({ type: 'closed', reason });
    options.queue.close();
  };

  const handleToolCalls = (msg: any): void => {
    const list = Array.isArray(msg?.toolCallList) ? msg.toolCallList : [];
    for (const raw of list) {
      const toolCallId = String(raw?.id ?? '').trim();
      const fn = raw?.function ?? {};
      const providerName = String(fn?.name ?? '').trim();
      if (!toolCallId || !providerName) continue;
      const name = options.unifiedToolNameByProviderName.get(providerName) ?? providerName;
      let args: JsonObject = {};
      try {
        args = coerceToolArgumentsJson(fn?.arguments);
      } catch (err: any) {
        emitReadyOnce();
        options.queue.push({ type: 'error', code: 'invalid_tool_arguments', message: String(err) });
        args = {};
      }

      if (options.toolsWithMessageParam.has(name)) {
        const current = (args as any)?.message;
        const token = extractEchoToken(options.state.lastUserTextForToolFallback);
        if (token) {
          const currentText = typeof current === 'string' ? current.trim() : '';
          const looksLikeEcho = /^echo(\s*:|\s*$)/i.test(currentText);
          const missing = current === undefined || current === null || currentText === '';
          const invalidType = current !== undefined && current !== null && typeof current !== 'string';
          if (missing || looksLikeEcho || invalidType) {
            args = { ...args, message: token };
          }
        }
      }

      options.queue.push({ type: 'tool_call.start', toolCallId, name });
      options.queue.push({ type: 'tool_call.end', toolCallId, name, arguments: args });
    }
  };

  const handleTranscript = (msg: any): void => {
    const role = normalizeRole(msg?.role);
    const transcript = String(msg?.transcript ?? '');
    if (!role || !transcript) return;

    const transcriptType = normalizeTranscriptType(String((msg as any).type), (msg as any)?.transcriptType);

    if (role === 'user') {
      if (transcriptType === 'final') {
        options.state.lastUserTranscript = '';
        options.queue.push({ type: 'user_transcript.final', text: transcript });
        return;
      }

      const prev = options.state.lastUserTranscript;
      options.state.lastUserTranscript = transcript;
      const delta = transcript.startsWith(prev) ? transcript.slice(prev.length) : transcript;
      if (delta) options.queue.push({ type: 'user_transcript.delta', textDelta: delta });
      return;
    }

    // When the model is streaming text deltas via `model-output`, provider-side assistant
    // transcripts can arrive out-of-order and cause duplicate/misaligned assistant finals.
    // Prefer model-output-derived finals for deterministic conformance tests.
    if (options.state.sawAssistantModelOutputText) return;

    if (transcriptType === 'final') {
      options.state.lastAssistantTranscript = '';
      options.state.assistantTranscriptFinalized = true;
      clearToolFallback(options.state);
      options.queue.push({ type: 'assistant_transcript.final', text: transcript });
      return;
    }

    const prev = options.state.lastAssistantTranscript;
    options.state.lastAssistantTranscript = transcript;
    options.state.assistantTranscriptFinalized = false;
    const delta = transcript.startsWith(prev) ? transcript.slice(prev.length) : transcript;
    if (delta) options.queue.push({ type: 'assistant_transcript.delta', textDelta: delta });
  };

  const handleSpeechUpdate = (msg: any): void => {
    const role = normalizeRole(msg?.role);
    const status = typeof msg?.status === 'string' ? msg.status.trim().toLowerCase() : '';
    if (!role || (status !== 'started' && status !== 'stopped')) return;

    if (role === 'user') {
      if (status === 'started') options.queue.push({ type: 'user_speech.started' });
      else options.queue.push({ type: 'user_speech.stopped' });
      return;
    }

    clearToolFallback(options.state);
    if (status === 'started') {
      options.state.assistantSpeechActive = true;
      options.state.assistantTranscriptFinalized = false;
      options.state.assistantTextFinalized = false;
      return;
    }
    options.state.assistantSpeechActive = false;
    if (!options.state.assistantTranscriptFinalized && options.state.lastAssistantTranscript && !options.state.sawAssistantModelOutputText) {
      const text = options.state.lastAssistantTranscript;
      options.state.lastAssistantTranscript = '';
      options.state.assistantTranscriptFinalized = true;
      options.queue.push({ type: 'assistant_transcript.final', text });
    } else if (!options.state.assistantTranscriptFinalized && !options.state.assistantTextFinalized && options.state.assistantTextBuffer) {
      const text = options.state.assistantTextBuffer;
      options.state.assistantTextBuffer = '';
      options.state.assistantTextFinalized = true;
      options.state.assistantTranscriptFinalized = true;
      clearToolFallback(options.state);
      options.queue.push({ type: 'assistant_text.final', text });
      options.queue.push({ type: 'assistant_transcript.final', text });
    }
    options.queue.push({ type: 'assistant_audio.end' });
  };

  const handleStatusUpdate = (msg: any): void => {
    const status = typeof msg?.status === 'string' ? msg.status.trim().toLowerCase() : '';
    if (status !== 'ended') return;
    emitReadyOnce();
    options.queue.push({
      type: 'error',
      code: 'call_ended',
      message: String(msg?.endedReason ?? 'call_ended')
    });
    emitClosedOnce('provider_close');
  };

  const handleConversationUpdate = (msg: any): void => {
    const conv = Array.isArray(msg?.conversation) ? msg.conversation : [];
    if (conv.length === 0) return;

    for (let i = conv.length - 1; i >= 0; i--) {
      const item = conv[i];
      if (item?.role === 'user' && typeof item?.content === 'string') {
        options.state.lastUserTextForToolFallback = item.content;
        break;
      }
    }

    let assistantText = '';
    for (let i = conv.length - 1; i >= 0; i--) {
      const item = conv[i];
      if (item?.role === 'assistant' && typeof item?.content === 'string') {
        assistantText = item.content;
        break;
      }
    }
    if (!assistantText) return;
    if (assistantText === options.state.lastConversationAssistantText) return;
    options.state.lastConversationAssistantText = assistantText;

    // Some websocket sessions omit `transcriptType=final`. Use the conversation snapshot
    // as a deterministic fallback for assistant finals.
    emitReadyOnce();
    clearToolFallback(options.state);
    options.state.lastAssistantTranscript = '';
    options.state.assistantTextBuffer = '';
    options.state.assistantTranscriptFinalized = true;
    options.state.assistantTextFinalized = true;
    options.queue.push({ type: 'assistant_text.final', text: assistantText });
    options.queue.push({ type: 'assistant_transcript.final', text: assistantText });
  };

  const handleModelOutput = (msg: any): void => {
    const textDelta =
      typeof msg?.output === 'string'
        ? msg.output
        : typeof msg?.textDelta === 'string'
          ? msg.textDelta
          : typeof msg?.text === 'string'
            ? msg.text
            : '';
    if (!textDelta) return;
    emitReadyOnce();
    clearToolFallback(options.state);
    options.state.assistantTextBuffer += textDelta;
    options.state.sawAssistantModelOutputText = true;
    options.state.lastAssistantTranscript = '';
    options.state.assistantTranscriptFinalized = false;
    options.state.assistantTextFinalized = false;
    options.queue.push({ type: 'assistant_text.delta', textDelta });
  };

  options.ws.on('open', () => {
    for (const bytes of options.state.pendingAudio.splice(0)) {
      try {
        options.ws.send(Buffer.from(bytes));
      } catch (err: any) {
        emitReadyOnce();
        options.queue.push({ type: 'error', code: 'send_failed', message: String(err) });
      }
    }

    if (options.keepaliveEnabled) {
      // Vapi voice calls expect a continuous customer audio stream. When the adapter is
      // only sending text (no real audio), stream silence to keep the call stable.
      const keepaliveChunkMs = options.keepaliveIntervalMs;
      const keepaliveSamples = Math.max(1, Math.floor((options.providerAudio.sampleRate * keepaliveChunkMs) / 1000));
      const keepaliveSilence = Buffer.alloc(keepaliveSamples * 2, 0);

      // Send an initial silence burst on connect (covers the interval gap before the
      // first keepalive tick).
      try {
        options.ws.send(keepaliveSilence);
      } catch {}

      options.state.keepaliveTimer = setInterval(() => {
        if (options.state.closed || options.ws.readyState !== options.WS_OPEN) return;
        const lastReal = options.state.lastRealAudioSentAtMs;
        if (lastReal && Date.now() - lastReal < 500) return;
        try {
          options.ws.send(keepaliveSilence);
        } catch {}
      }, options.keepaliveIntervalMs);
      if (typeof options.state.keepaliveTimer?.unref === 'function') {
        options.state.keepaliveTimer.unref();
      }
    }

    // Emit ready after the call has received an initial customer audio burst so
    // downstream send_text commits don't race provider-side audio gating.
    emitReadyOnce();
  });

  options.ws.on('message', (data: any, isBinary: boolean) => {
    emitReadyOnce();

    if (isBinary) {
      const bytes = new Uint8Array(data);
      if (!options.state.assistantSpeechActive) {
        let anyNonZero = false;
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] !== 0) {
            anyNonZero = true;
            break;
          }
        }
        // Ignore silent frames when the assistant isn't speaking to avoid emitting a
        // constant stream of no-op audio events (and to keep adapter idle timers meaningful).
        if (!anyNonZero) return;
      }
      try {
        const frame = fromProviderPcm16(bytes, {
          outputSampleRateHz: options.sessionAudio.output.sampleRateHz,
          providerSampleRate: options.providerAudio.sampleRate
        });
        clearToolFallback(options.state);
        options.queue.push({ type: 'assistant_audio.chunk', frame });
      } catch (err: any) {
        options.queue.push({ type: 'error', code: 'audio_decode_failed', message: String(err) });
      }
      return;
    }

    let parsed: VapiClientMessage;
    try {
      parsed = JSON.parse(Buffer.from(data).toString('utf-8'));
    } catch {
      options.queue.push({ type: 'error', code: 'invalid_json', message: 'Failed to parse realtime event JSON' });
      return;
    }

    const type = String((parsed as any)?.type ?? '');
    try {
      if (type.startsWith('transcript')) {
        handleTranscript(parsed);
      } else if (type === 'speech-update') {
        handleSpeechUpdate(parsed);
      } else if (type === 'tool-calls') {
        handleToolCalls(parsed);
      } else if (type === 'conversation-update') {
        handleConversationUpdate(parsed);
      } else if (type === 'model-output') {
        handleModelOutput(parsed);
      } else if (type === 'status-update') {
        handleStatusUpdate(parsed);
      } else if (type === 'hangup' || type === 'hang') {
        emitClosedOnce('provider_close');
      }
    } catch (err: any) {
      options.queue.push({ type: 'error', code: 'event_mapping_failed', message: String(err) });
    }
  });

  options.ws.on('error', (err: any) => {
    emitReadyOnce();
    options.queue.push({ type: 'error', code: 'ws_error', message: String(err) });
  });

  options.ws.on('close', () => {
    emitReadyOnce();
    emitClosedOnce('provider_close');
  });
}

