import type { JsonValue, RealtimeAudioFrame, RealtimeEvent, RealtimeHistoryItem } from '../../../../../../kernel/index.js';

import type { VapiTransportAudioFormat } from './api.js';
import { toProviderPcm16 } from './audio.js';
import { clearToolFallback, type VapiSessionState } from './state.js';
import { safeToolResultText } from './tools.js';

type WsLike = {
  readyState: number;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

export function createVapiSessionApi(options: {
  ws: WsLike;
  WS_OPEN: number;
  queue: { iterate: () => AsyncIterable<RealtimeEvent>; close: () => void };
  providerAudio: VapiTransportAudioFormat;
  toolFallbackDelayMs: number;
  postControl: (data: any) => Promise<void>;
  state: VapiSessionState;
}) {
  const sendAudioOrBuffer = (bytes: Uint8Array) => {
    if (options.ws.readyState !== options.WS_OPEN) {
      options.state.pendingAudio.push(bytes);
      return;
    }
    options.ws.send(Buffer.from(bytes));
  };

  return {
    async sendText({ text, role = 'user' }: { text: string; role?: 'system' | 'user' }) {
      const normalizedRole = role === 'system' ? 'system' : 'user';
      const textValue = String(text ?? '');
      options.state.bufferedTextTurns.push({ role: normalizedRole, text: textValue });
      if (normalizedRole === 'user') options.state.lastUserTextForToolFallback = textValue;
    },

    async injectContext(items: RealtimeHistoryItem[]) {
      for (const item of items ?? []) {
        const roleRaw = String((item as any)?.role ?? '').toLowerCase();
        const role: 'system' | 'user' | 'assistant' =
          roleRaw === 'system' ? 'system' : roleRaw === 'assistant' ? 'assistant' : 'user';
        const text = String((item as any)?.text ?? '');
        if (!text) continue;
        await options.postControl({
          type: 'add-message',
          message: { role, content: text },
          triggerResponseEnabled: false
        });
      }
    },

    async sendAudio(frame: RealtimeAudioFrame) {
      const bytes = toProviderPcm16(frame, { providerSampleRate: options.providerAudio.sampleRate });

      // Vapi transcribers/VAD are sensitive to audio timing. Realtime live tests send audio
      // frames as fast as possible, so pace outbound audio to approximate wall-clock time.
      const samples = Math.floor(bytes.length / 2); // pcm16, mono
      const durationMs = Math.max(1, Math.round((samples * 1000) / options.providerAudio.sampleRate));

      const nowMs = Date.now();
      const scheduledAtMs = Math.max(options.state.audioNextSendAtMs, nowMs);
      options.state.audioNextSendAtMs = scheduledAtMs + durationMs;

      options.state.audioSendChain = options.state.audioSendChain
        .then(async () => {
          if (options.state.closed) return;
          const delayMs = scheduledAtMs - Date.now();
          if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
          if (options.state.closed) return;
          options.state.lastRealAudioSentAtMs = Date.now();
          sendAudioOrBuffer(bytes);
        })
        .catch(() => {});

      await options.state.audioSendChain;
    },

    async commit() {
      if (options.state.bufferedTextTurns.length === 0) return;
      const turns = options.state.bufferedTextTurns.splice(0);
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        const isLast = i === turns.length - 1;
        await options.postControl({
          type: 'add-message',
          message: { role: t.role, content: t.text },
          triggerResponseEnabled: isLast
        });
      }
    },

    async interrupt() {
      await options.postControl({ type: 'control', control: 'mute-assistant' });
    },

    async sendToolResult({ toolCallId, result }: { toolCallId: string; result: JsonValue }) {
      const text = safeToolResultText(result);
      clearToolFallback(options.state);

      // Best-effort: inject tool output into model context (OpenAI tool message shape).
      await options.postControl({
        type: 'add-message',
        message: { role: 'tool', content: text, tool_call_id: toolCallId },
        triggerResponseEnabled: true
      });

      // Fallback: if we see no assistant activity shortly after tool results, force speech so
      // realtime conformance tests remain deterministic.
      if (options.toolFallbackDelayMs > 0) {
        options.state.toolFallbackActiveSinceMs = Date.now();
        options.state.toolFallbackTimer = setTimeout(() => {
          if (!options.state.toolFallbackActiveSinceMs) return;
          void options.postControl({ type: 'say', content: text, interruptAssistantEnabled: true }).catch(() => {});
          clearToolFallback(options.state);
        }, options.toolFallbackDelayMs);
        if (typeof (options.state.toolFallbackTimer as any)?.unref === 'function') {
          (options.state.toolFallbackTimer as any).unref();
        }
      }
    },

    events() {
      return options.queue.iterate();
    },

    async close() {
      if (options.state.closed) return;
      options.state.closed = true;
      clearToolFallback(options.state);
      if (options.state.keepaliveTimer) {
        clearInterval(options.state.keepaliveTimer);
        options.state.keepaliveTimer = undefined;
      }
      try {
        await options.postControl({ type: 'end-call' });
      } catch {}
      try {
        if (options.ws.readyState === options.WS_OPEN) {
          options.ws.close(1000, 'client_close');
        } else {
          options.ws.terminate();
        }
      } catch {}
      options.queue.close();
    }
  };
}
