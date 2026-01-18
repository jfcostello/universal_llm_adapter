import { LruMap } from '../../../../../../../kernel/index.js';

import { normalizePlainObject, stripToSingleLine } from '../shared.js';
import { extractToolCallsFromMessage, mapWithConcurrency, normalizeToolArgs, type ExtractedToolCall } from '../tools/tool-calls.js';

const ENDED_EVENT_DEDUPE = new LruMap<string, true>(20_000, { label: 'voice.vapi.ended_events' });

function shouldEmitEndedEvent(key: string): boolean {
  const id = String(key).trim();
  if (!id) return true;
  if (ENDED_EVENT_DEDUPE.get(id) === true) return false;
  ENDED_EVENT_DEDUPE.set(id, true);
  return true;
}

export async function createWebhookResponse(options: {
  callConfigId: string;
  callConfig?: any;
  voiceProvider: string;
  body?: any;
  bodyText?: string;
  events?: { emit?: (event: any) => void };
  registry?: any;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const body = normalizePlainObject(options.body);
  const message = normalizePlainObject(body.message);
  const type = String(message.type ?? '').trim();

  const call = normalizePlainObject(message.call);
  const providerCallId = String(call.id ?? options.callConfig?.providerCallId ?? '').trim();
  const endedDedupeKey = providerCallId || String(options.callConfigId).trim();
  const emit = (event: any) => {
    try {
      options.events?.emit?.({ ...event, ...(providerCallId ? { providerCallId } : {}) });
    } catch {}
  };

  if (type === 'tool-calls' || type === 'function-call') {
    const callConfigId = String(options.callConfigId).trim();
    const metadata = {
      ...(callConfigId ? { callConfigId } : {}),
      ...(providerCallId ? { providerCallId } : {})
    };

    const callConfig = normalizePlainObject(options.callConfig);
    const realtimeSpec = normalizePlainObject(callConfig.realtimeSpec);
    const provider = String(realtimeSpec.provider ?? options.voiceProvider).trim();
    const model = String(realtimeSpec.model ?? '').trim();

    const toolCalls: ExtractedToolCall[] = [];
    try {
      if (type === 'tool-calls') {
        toolCalls.push(...extractToolCallsFromMessage(message));
      } else {
        const functionCall = normalizePlainObject(message.functionCall);
        const toolCallId = String(functionCall.id ?? message.toolCallId ?? '').trim();
        const name = String(functionCall.name ?? '').trim();
        const argsRaw = functionCall.parameters ?? functionCall.arguments;
        if (toolCallId && name) {
          let args: Record<string, any> = {};
          let parseError: string | undefined;
          try {
            args = normalizeToolArgs(argsRaw);
          } catch {
            parseError = 'invalid_tool_arguments';
            args = {};
          }
          toolCalls.push({ toolCallId, name, args, ...(parseError ? { parseError } : {}) });
        }
      }
    } catch (err: any) {
      const toolCallIdFallback = String(message.toolCallId ?? '').trim() || `tool_${Date.now()}`;
      const nameFallback = String(message?.functionCall?.name ?? message?.name ?? '').trim() || 'tool';
      const error = stripToSingleLine(err?.message ?? String(err));
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: [{ name: nameFallback, toolCallId: toolCallIdFallback, error }] })
      };
    }

    if (toolCalls.length === 0) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: [] })
      };
    }

    const getProcessRoutes = options.registry?.getProcessRoutes;
    if (typeof getProcessRoutes !== 'function') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          results: toolCalls.map(tc => ({
            name: tc.name,
            toolCallId: tc.toolCallId,
            error: tc.parseError ? tc.parseError : 'tool_execution_unavailable'
          }))
        })
      };
    }

    const routes = await getProcessRoutes.call(options.registry).catch(() => []);
    const { ToolCoordinator } = await import('../../../../../../../modules/tools/index.js');
    const coordinator = new ToolCoordinator(Array.isArray(routes) ? routes : [], undefined, { registry: options.registry });

    const results = await mapWithConcurrency(
      toolCalls,
      Math.min(4, toolCalls.length),
      async (tc): Promise<{ name: string; toolCallId: string; result?: string; error?: string }> => {
        if (tc.parseError) {
          return { name: tc.name, toolCallId: tc.toolCallId, error: tc.parseError };
        }

        try {
          const invoked = await coordinator.routeAndInvoke(tc.name, tc.toolCallId, tc.args, { provider, model, metadata });
          const payload = invoked && typeof invoked === 'object' && 'result' in invoked ? (invoked as any).result : invoked;
          const text = stripToSingleLine(typeof payload === 'string' ? payload : JSON.stringify(payload));
          return { name: tc.name, toolCallId: tc.toolCallId, result: text };
        } catch (err: any) {
          const message = stripToSingleLine(err?.message ?? String(err));
          const error = message.endsWith('undefined') || message.endsWith('null') ? 'tool_invocation_failed' : message;
          return { name: tc.name, toolCallId: tc.toolCallId, error };
        }
      }
    );

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results })
    };
  } else if (type.startsWith('transcript')) {
    const roleRaw = String(message.role ?? '').trim().toLowerCase();
    const role = roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : '';
    const transcript = String(message.transcript ?? '').trim();

    const transcriptTypeRaw = String(message.transcriptType ?? '').trim().toLowerCase();
    const transcriptType =
      transcriptTypeRaw === 'final' ? 'final' : transcriptTypeRaw === 'partial' ? 'partial' : type.includes('final') ? 'final' : '';

    if (role && transcript && transcriptType) {
      if (role === 'user') {
        if (transcriptType === 'final') {
          emit({ type: 'user_transcript.final', text: transcript });
        } else {
          emit({ type: 'user_transcript.delta', textDelta: transcript });
        }
      } else if (role === 'assistant') {
        if (transcriptType === 'final') {
          emit({ type: 'assistant_transcript.final', text: transcript });
        } else {
          emit({ type: 'assistant_transcript.delta', textDelta: transcript });
        }
      }
    }
  } else if (type === 'speech-update') {
    const roleRaw = String(message.role ?? '').trim().toLowerCase();
    const status = String(message.status ?? '').trim().toLowerCase();
    const role = roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : '';
    if (role === 'user') {
      if (status === 'started') emit({ type: 'user_speech.started' });
      if (status === 'stopped') emit({ type: 'user_speech.stopped' });
    } else if (role === 'assistant') {
      if (status === 'started') emit({ type: 'voice.assistant_audio.started' });
      if (status === 'stopped') {
        emit({ type: 'voice.assistant_audio.ended' });
        emit({ type: 'voice.playback.drained' });
      }
    }
  } else if (type === 'status-update') {
    const status = String(message.status ?? '').trim().toLowerCase();
    if (status === 'in-progress') {
      emit({ type: 'voice.call.connected' });
    } else if (status === 'ended') {
      const endedReason = String(message.endedReason ?? '').trim();
      if (shouldEmitEndedEvent(endedDedupeKey)) {
        emit({ type: 'voice.call.ended', ...(endedReason ? { endedReason } : {}) });
      }
    }
  } else if (type === 'end-of-call-report') {
    const endedReason = String(message.endedReason ?? '').trim();
    if (shouldEmitEndedEvent(endedDedupeKey)) {
      emit({ type: 'voice.call.ended', ...(endedReason ? { endedReason } : {}) });
    }
  }

  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
}
