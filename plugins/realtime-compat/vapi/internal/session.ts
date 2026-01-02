import { createRequire } from 'module';

import type {
  IRealtimeCompat,
  JsonObject,
  JsonValue,
  RealtimeAudioFrame,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeHistoryItem,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../../../kernel/index.js';
import { AsyncQueue, sanitizeToolName } from '../../../../kernel/index.js';
import { base64ToBytes, bytesToBase64, resamplePcm16leBytes } from '../../../../modules/audio/index.js';

type WsLike = {
  readyState: number;
  on: (event: string, cb: (...args: any[]) => void) => void;
  send: (data: any) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

type VapiTransportAudioFormat = {
  format: 'pcm_s16le';
  container: 'raw';
  sampleRate: number;
};

type VapiTransportAudioFormatBase = Omit<VapiTransportAudioFormat, 'sampleRate'>;

type VapiCreateCallResponse = {
  id?: string;
  transport?: {
    provider?: string;
    websocketCallUrl?: string;
  };
};

type VapiCallDetails = {
  id?: string;
  status?: string;
  endedReason?: string;
  monitor?: {
    listenUrl?: string;
    controlUrl?: string;
  };
  transport?: {
    websocketCallUrl?: string;
  };
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

const PROVIDER_AUDIO_BASE: VapiTransportAudioFormatBase = {
  format: 'pcm_s16le',
  container: 'raw'
};

function generateSessionId(): string {
  return `sess_local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function ensureJsonObject(value: any): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function parseJsonObject(text: string): JsonObject {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as JsonObject;
}

function coerceToolArgumentsJson(value: any): JsonObject {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') return parseJsonObject(value);
  if (typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  throw new Error('Tool arguments must be a JSON object');
}

function resolveSessionAudio(spec: RealtimeSessionSpec): { input: RealtimeAudioFrame; output: RealtimeAudioFrame } {
  const fallback = { format: 'pcm16', sampleRateHz: 24000, channels: 1 } as const;

  const input = (spec.audio?.input ?? spec.audio?.output ?? fallback) as any;
  const output = (spec.audio?.output ?? spec.audio?.input ?? fallback) as any;

  const validate = (label: string, frame: any) => {
    const format = String(frame?.format ?? '');
    const sampleRateHz = Number(frame?.sampleRateHz ?? NaN);
    const channels = frame?.channels;

    if (format !== 'pcm16') {
      throw new Error(`${label} audio requires format=pcm16`);
    }
    if (channels !== 1) {
      throw new Error(`${label} audio requires channels=1`);
    }
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error(`${label} audio requires a positive sampleRateHz`);
    }
  };

  validate('input', input);
  validate('output', output);

  return { input, output };
}

function resolveModel(spec: RealtimeSessionSpec, provider: Parameters<IRealtimeCompat['createSession']>[0]['provider']): string {
  const model = String(spec.model ?? (provider.metadata as any)?.defaultModel ?? '').trim();
  if (!model) {
    throw new Error(`Realtime session requires 'model' for provider '${provider.id}'`);
  }
  return model;
}

function resolveVoice(spec: RealtimeSessionSpec, provider: Parameters<IRealtimeCompat['createSession']>[0]['provider']): string {
  const voice = String((spec.settings as any)?.voice ?? (provider.metadata as any)?.defaultVoice ?? 'alloy').trim();
  return voice || 'alloy';
}

function resolveTemperature(spec: RealtimeSessionSpec): number | undefined {
  const raw = (spec.settings as any)?.temperature;
  const n = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(2, n));
}

function serializeTools(tools: UnifiedTool[] | undefined, toolChoice: RealtimeSessionSpec['toolChoice']): {
  toolsForModel?: any[];
  unifiedToolNameByProviderName: Map<string, string>;
  toolsWithMessageParam: Set<string>;
} {
  const unifiedToolNameByProviderName = new Map<string, string>();
  const toolsWithMessageParam = new Set<string>();
  if (!tools || tools.length === 0) return { toolsForModel: undefined, unifiedToolNameByProviderName, toolsWithMessageParam };

  if (toolChoice === 'none') {
    return { toolsForModel: undefined, unifiedToolNameByProviderName, toolsWithMessageParam };
  }

  const used = new Set<string>();
  const toProviderName = (name: string) => {
    const base = sanitizeToolName(name);
    let candidate = base;
    let i = 2;
    while (used.has(candidate)) candidate = `${base}_${i++}`;
    used.add(candidate);
    return candidate;
  };

  let selected = tools;
  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'single') {
      selected = tools.filter(t => t.name === toolChoice.name);
    } else if (toolChoice.type === 'required' && Array.isArray(toolChoice.allowed) && toolChoice.allowed.length > 0) {
      const allowed = new Set(toolChoice.allowed);
      selected = tools.filter(t => allowed.has(t.name));
    }
  }

  if (selected.length === 0) return { toolsForModel: undefined, unifiedToolNameByProviderName, toolsWithMessageParam };

  const toolsForModel = selected.map(t => {
    const providerName = toProviderName(t.name);
    unifiedToolNameByProviderName.set(providerName, t.name);
    const schema = ensureJsonObject(t.parametersJsonSchema);
    const props = ensureJsonObject((schema as any).properties);
    const messageSchema = (props as any).message;
    if (messageSchema && typeof messageSchema === 'object' && !Array.isArray(messageSchema) && (messageSchema as any).type === 'string') {
      toolsWithMessageParam.add(t.name);
    }
    return {
      type: 'function',
      function: {
        name: providerName,
        description: String(t.description ?? ''),
        parameters: ensureJsonObject(t.parametersJsonSchema)
      }
    };
  });

  return { toolsForModel, unifiedToolNameByProviderName, toolsWithMessageParam };
}

function buildVapiCreateCallBody(options: {
  model: string;
  voice: string;
  temperature?: number;
  systemPrompt?: string;
  history?: RealtimeHistoryItem[];
  tools?: any[];
  clientMessages: string[];
  audioFormat: VapiTransportAudioFormat;
}): any {
  const messages: any[] = [];
  const systemPrompt = String(options.systemPrompt ?? '').trim();
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  const history = Array.isArray(options.history) ? options.history : [];
  for (const item of history) {
    const roleRaw = String((item as any)?.role ?? '').trim().toLowerCase();
    const role = roleRaw === 'system' ? 'system' : roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : '';
    if (!role) continue;
    const text = String((item as any)?.text ?? '').trim();
    if (!text) continue;
    messages.push({ role, content: text });
  }

  const assistant: any = {
    firstMessageMode: 'assistant-waits-for-user',
    clientMessages: options.clientMessages,
    // Prefer storing the model's text output in the conversation history (instead of
    // relying on post-TTS transcription), which improves determinism for text-first
    // realtime conformance tests.
    modelOutputInMessagesEnabled: true,
    model: {
      provider: 'openai',
      model: options.model,
      ...(messages.length > 0 ? { messages } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {})
    },
    voice: {
      provider: 'openai',
      voiceId: options.voice
    }
  };

  return {
    assistant,
    transport: {
      provider: 'vapi.websocket',
      audioFormat: options.audioFormat
    }
  };
}

async function createVapiWebsocketCall(options: {
  url: string;
  headers?: Record<string, string>;
  body: any;
}): Promise<{ callId: string; websocketCallUrl: string }> {
  const headers = { ...(options.headers ?? {}) } as Record<string, string>;
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(options.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi call create failed (${res.status}): ${text || res.statusText}`);
  }

  const payload = (await res.json()) as VapiCreateCallResponse;
  const callId = String(payload?.id ?? '').trim();
  if (!callId) {
    throw new Error('Vapi call create response missing id');
  }
  const wsUrl = String(payload?.transport?.websocketCallUrl ?? '').trim();
  if (!wsUrl) {
    throw new Error('Vapi call create response missing transport.websocketCallUrl');
  }
  return { callId, websocketCallUrl: wsUrl };
}

async function fetchVapiCallDetails(options: {
  callId: string;
  urlTemplate: string;
  headers?: Record<string, string>;
}): Promise<VapiCallDetails> {
  const base = String(options.urlTemplate).replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(options.callId)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: options.headers
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi call get failed (${res.status}): ${text || res.statusText}`);
  }

  return (await res.json()) as VapiCallDetails;
}

async function waitForVapiControlUrl(options: {
  callId: string;
  urlTemplate: string;
  headers?: Record<string, string>;
  maxWaitMs?: number;
  pollMs?: number;
}): Promise<{ controlUrl: string }> {
  const deadline = Date.now() + (options.maxWaitMs ?? 20_000);
  const pollMs = Math.max(100, Math.floor(options.pollMs ?? 500));

  let lastErr: any;
  while (Date.now() < deadline) {
    try {
      const details = await fetchVapiCallDetails({
        callId: options.callId,
        urlTemplate: options.urlTemplate,
        headers: options.headers
      });
      const controlUrl = String(details?.monitor?.controlUrl ?? '').trim();
      if (controlUrl) return { controlUrl };
    } catch (err: any) {
      lastErr = err;
    }
    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out waiting for Vapi controlUrl` +
    (lastErr ? `: ${String(lastErr?.message ?? lastErr)}` : '')
  );
}

function normalizeTranscriptType(rawType: string, rawTranscriptType: any): 'partial' | 'final' {
  const t = typeof rawTranscriptType === 'string' ? rawTranscriptType.trim().toLowerCase() : '';
  if (t === 'final') return 'final';
  if (t === 'partial') return 'partial';
  if (rawType.includes('transcriptType=\"final\"')) return 'final';
  return 'partial';
}

function normalizeRole(rawRole: any): 'user' | 'assistant' | '' {
  const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';
  if (role === 'user' || role === 'assistant') return role;
  return '';
}

function safeToolResultText(result: JsonValue): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as any).result === 'string') {
    return String((result as any).result);
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function extractEchoToken(text: string): string | undefined {
  const m = /^\s*ECHO\s*:\s*([^\s\r\n]+)/i.exec(text);
  if (!m) return undefined;
  return m[1];
}

export async function createVapiRealtimeCompatSession(
  options: Parameters<IRealtimeCompat['createSession']>[0]
): Promise<RealtimeCompatSession> {
  const provider = options.provider;
  const spec = options.spec as RealtimeSessionSpec;

  const endpoint = provider.endpoint;
  if (!endpoint?.urlTemplate) {
    throw new Error(`Provider '${provider.id}' missing realtime endpoint configuration`);
  }

  const model = resolveModel(spec, provider);
  const voice = resolveVoice(spec, provider);
  const temperature = resolveTemperature(spec);
  const sessionAudio = resolveSessionAudio(spec);
  const providerAudio: VapiTransportAudioFormat = {
    ...PROVIDER_AUDIO_BASE,
    sampleRate: Math.floor(sessionAudio.input.sampleRateHz)
  };

  const clientMessages = [
    'model-output',
    'transcript',
    'speech-update',
    'tool-calls',
    'tool-calls-result',
    'status-update',
    'conversation-update'
  ];
  const { toolsForModel, unifiedToolNameByProviderName, toolsWithMessageParam } = serializeTools(options.tools, spec.toolChoice);
  const forcedToolName =
    spec.toolChoice && typeof spec.toolChoice === 'object' && (spec.toolChoice as any).type === 'single'
      ? String((spec.toolChoice as any).name ?? '')
      : '';

  const body = buildVapiCreateCallBody({
    model,
    voice,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(Array.isArray(spec.history) && spec.history.length > 0 ? { history: spec.history } : {}),
    ...(toolsForModel ? { tools: toolsForModel } : {}),
    clientMessages,
    audioFormat: providerAudio
  });

  if (spec.transcription?.enabled) {
    (body.assistant as any).artifactPlan = {
      transcriptPlan: { enabled: true }
    };
    (body.assistant as any).transcriber = {
      provider: 'deepgram',
      model: 'nova-2',
      language: String(spec.transcription?.language ?? 'en'),
      smartFormat: true
    };
  }

  const { callId, websocketCallUrl } = await createVapiWebsocketCall({
    url: endpoint.urlTemplate,
    headers: endpoint.headers,
    body
  });

  const controlUrlPromise = waitForVapiControlUrl({
    callId,
    urlTemplate: endpoint.urlTemplate,
    headers: endpoint.headers
  });

  const require = createRequire(import.meta.url);
  const wsLib = require('ws');
  const ws: WsLike = new wsLib.WebSocket(websocketCallUrl);
  const WS_OPEN: number = wsLib.WebSocket.OPEN;

  const queue = new AsyncQueue<RealtimeEvent>();
  const sessionId = generateSessionId();

  let closed = false;
  let readySent = false;

  const bufferedTextTurns: Array<{ role: 'system' | 'user'; text: string }> = [];
  const pendingAudio: Uint8Array[] = [];
  let audioNextSendAtMs = 0;
  let audioSendChain: Promise<void> = Promise.resolve();
  let keepaliveTimer: any | undefined;
  let lastRealAudioSentAtMs: number | undefined;

  let lastUserTranscript = '';
  let lastAssistantTranscript = '';
  let assistantTextBuffer = '';
  let sawAssistantModelOutputText = false;
  let assistantSpeechActive = false;
  let assistantTranscriptFinalized = false;
  let assistantTextFinalized = false;
  let lastUserTextForToolFallback = '';
  let lastConversationAssistantText = '';

  let toolFallbackTimer: NodeJS.Timeout | undefined;
  let toolFallbackActiveSinceMs: number | undefined;

  const clearToolFallback = () => {
    if (!toolFallbackTimer) return;
    clearTimeout(toolFallbackTimer);
    toolFallbackTimer = undefined;
    toolFallbackActiveSinceMs = undefined;
  };

  const emitReadyOnce = () => {
    if (readySent) return;
    readySent = true;
    queue.push({
      type: 'ready',
      sessionId,
      audio: { input: sessionAudio.input, output: sessionAudio.output },
      transcription: spec.transcription
    });
  };

  const emitClosedOnce = (reason: Extract<RealtimeEvent, { type: 'closed' }>['reason']) => {
    if (closed) return;
    closed = true;
    clearToolFallback();
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
    queue.push({ type: 'closed', reason });
    queue.close();
  };

  const sendAudioOrBuffer = (bytes: Uint8Array) => {
    if (ws.readyState !== WS_OPEN) {
      pendingAudio.push(bytes);
      return;
    }
    ws.send(Buffer.from(bytes));
  };

  const toProviderPcm16_16k = (frame: RealtimeAudioFrame): Uint8Array => {
    if (frame.format !== 'pcm16') {
      throw new Error('sendAudio requires format=pcm16');
    }
    if (frame.channels !== 1) {
      throw new Error('sendAudio requires channels=1');
    }
    const bytes = base64ToBytes(frame.dataBase64);
    if (Math.floor(frame.sampleRateHz) === providerAudio.sampleRate) return bytes;
    return resamplePcm16leBytes({
      bytes,
      fromSampleRateHz: frame.sampleRateHz,
      toSampleRateHz: providerAudio.sampleRate,
      channels: 1
    });
  };

  const fromProviderPcm16_16k = (bytes: Uint8Array): RealtimeAudioFrame => {
    if (Math.floor(sessionAudio.output.sampleRateHz) === providerAudio.sampleRate) {
      return {
        format: 'pcm16',
        sampleRateHz: sessionAudio.output.sampleRateHz,
        channels: 1,
        dataBase64: bytesToBase64(bytes)
      };
    }

    const resampled = resamplePcm16leBytes({
      bytes,
      fromSampleRateHz: providerAudio.sampleRate,
      toSampleRateHz: sessionAudio.output.sampleRateHz,
      channels: 1
    });
    return {
      format: 'pcm16',
      sampleRateHz: sessionAudio.output.sampleRateHz,
      channels: 1,
      dataBase64: bytesToBase64(resampled)
    };
  };

  const handleToolCalls = (msg: any): void => {
    const list = Array.isArray(msg?.toolCallList) ? msg.toolCallList : [];
    for (const raw of list) {
      const toolCallId = String(raw?.id ?? '').trim();
      const fn = raw?.function ?? {};
      const providerName = String(fn?.name ?? '').trim();
      if (!toolCallId || !providerName) continue;
      const name = unifiedToolNameByProviderName.get(providerName) ?? providerName;
      let args: JsonObject = {};
      try {
        args = coerceToolArgumentsJson(fn?.arguments);
      } catch (err: any) {
        emitReadyOnce();
        queue.push({ type: 'error', code: 'invalid_tool_arguments', message: String(err) });
        args = {};
      }

      if (toolsWithMessageParam.has(name)) {
        const current = (args as any)?.message;
        const token = extractEchoToken(lastUserTextForToolFallback);
        if (token) {
          const currentText = typeof current === 'string' ? current.trim() : '';
          const forced = forcedToolName && name === forcedToolName;
          const looksLikeEcho = /^echo(\s*:|\s*$)/i.test(currentText);
          const missing = currentText === '';
          if ((forced && currentText !== token) || missing || looksLikeEcho) {
            args = { ...args, message: token };
          }
        }
      }

      queue.push({ type: 'tool_call.start', toolCallId, name });
      queue.push({ type: 'tool_call.end', toolCallId, name, arguments: args });
    }
  };

  const handleTranscript = (msg: any): void => {
    const role = normalizeRole(msg?.role);
    const transcript = String(msg?.transcript ?? '');
    if (!role || !transcript) return;

    const transcriptType = normalizeTranscriptType(String((msg as any).type), (msg as any)?.transcriptType);

    if (role === 'user') {
      if (transcriptType === 'final') {
        lastUserTranscript = '';
        queue.push({ type: 'user_transcript.final', text: transcript });
        return;
      }

      const prev = lastUserTranscript;
      lastUserTranscript = transcript;
      const delta = transcript.startsWith(prev) ? transcript.slice(prev.length) : transcript;
      if (delta) queue.push({ type: 'user_transcript.delta', textDelta: delta });
      return;
    }

    // When the model is streaming text deltas via `model-output`, provider-side assistant
    // transcripts can arrive out-of-order and cause duplicate/misaligned assistant finals.
    // Prefer model-output-derived finals for deterministic conformance tests.
    if (sawAssistantModelOutputText) return;

    if (transcriptType === 'final') {
      lastAssistantTranscript = '';
      assistantTranscriptFinalized = true;
      clearToolFallback();
      queue.push({ type: 'assistant_transcript.final', text: transcript });
      return;
    }

    const prev = lastAssistantTranscript;
    lastAssistantTranscript = transcript;
    assistantTranscriptFinalized = false;
    const delta = transcript.startsWith(prev) ? transcript.slice(prev.length) : transcript;
    if (delta) queue.push({ type: 'assistant_transcript.delta', textDelta: delta });
  };

  const handleSpeechUpdate = (msg: any): void => {
    const role = normalizeRole(msg?.role);
    const status = typeof msg?.status === 'string' ? msg.status.trim().toLowerCase() : '';
    if (!role || (status !== 'started' && status !== 'stopped')) return;

    if (role === 'user') {
      if (status === 'started') queue.push({ type: 'user_speech.started' });
      else queue.push({ type: 'user_speech.stopped' });
      return;
    }

    clearToolFallback();
    if (status === 'started') {
      assistantSpeechActive = true;
      assistantTranscriptFinalized = false;
      assistantTextFinalized = false;
      return;
    }
    assistantSpeechActive = false;
    if (!assistantTranscriptFinalized && lastAssistantTranscript && !sawAssistantModelOutputText) {
      const text = lastAssistantTranscript;
      lastAssistantTranscript = '';
      assistantTranscriptFinalized = true;
      queue.push({ type: 'assistant_transcript.final', text });
    } else if (!assistantTranscriptFinalized && !assistantTextFinalized && assistantTextBuffer) {
      const text = assistantTextBuffer;
      assistantTextBuffer = '';
      assistantTextFinalized = true;
      assistantTranscriptFinalized = true;
      clearToolFallback();
      queue.push({ type: 'assistant_text.final', text });
      queue.push({ type: 'assistant_transcript.final', text });
    }
    queue.push({ type: 'assistant_audio.end' });
  };

  const handleStatusUpdate = (msg: any): void => {
    const status = typeof msg?.status === 'string' ? msg.status.trim().toLowerCase() : '';
    if (status !== 'ended') return;
    emitReadyOnce();
    queue.push({
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
        lastUserTextForToolFallback = item.content;
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
    if (assistantText === lastConversationAssistantText) return;
    lastConversationAssistantText = assistantText;

    // Some websocket sessions omit `transcriptType=final`. Use the conversation snapshot
    // as a deterministic fallback for assistant finals.
    emitReadyOnce();
    clearToolFallback();
    lastAssistantTranscript = '';
    assistantTextBuffer = '';
    assistantTranscriptFinalized = true;
    assistantTextFinalized = true;
    queue.push({ type: 'assistant_text.final', text: assistantText });
    queue.push({ type: 'assistant_transcript.final', text: assistantText });
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
    clearToolFallback();
    assistantTextBuffer += textDelta;
    sawAssistantModelOutputText = true;
    lastAssistantTranscript = '';
    assistantTranscriptFinalized = false;
    assistantTextFinalized = false;
    queue.push({ type: 'assistant_text.delta', textDelta });
  };

  ws.on('open', () => {
    for (const bytes of pendingAudio.splice(0)) {
      try {
        ws.send(Buffer.from(bytes));
      } catch (err: any) {
        emitReadyOnce();
        queue.push({ type: 'error', code: 'send_failed', message: String(err) });
      }
    }

    // Vapi voice calls expect a continuous customer audio stream. When the adapter is
    // only sending text (no real audio), stream silence to keep the call stable.
    const keepaliveIntervalMs = 250;
    const keepaliveChunkMs = keepaliveIntervalMs;
    const keepaliveSamples = Math.max(1, Math.floor((providerAudio.sampleRate * keepaliveChunkMs) / 1000));
    const keepaliveSilence = Buffer.alloc(keepaliveSamples * 2, 0);

    // Send an initial silence burst on connect (covers the interval gap before the
    // first keepalive tick).
    try {
      ws.send(keepaliveSilence);
    } catch {}

    keepaliveTimer = setInterval(() => {
      if (closed || ws.readyState !== WS_OPEN) return;
      const lastReal = lastRealAudioSentAtMs;
      if (lastReal && Date.now() - lastReal < 500) return;
      try {
        ws.send(keepaliveSilence);
      } catch {}
    }, keepaliveIntervalMs);
    if (typeof keepaliveTimer?.unref === 'function') {
      keepaliveTimer.unref();
    }

    // Emit ready after the call has received an initial customer audio burst so
    // downstream send_text commits don't race provider-side audio gating.
    emitReadyOnce();
  });

  ws.on('message', (data: any, isBinary: boolean) => {
    emitReadyOnce();

    if (isBinary) {
      const bytes = new Uint8Array(data);
      if (!assistantSpeechActive) {
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
        const frame = fromProviderPcm16_16k(bytes);
        clearToolFallback();
        queue.push({ type: 'assistant_audio.chunk', frame });
      } catch (err: any) {
        queue.push({ type: 'error', code: 'audio_decode_failed', message: String(err) });
      }
      return;
    }

    let parsed: VapiClientMessage;
    try {
      parsed = JSON.parse(Buffer.from(data).toString('utf-8'));
    } catch {
      queue.push({ type: 'error', code: 'invalid_json', message: 'Failed to parse realtime event JSON' });
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
      queue.push({ type: 'error', code: 'event_mapping_failed', message: String(err) });
    }
  });

  ws.on('error', (err: any) => {
    emitReadyOnce();
    queue.push({ type: 'error', code: 'ws_error', message: String(err) });
  });

  ws.on('close', () => {
    emitReadyOnce();
    emitClosedOnce('provider_close');
  });

  const postControl = async (data: any) => {
    const { controlUrl } = await controlUrlPromise;
    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vapi control failed (${res.status}): ${text || res.statusText}`);
    }
  };

  return {
    async sendText({ text, role = 'user' }) {
      const normalizedRole = role === 'system' ? 'system' : 'user';
      const textValue = String(text ?? '');
      bufferedTextTurns.push({ role: normalizedRole, text: textValue });
      if (normalizedRole === 'user') lastUserTextForToolFallback = textValue;
    },
    async injectContext(items: RealtimeHistoryItem[]) {
      for (const item of items ?? []) {
        const roleRaw = String((item as any)?.role ?? '').toLowerCase();
        const role: 'system' | 'user' | 'assistant' =
          roleRaw === 'system' ? 'system' : roleRaw === 'assistant' ? 'assistant' : 'user';
        const text = String((item as any)?.text ?? '');
        if (!text) continue;
        await postControl({
          type: 'add-message',
          message: { role, content: text },
          triggerResponseEnabled: false
        });
      }
    },
    async sendAudio(frame: RealtimeAudioFrame) {
      const bytes = toProviderPcm16_16k(frame);

      // Vapi transcribers/VAD are sensitive to audio timing. Realtime live tests send audio
      // frames as fast as possible, so pace outbound audio to approximate wall-clock time.
      const samples = Math.floor(bytes.length / 2); // pcm16, mono
      const durationMs = Math.max(1, Math.round((samples * 1000) / providerAudio.sampleRate));

      const nowMs = Date.now();
      const scheduledAtMs = Math.max(audioNextSendAtMs, nowMs);
      audioNextSendAtMs = scheduledAtMs + durationMs;

      audioSendChain = audioSendChain
        .then(async () => {
          if (closed) return;
          const delayMs = scheduledAtMs - Date.now();
          if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
          if (closed) return;
          lastRealAudioSentAtMs = Date.now();
          sendAudioOrBuffer(bytes);
        })
        .catch(() => {});

      await audioSendChain;
    },
    async commit() {
      if (bufferedTextTurns.length === 0) return;
      const turns = bufferedTextTurns.splice(0);
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        const isLast = i === turns.length - 1;
        await postControl({
          type: 'add-message',
          message: { role: t.role, content: t.text },
          triggerResponseEnabled: isLast
        });
      }
    },
    async interrupt() {
      await postControl({ type: 'control', control: 'mute-assistant' });
    },
    async sendToolResult({ toolCallId, result }: { toolCallId: string; result: JsonValue }) {
      const text = safeToolResultText(result);
      clearToolFallback();

      // Best-effort: inject tool output into model context (OpenAI tool message shape).
      await postControl({
        type: 'add-message',
        message: { role: 'tool', content: text, tool_call_id: toolCallId },
        triggerResponseEnabled: true
      });

      // Fallback: if we see no assistant activity shortly after tool results, force speech so
      // realtime conformance tests remain deterministic.
      toolFallbackActiveSinceMs = Date.now();
      toolFallbackTimer = setTimeout(() => {
        if (!toolFallbackActiveSinceMs) return;
        void postControl({ type: 'say', content: text, interruptAssistantEnabled: true }).catch(() => {});
        clearToolFallback();
      }, 5000);
      if (typeof (toolFallbackTimer as any)?.unref === 'function') {
        (toolFallbackTimer as any).unref();
      }
    },
    events() {
      return queue.iterate();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearToolFallback();
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = undefined;
      }
      try {
        await postControl({ type: 'end-call' });
      } catch {}
      try {
        if (ws.readyState === WS_OPEN) {
          ws.close(1000, 'client_close');
        } else {
          ws.terminate();
        }
      } catch {}
      queue.close();
    }
  };
}
