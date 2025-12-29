import { createRequire } from 'module';

import type {
  IRealtimeCompat,
  JsonValue,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec
} from '../../../../kernel/index.js';
import { AsyncQueue, LruMap, resolveRealtimeToolCallTrackingMaxEntries, sanitizeToolName } from '../../../../kernel/index.js';
import { buildGeminiActivityEndMessage, buildGeminiActivityStartMessage, buildGeminiCommitTextTurnMessage, buildGeminiInterruptMessage, buildGeminiRealtimeAudioMessage, buildGeminiRealtimeTextMessage, buildGeminiSendTextMessage, buildGeminiSetupMessage, buildGeminiToolResponseMessage } from './commands.js';
import { convertSessionAudioToProviderPcm16_16k } from './audio.js';
import { mapGeminiLiveServerMessage, type GeminiRealtimeMapperState } from './event-mapper.js';

type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

function resolveRealtimeUrl(options: { urlTemplate: string; model: string; query?: Record<string, string> }): string {
  const template = String(options.urlTemplate);
  const base = template.includes('{model}')
    ? template.replace('{model}', encodeURIComponent(options.model))
    : template;

  const url = new URL(base);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v.includes('{model}') ? v.replace('{model}', options.model) : v);
    }
  }
  return url.toString();
}

function generateSessionId(): string {
  return `sess_local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function send(ws: WsLike, msg: any): void {
  ws.send(JSON.stringify(msg));
}

function ensureJsonObject(value: JsonValue): any {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { output: value };
}

export function createGeminiRealtimeCompatSession(options: Parameters<IRealtimeCompat['createSession']>[0]): RealtimeCompatSession {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const endpoint = provider.endpoint;
  if (!endpoint?.urlTemplate) {
    throw new Error(`Provider '${provider.id}' missing realtime endpoint configuration`);
  }

  const model = spec.model ?? (provider.metadata as any)?.defaultModel;
  if (!model) {
    throw new Error(`Realtime session requires 'model' for provider '${provider.id}'`);
  }

  const url = resolveRealtimeUrl({
    urlTemplate: endpoint.urlTemplate,
    model,
    query: endpoint.query
  });

  const require = createRequire(import.meta.url);
  const wsLib = require('ws');
  const ws: WsLike = new wsLib.WebSocket(url, { headers: endpoint.headers });
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeEvent>();
  const sessionId = generateSessionId();

  const toolCallTrackingMaxEntries = resolveRealtimeToolCallTrackingMaxEntries(spec);

  const { message: setupMessage, audio, settingsWarnings } = buildGeminiSetupMessage({
    model,
    spec,
    tools: options.tools
  });

  const turnMode = spec.turnDetection?.mode ?? 'manual_commit';
  const activityDriven = turnMode === 'manual_commit';
  let activityStarted = false;
  let pendingTextTurn = false;

  const state: GeminiRealtimeMapperState = {
    audio,
    turnMode,
    userSpeechActive: false,
    unifiedToolNameByProviderName: new Map(
      (options.tools ?? []).map(t => [sanitizeToolName(t.name), t.name] as const)
    ),
    toolNameByCallId: new LruMap<string, string>(toolCallTrackingMaxEntries, {
      label: 'realtime-tool-call-tracking(gemini)',
      warnOnEvict: true
    }),
    toolCallSeq: 0,
    sawUsageThisTurn: false,
    userTranscriptRaw: '',
    userTranscript: '',
    pendingUserTranscriptFinal: false,
    assistantTranscriptRaw: '',
    assistantTranscript: '',
  };

  let closed = false;
  let readySent = false;
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
  let setupComplete = false;
  const expectedHistory = Array.isArray(spec.history) ? spec.history : undefined;
  let startupHistoryCallAccepted = false;
  const pendingSends: any[] = [];

  const emitReadyOnce = () => {
    if (readySent) return;
    readySent = true;
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
    queue.push({ type: 'closed', reason });
    queue.close();
  };

  const ensureOpen = () => {
    if (closed) throw new Error('Realtime session is closed');
    if (ws.readyState !== WS_OPEN) throw new Error('Realtime websocket not open');
  };

  const sendOrBuffer = (msg: any) => {
    if (!setupComplete) {
      pendingSends.push(msg);
      return;
    }
    send(ws, msg);
  };

  ws.on('open', () => {
    emitReadyOnce();
    send(ws, setupMessage);
  });

  ws.on('message', (data: any) => {
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(data as any).toString('utf-8'));
    } catch {
      emitReadyOnce();
      queue.push({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });
      return;
    }

    if (parsed?.setupComplete && !setupComplete) {
      setupComplete = true;
      emitReadyOnce();
      for (const msg of pendingSends.splice(0)) send(ws, msg);
      return;
    }

    try {
      const mapped = mapGeminiLiveServerMessage(parsed, state);
      for (const evt of mapped) queue.push(evt);
    } catch (err: any) {
      queue.push({ type: 'error', message: String(err), code: 'event_mapping_failed' });
    }
  });

  ws.on('error', (err: any) => {
    emitReadyOnce();
    queue.push({ type: 'error', message: String(err), code: 'ws_error' });
  });

  ws.on('close', () => {
    emitReadyOnce();
    emitClosedOnce('provider_close');
  });

  return {
    async sendText({ text, role = 'user' }) {
      ensureOpen();
      if (activityDriven && activityStarted) {
        // Avoid mixing ordered `clientContent` messages with `realtimeInput` activity signals
        // during barge-in; send text via realtimeInput so the server treats it as part of the
        // active activity turn.
        sendOrBuffer(buildGeminiRealtimeTextMessage({ text }));
        return;
      }
      pendingTextTurn = true;
      sendOrBuffer(buildGeminiSendTextMessage({ text, role }));
    },
    async injectContext(items) {
      ensureOpen();
      if (!startupHistoryCallAccepted && expectedHistory && items.length === expectedHistory.length) {
        const matches = items.every((item, i) => item.role === expectedHistory[i]?.role && item.text === expectedHistory[i]?.text);
        if (matches) {
          startupHistoryCallAccepted = true;
          return;
        }
      }
      throw new Error('injectContext is not supported for this realtime compat session');
    },
    async sendAudio(frame) {
      ensureOpen();
      const converted = convertSessionAudioToProviderPcm16_16k(frame);
      if (activityDriven && !activityStarted) {
        // The Live API rejects messages that combine activityStart + audio in a single realtimeInput payload.
        // Send activityStart separately on the first audio frame after a commit boundary.
        sendOrBuffer(buildGeminiActivityStartMessage());
        activityStarted = true;
        // Emit local speech-start immediately for barge-in.
        queue.push({ type: 'user_speech.started' });
      } else if (!activityDriven && !state.userSpeechActive) {
        state.userSpeechActive = true;
        queue.push({ type: 'user_speech.started' });
      }
      sendOrBuffer(
        buildGeminiRealtimeAudioMessage({
          audioBase64: converted.audioBase64,
          mimeType: converted.mimeType
        })
      );
    },
    async commit() {
      ensureOpen();
      if (activityDriven && activityStarted) {
        sendOrBuffer(buildGeminiActivityEndMessage());
        activityStarted = false;
        queue.push({ type: 'user_speech.stopped' });
        // Input transcription can arrive after the commit boundary, so defer emitting
        // `user_transcript.final` until turn completion (serverContent.turnComplete).
        state.pendingUserTranscriptFinal = true;
      }

      if (pendingTextTurn) {
        sendOrBuffer(buildGeminiCommitTextTurnMessage());
        pendingTextTurn = false;
      }
    },
    async interrupt() {
      ensureOpen();
      if (activityDriven) {
        // Gemini Live interruption is tied to activity start ("barge in").
        // Signal activity start to cut off the current response. The activity is
        // ended by the next commit (audio or text) so we don't accidentally
        // trigger a new model turn without user input.
        if (!activityStarted) {
          sendOrBuffer(buildGeminiActivityStartMessage());
          activityStarted = true;
          queue.push({ type: 'user_speech.started' });
        }
        return;
      }
      sendOrBuffer(buildGeminiInterruptMessage());
    },
    async sendToolResult({ toolCallId, result }) {
      ensureOpen();
      const name = state.toolNameByCallId.get(toolCallId) ?? toolCallId;
      const response = ensureJsonObject(result as JsonValue);
      sendOrBuffer(buildGeminiToolResponseMessage({ toolCallId, name, response }));
    },
    events() {
      return queue.iterate();
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (ws.readyState === WS_OPEN) {
          ws.close(1000, 'client_close');
        } else {
          ws.terminate();
        }
      } catch {}
      queue.push({ type: 'closed', reason: 'client_close' });
      queue.close();
    }
  };
}
