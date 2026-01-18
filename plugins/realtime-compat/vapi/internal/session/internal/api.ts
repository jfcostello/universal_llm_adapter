import type { RealtimeHistoryItem } from '../../../../../../kernel/index.js';

export type VapiTransportAudioFormat = {
  format: 'pcm_s16le';
  container: 'raw';
  sampleRate: number;
};

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

export function buildVapiCreateCallBody(options: {
  modelProvider: string;
  model: string;
  voiceProvider: string;
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
      provider: options.modelProvider,
      model: options.model,
      ...(messages.length > 0 ? { messages } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {})
    },
    voice: {
      provider: options.voiceProvider,
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

export async function createVapiWebsocketCall(options: {
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

export async function waitForVapiControlUrl(options: {
  callId: string;
  urlTemplate: string;
  headers?: Record<string, string>;
  maxWaitMs: number;
  pollMs: number;
}): Promise<{ controlUrl: string }> {
  const pollMs = Math.max(100, Math.floor(options.pollMs));
  const maxWaitMs = Math.max(pollMs, Math.floor(options.maxWaitMs));
  const deadline = Date.now() + maxWaitMs;

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

