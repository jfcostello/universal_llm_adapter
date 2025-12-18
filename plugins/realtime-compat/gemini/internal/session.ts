import { createRequire } from 'module';

import type {
  IRealtimeCompat,
  JsonValue,
  ProviderManifest,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec
} from '../../../../modules/kernel/index.js';
import { AsyncQueue } from '../../../../modules/kernel/index.js';
import { buildGeminiActivityEndMessage, buildGeminiCommitTextTurnMessage, buildGeminiInterruptMessage, buildGeminiRealtimeAudioMessage, buildGeminiSendTextMessage, buildGeminiSetupMessage, buildGeminiToolResponseMessage } from './commands.js';
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
  const provider = options.provider as ProviderManifest;
  const spec = options.spec as RealtimeSessionSpec;

  const realtime = provider.realtime;
  if (!realtime?.endpoint?.urlTemplate) {
    throw new Error(`Provider '${provider.id}' missing realtime endpoint configuration`);
  }

  const model = spec.model ?? (realtime.metadata as any)?.defaultModel;
  if (!model) {
    throw new Error(`Realtime session requires 'model' for provider '${provider.id}'`);
  }

  const url = resolveRealtimeUrl({
    urlTemplate: realtime.endpoint.urlTemplate,
    model,
    query: realtime.endpoint.query
  });

  const require = createRequire(import.meta.url);
  const wsLib = require('ws');
  const ws: WsLike = new wsLib.WebSocket(url, { headers: realtime.endpoint.headers });
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeEvent>();
  const sessionId = generateSessionId();

  const { message: setupMessage, audio } = buildGeminiSetupMessage({
    model,
    spec,
    tools: options.tools
  });

  const state: GeminiRealtimeMapperState = {
    audio,
    toolNameByCallId: new Map<string, string>(),
    userTranscript: '',
    assistantTranscript: '',
    assistantText: ''
  };

  let closed = false;
  let readySent = false;
  let setupComplete = false;
  const pendingSends: any[] = [];

  const turnMode = spec.turnDetection?.mode ?? 'manual_commit';
  const activityDriven = turnMode === 'manual_commit';
  let activityStarted = false;
  let pendingTextTurn = false;

  const emitReadyOnce = () => {
    if (readySent) return;
    readySent = true;
    queue.push({
      type: 'ready',
      sessionId,
      audio: { input: audio.input, output: audio.output },
      transcription: spec.transcription
    });
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
      pendingTextTurn = true;
      sendOrBuffer(buildGeminiSendTextMessage({ text, role }));
    },
    async injectContext(_items) {
      ensureOpen();
      throw new Error('injectContext is not implemented for this realtime compat session');
    },
    async sendAudio(frame) {
      ensureOpen();
      const converted = convertSessionAudioToProviderPcm16_16k(frame);
      const msg = buildGeminiRealtimeAudioMessage({
        audioBase64: converted.audioBase64,
        mimeType: converted.mimeType,
        includeActivityStart: activityDriven && !activityStarted
      });
      if (activityDriven && !activityStarted) {
        activityStarted = true;
        // Emit local speech-start immediately for barge-in.
        queue.push({ type: 'user_speech.started' });
      }
      sendOrBuffer(msg);
    },
    async commit() {
      ensureOpen();
      if (activityDriven && activityStarted) {
        sendOrBuffer(buildGeminiActivityEndMessage());
        activityStarted = false;
        queue.push({ type: 'user_speech.stopped' });
        // Emit a best-effort "final" for the user transcript at commit boundary.
        if (state.userTranscript) {
          queue.push({ type: 'user_transcript.final', text: state.userTranscript });
          state.userTranscript = '';
        }
      }

      if (pendingTextTurn) {
        sendOrBuffer(buildGeminiCommitTextTurnMessage());
        pendingTextTurn = false;
      }
    },
    async interrupt() {
      ensureOpen();
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
