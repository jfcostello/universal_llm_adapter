import { createRequire } from 'module';

import type {
  IRealtimeCompat,
  JsonValue,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec
} from '../../../../modules/kernel/index.js';
import { AsyncQueue } from '../../../../modules/kernel/index.js';
import {
  buildConversationItemCreateEvent,
  buildInputAudioAppendEvent,
  buildInputAudioCommitEvent,
  buildResponseCancelEvent,
  buildResponseCreateEvent,
  buildSessionUpdateEvent,
  buildToolResultItemCreateEvent
} from './commands.js';
import { mapOpenAIRealtimeServerEvent } from './event-mapper.js';

type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

function resolveRealtimeUrl(options: {
  urlTemplate: string;
  model: string;
  query?: Record<string, string>;
}): string {
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

function send(ws: WsLike, event: any): void {
  ws.send(JSON.stringify(event));
}

export function createOpenAIRealtimeCompatSession(options: Parameters<IRealtimeCompat['createSession']>[0]): RealtimeCompatSession {
  const provider = options.provider;
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
  const ws: WsLike = new wsLib.WebSocket(url, {
    headers: realtime.endpoint.headers
  });
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeEvent>();
  const sessionId = generateSessionId();

  const { event: sessionUpdateEvent, audio } = buildSessionUpdateEvent({
    spec,
    tools: options.tools
  });

  const state = {
    audio,
    functionNameByCallId: new Map<string, string>()
  };

  let readySent = false;
  let closed = false;
  let hasAudioSinceCommit = false;
  const commitMode = spec.turnDetection?.mode ?? 'manual_commit';

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

  const emitClosedOnce = () => {
    if (closed) return;
    closed = true;
    queue.push({ type: 'closed', reason: 'provider_close' });
    queue.close();
  };

  ws.on('open', () => {
    emitReadyOnce();
    send(ws, sessionUpdateEvent);
  });

  ws.on('message', (data: any) => {
    emitReadyOnce();
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(data as any).toString('utf-8'));
    } catch {
      queue.push({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });
      return;
    }

    // Reset audio buffer bookkeeping when server confirms a commit (VAD mode).
    if (parsed?.type === 'input_audio_buffer.committed') {
      hasAudioSinceCommit = false;
    }

    try {
      const mapped = mapOpenAIRealtimeServerEvent(parsed, state);
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
    emitClosedOnce();
  });

  const ensureOpen = () => {
    if (closed) throw new Error('Realtime session is closed');
    if (ws.readyState !== WS_OPEN) throw new Error('Realtime websocket not open');
  };

  return {
    async sendText({ text, role = 'user' }) {
      ensureOpen();
      send(ws, buildConversationItemCreateEvent({ text, role }));
    },
    async sendAudio(frame) {
      ensureOpen();
      hasAudioSinceCommit = true;
      send(ws, buildInputAudioAppendEvent(frame));
    },
    async commit() {
      ensureOpen();
      if (commitMode === 'manual_commit' && hasAudioSinceCommit) {
        send(ws, buildInputAudioCommitEvent());
        hasAudioSinceCommit = false;
      }
      send(ws, buildResponseCreateEvent());
    },
    async interrupt() {
      ensureOpen();
      send(ws, buildResponseCancelEvent());
    },
    async sendToolResult({ toolCallId, result }) {
      ensureOpen();
      send(ws, buildToolResultItemCreateEvent({ toolCallId, result: result as JsonValue }));
      send(ws, buildResponseCreateEvent());
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
