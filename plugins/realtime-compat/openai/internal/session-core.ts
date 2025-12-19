import type {
  IRealtimeCompat,
  JsonValue,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec
} from '../../../../modules/kernel/index.js';
import { AsyncQueue, LruMap, resolveRealtimeToolCallTrackingMaxEntries } from '../../../../modules/kernel/index.js';

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
import type { IRealtimeTransport } from './transport/types.js';

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

export function createOpenAIRealtimeCompatSessionWithTransport(
  options: Parameters<IRealtimeCompat['createSession']>[0],
  transport: IRealtimeTransport
): RealtimeCompatSession {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const queue = new AsyncQueue<RealtimeEvent>();
  const sessionId = generateSessionId();

  const toolCallTrackingMaxEntries = resolveRealtimeToolCallTrackingMaxEntries(spec);

  const { event: sessionUpdateEvent, audio, toolNameByProviderName } = buildSessionUpdateEvent({
    spec,
    tools: options.tools
  });

  const state = {
    audio,
    functionNameByCallId: new LruMap<string, string>(toolCallTrackingMaxEntries, {
      label: 'realtime-tool-call-tracking(openai)',
      warnOnEvict: true
    }),
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

  const send = (event: any): void => {
    transport.send(JSON.stringify(event));
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

  void (async () => {
    try {
      for await (const evt of transport.events()) {
        if (evt.type === 'open') {
          send(sessionUpdateEvent);
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
          emitClosedOnce();
          return;
        }

        // message
        let parsed: any;
        try {
          parsed = JSON.parse(String(evt.data ?? ''));
        } catch {
          emitReadyOnce();
          queue.push({ type: 'error', message: 'Failed to parse realtime event JSON', code: 'invalid_json' });
          continue;
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
      emitClosedOnce();
    }
  })();

  return {
    async sendText({ text, role = 'user' }) {
      ensureOpen();
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
      if (commitMode === 'manual_commit' && hasAudioSinceCommit) {
        send(buildInputAudioCommitEvent());
        hasAudioSinceCommit = false;
      }
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
      try {
        transport.close();
      } catch {}
      queue.push({ type: 'closed', reason: 'client_close' });
      queue.close();
    }
  };
}

export function resolveOpenAIWebrtcSdpUrl(options: {
  provider: Parameters<IRealtimeCompat['createSession']>[0]['provider'];
  spec: RealtimeSessionSpec;
}): string {
  const webrtc = options.provider.webrtc;
  if (!webrtc?.endpoint?.urlTemplate) {
    throw new Error(`Provider '${options.provider.id}' missing realtime webrtc endpoint configuration`);
  }

  const model = options.spec.model ?? (options.provider.metadata as any)?.defaultModel;
  if (!model) {
    throw new Error(`Realtime session requires 'model' for provider '${options.provider.id}'`);
  }

  return resolveRealtimeUrl({
    urlTemplate: webrtc.endpoint.urlTemplate,
    model,
    query: webrtc.endpoint.query
  });
}

export function resolveOpenAIClientSecretUrl(options: {
  provider: Parameters<IRealtimeCompat['createSession']>[0]['provider'];
  spec: RealtimeSessionSpec;
}): string {
  const webrtc = options.provider.webrtc;
  if (!webrtc?.clientSecretEndpoint?.urlTemplate) {
    throw new Error(`Provider '${options.provider.id}' missing realtime webrtc clientSecret endpoint configuration`);
  }

  const template = String(webrtc.clientSecretEndpoint.urlTemplate);
  const query = webrtc.clientSecretEndpoint.query;
  const needsModel =
    template.includes('{model}') ||
    Object.values(query ?? {}).some(v => String(v).includes('{model}'));
  const model = needsModel ? options.spec.model ?? (options.provider.metadata as any)?.defaultModel : 'unused';
  if (needsModel && !model) {
    throw new Error(`Realtime session requires 'model' for provider '${options.provider.id}'`);
  }

  return resolveRealtimeUrl({
    urlTemplate: template,
    model,
    query
  });
}

export function resolveOpenAIWsUrl(options: {
  provider: Parameters<IRealtimeCompat['createSession']>[0]['provider'];
  spec: RealtimeSessionSpec;
}): string {
  const endpoint = options.provider.endpoint;
  if (!endpoint?.urlTemplate) {
    throw new Error(`Provider '${options.provider.id}' missing realtime endpoint configuration`);
  }

  const model = options.spec.model ?? (options.provider.metadata as any)?.defaultModel;
  if (!model) {
    throw new Error(`Realtime session requires 'model' for provider '${options.provider.id}'`);
  }

  return resolveRealtimeUrl({
    urlTemplate: endpoint.urlTemplate,
    model,
    query: endpoint.query
  });
}
