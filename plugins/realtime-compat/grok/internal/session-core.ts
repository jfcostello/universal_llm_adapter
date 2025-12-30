import type {
  IRealtimeCompat,
  JsonValue,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec
} from '../../../../kernel/index.js';
import { AsyncQueue, LruMap, resolveRealtimeToolCallTrackingMaxEntries } from '../../../../kernel/index.js';
import { createDeferred, type Deferred } from '../../../../modules/shared/index.js';

import {
  buildConversationItemCreateEvent,
  buildInputAudioAppendEvent,
  buildInputAudioCommitEvent,
  buildResponseCancelEvent,
  buildResponseCreateEvent,
  buildSessionUpdateEvent,
  buildToolResultItemCreateEvent
} from './commands.js';
import { type GrokRealtimeMapperState, mapGrokRealtimeServerEvent } from './event-mapper.js';

export type RealtimeTransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'error'; error: unknown; code?: string }
  | { type: 'close' };

export interface RealtimeTransport {
  send: (data: string) => void;
  events: () => AsyncIterable<RealtimeTransportEvent>;
  close: () => void;
}

function generateSessionId(): string {
  return `sess_local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createGrokRealtimeCompatSessionWithTransport(
  options: Parameters<IRealtimeCompat['createSession']>[0],
  transport: RealtimeTransport
): RealtimeCompatSession {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const queue = new AsyncQueue<RealtimeEvent>();
  const sessionId = generateSessionId();

  const toolCallTrackingMaxEntries = resolveRealtimeToolCallTrackingMaxEntries(spec);

  const { event: sessionUpdateEvent, audio, toolNameByProviderName, settingsWarnings } = buildSessionUpdateEvent({
    spec,
    tools: options.tools,
    defaultVoice: (provider.metadata as any)?.defaultVoice
  });

  const state: GrokRealtimeMapperState = {
    audio,
    toolNameByProviderName,
    functionNameByCallId: new LruMap<string, string>(toolCallTrackingMaxEntries, {
      label: 'realtime-tool-call-tracking(grok)',
      warnOnEvict: true
    }),
    userTranscript: '',
    pendingUserTranscriptFinal: false,
    userTranscriptFinalEmitted: false,
    assistantTranscript: '',
    assistantAudioInProgress: false
  };

  let sessionUpdateSent = false;
  let readySent = false;
  let closed = false;
  let hasAudioSinceCommit = false;
  let pendingTextTurn = false;

  const commitMode = spec.turnDetection?.mode ?? 'manual_commit';
  const forceToolChoiceOnCommit = typeof spec.toolChoice === 'object' && spec.toolChoice?.type === 'single';
  const preReadyEvents: RealtimeEvent[] = [];
  if (settingsWarnings.unknownKeys.length > 0) {
    preReadyEvents.push({
      type: 'error',
      code: 'unsupported_session_settings',
      message: `Unsupported session settings ignored: ${settingsWarnings.unknownKeys.sort().join(', ')}`
    });
  }
  if (settingsWarnings.invalidKeys.length > 0) {
    preReadyEvents.push({
      type: 'error',
      code: 'invalid_session_settings',
      message: `Invalid session settings ignored: ${settingsWarnings.invalidKeys.sort().join(', ')}`
    });
  }

  const READY_FALLBACK_MS = 10_000;
  let readyFallbackTimer: NodeJS.Timeout | undefined;
  const clearReadyFallback = () => {
    if (!readyFallbackTimer) return;
    clearTimeout(readyFallbackTimer);
    readyFallbackTimer = undefined;
  };
  const scheduleReadyFallback = () => {
    if (readySent || readyFallbackTimer) return;
    readyFallbackTimer = setTimeout(() => {
      readyFallbackTimer = undefined;
      if (!readySent && !sessionUpdateSent) {
        sessionUpdateSent = true;
        try { send(sessionUpdateEvent); } catch {}
      }
      emitReadyOnce();
    }, READY_FALLBACK_MS);
  };

  let pendingCancel: Deferred<void> | undefined;

  const send = (event: any): void => {
    transport.send(JSON.stringify(event));
  };

  const emitReadyOnce = () => {
    if (readySent) return;
    readySent = true;
    clearReadyFallback();
    queue.push({
      type: 'ready',
      sessionId,
      audio: { input: audio.input, output: audio.output },
      transcription: spec.transcription
    });
    while (preReadyEvents.length > 0) queue.push(preReadyEvents.shift()!);
  };

  const emitClosedOnce = (reason: Extract<RealtimeEvent, { type: 'closed' }>['reason']) => {
    if (closed) return;
    closed = true;
    clearReadyFallback();
    queue.push({ type: 'closed', reason });
    queue.close();
  };

  const ensureOpen = () => {
    if (closed) throw new Error('Realtime session is closed');
  };

  const waitForCancelIfNeeded = async () => {
    const pending = pendingCancel;
    if (!pending) return;
    await Promise.race([
      pending.promise,
      new Promise<void>((resolve) => setTimeout(resolve, 500))
    ]);
    if (pendingCancel === pending) {
      pendingCancel = undefined;
    }
  };

  const handleCancelAck = () => {
    if (!pendingCancel) return;
    pendingCancel.resolve();
    pendingCancel = undefined;
  };

  void (async () => {
    try {
      for await (const evt of transport.events()) {
        if (evt.type === 'open') {
          scheduleReadyFallback();
          continue;
        }

        if (evt.type === 'error') {
          emitReadyOnce();
          pendingCancel = undefined;
          queue.push({ type: 'error', message: String(evt.error), code: evt.code ?? 'transport_error' });
          continue;
        }

        if (evt.type === 'close') {
          emitReadyOnce();
          pendingCancel = undefined;
          emitClosedOnce('provider_close');
          return;
        }

        // message
        let parsed: any;
        try {
          parsed = JSON.parse(String((evt as any).data ?? ''));
        } catch {
          emitReadyOnce();
          queue.push({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });
          continue;
        }

        const msgType = String(parsed?.type ?? '');

        if (msgType === 'conversation.created' && !sessionUpdateSent) {
          sessionUpdateSent = true;
          send(sessionUpdateEvent);
          continue;
        }

        // Wait for session.updated before declaring ready so the session config is in effect.
        if (!readySent && (msgType === 'session.updated' || msgType === 'error')) {
          emitReadyOnce();
        }

        if (msgType === 'input_audio_buffer.committed') {
          hasAudioSinceCommit = false;
        }

        if (msgType === 'response.cancelled' || msgType === 'response.canceled') {
          handleCancelAck();
        }

        if (msgType === 'response.done') {
          const status = String(parsed?.response?.status ?? '').toLowerCase();
          if (status === 'cancelled' || status === 'canceled') {
            handleCancelAck();
          }
        }

        try {
          const mapped = mapGrokRealtimeServerEvent(parsed, state);
          for (const e of mapped) {
            if (readySent) queue.push(e);
            else preReadyEvents.push(e);
          }
        } catch (err: any) {
          const errorEvent: RealtimeEvent = { type: 'error', message: String(err), code: 'event_mapping_failed' };
          if (readySent) queue.push(errorEvent);
          else preReadyEvents.push(errorEvent);
        }
      }
    } catch (err: any) {
      emitReadyOnce();
      pendingCancel = undefined;
      queue.push({ type: 'error', message: String(err), code: 'transport_pump_failed' });
      emitClosedOnce('error');
    }
  })();

  return {
    async sendText({ text, role = 'user' }) {
      ensureOpen();
      pendingTextTurn = true;
      send(buildConversationItemCreateEvent({ text, role }));
    },
    async injectContext(items) {
      ensureOpen();
      for (const item of items) {
        send(buildConversationItemCreateEvent({ text: item.text, role: item.role }));
      }
    },
    async sendAudio(frame) {
      ensureOpen();
      hasAudioSinceCommit = true;
      send(buildInputAudioAppendEvent(frame));
    },
    async commit() {
      ensureOpen();

      if (commitMode === 'server_vad') {
        // Provider is expected to auto-create responses for audio turns (telephony-friendly).
        if (!pendingTextTurn) return;
      }

      if (commitMode === 'manual_commit' && hasAudioSinceCommit) {
        send(buildInputAudioCommitEvent());
        hasAudioSinceCommit = false;
      }

      pendingTextTurn = false;
      await waitForCancelIfNeeded();
      send(buildResponseCreateEvent(forceToolChoiceOnCommit ? { toolChoice: 'required' } : {}));
    },
    async interrupt() {
      ensureOpen();
      if (!pendingCancel) {
        pendingCancel = createDeferred();
      }
      send(buildResponseCancelEvent());
    },
    async sendToolResult({ toolCallId, result }) {
      ensureOpen();
      send(buildToolResultItemCreateEvent({ toolCallId, result: result as JsonValue }));
      await waitForCancelIfNeeded();
      send(buildResponseCreateEvent());
    },
    events() {
      return queue.iterate();
    },
    async close() {
      if (closed) return;
      closed = true;
      pendingCancel = undefined;
      clearReadyFallback();
      try {
        transport.close();
      } catch {}
      queue.push({ type: 'closed', reason: 'client_close' });
      queue.close();
    }
  };
}
