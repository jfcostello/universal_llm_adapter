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

  const { event: sessionUpdateEvent, audio, toolNameByProviderName } = buildSessionUpdateEvent({
    spec,
    tools: options.tools
  });

  const state = {
    audio,
    functionNameByCallId: new Map<string, string>(),
    toolNameByProviderName
  };

  let readySent = false;
  let closed = false;
  let hasAudioSinceCommit = false;
  const commitMode = spec.turnDetection?.mode ?? 'manual_commit';
  const forceToolChoiceOnCommit = typeof spec.toolChoice === 'object' && spec.toolChoice?.type === 'single';
  const preReadyEvents: RealtimeEvent[] = [];

  let pendingCancel: { promise: Promise<void>; resolve: () => void } | undefined;

  const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  const emitReadyOnce = () => {
    if (readySent) return;
    readySent = true;
    queue.push({
      type: 'ready',
      sessionId,
      audio: { input: audio.input, output: audio.output },
      transcription: spec.transcription
    });
    while (preReadyEvents.length > 0) {
      queue.push(preReadyEvents.shift()!);
    }
  };

  const emitClosedOnce = () => {
    if (closed) return;
    closed = true;
    queue.push({ type: 'closed', reason: 'provider_close' });
    queue.close();
  };

  ws.on('open', () => {
    send(ws, sessionUpdateEvent);
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

    // Wait for session.updated before declaring ready so the session config is in effect.
    if (!readySent && (parsed?.type === 'session.updated' || parsed?.type === 'error')) {
      emitReadyOnce();
    }

    // Reset audio buffer bookkeeping when server confirms a commit (VAD mode).
    if (parsed?.type === 'input_audio_buffer.committed') {
      hasAudioSinceCommit = false;
    }

    if (parsed?.type === 'response.done') {
      const status = String(parsed?.response?.status ?? '').toLowerCase();
      if (pendingCancel && (status === 'cancelled' || status === 'canceled')) {
        pendingCancel.resolve();
        pendingCancel = undefined;
      }
    }

    try {
      const mapped = mapOpenAIRealtimeServerEvent(parsed, state);
      for (const evt of mapped) {
        if (readySent) queue.push(evt);
        else preReadyEvents.push(evt);
      }
    } catch (err: any) {
      const errorEvent: RealtimeEvent = { type: 'error', message: String(err), code: 'event_mapping_failed' };
      if (readySent) queue.push(errorEvent);
      else preReadyEvents.push(errorEvent);
    }
  });

  ws.on('error', (err: any) => {
    emitReadyOnce();
    pendingCancel = undefined;
    queue.push({ type: 'error', message: String(err), code: 'ws_error' });
  });

  ws.on('close', () => {
    emitReadyOnce();
    pendingCancel = undefined;
    emitClosedOnce();
  });

  const ensureOpen = () => {
    if (closed) throw new Error('Realtime session is closed');
    if (ws.readyState !== WS_OPEN) throw new Error('Realtime websocket not open');
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
      await waitForCancelIfNeeded();
      send(ws, buildResponseCreateEvent(forceToolChoiceOnCommit ? { toolChoice: 'required' } : {}));
    },
    async interrupt() {
      ensureOpen();
      if (!pendingCancel) {
        pendingCancel = createDeferred();
      }
      send(ws, buildResponseCancelEvent());
    },
    async sendToolResult({ toolCallId, result }) {
      ensureOpen();
      send(ws, buildToolResultItemCreateEvent({ toolCallId, result: result as JsonValue }));
      await waitForCancelIfNeeded();
      send(ws, buildResponseCreateEvent());
    },
    events() {
      return queue.iterate();
    },
    async close() {
      if (closed) return;
      closed = true;
      pendingCancel = undefined;
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
