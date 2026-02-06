import { randomUUID } from 'crypto';

import type {
  ContentPart,
  Message,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../../../../kernel/index.js';
import { Role } from '../../../../../kernel/index.js';
import type { ObservabilityRuntime } from '../../../../observability/index.js';
import {
  filterContentForObservability,
  filterMessagesForObservability,
  logObservabilityEvent,
  monotonicElapsedMs,
  monotonicNowNs,
  resolveObservabilityCaptureSettings
} from '../../../../shared/index.js';

export class RealtimeObservabilityTracker {
  private conversationMessages: Message[] = [];
  private turn = 0;
  private pendingTurns: Array<{
    traceId: string;
    generationId: string;
    startTimeMonoNs: bigint;
    requestTimestampMs: number;
    toolCalls: Array<{ id: string; name: string; arguments?: any }>;
  }> = [];

  constructor(private options: { spec: RealtimeSessionSpec; tools?: UnifiedTool[]; observability?: ObservabilityRuntime }) {
    this.conversationMessages = this.buildInitialConversationMessages();
  }

  getNextTurnNumber(): number {
    return this.turn + 1;
  }

  getConversationMessages(): Message[] {
    return this.conversationMessages;
  }

  pushTextMessage(options: { role: Message['role']; text: string }): void {
    const text = String(options.text ?? '');
    if (!text) return;
    this.conversationMessages.push({
      role: options.role,
      content: [{ type: 'text', text }]
    });
  }

  recordToolCall(call: { id: string; name: string; arguments?: any }): void {
    const pending = this.pendingTurns[0];
    if (!pending) return;
    pending.toolCalls.push({
      id: call.id,
      name: call.name,
      ...(call.arguments !== undefined ? { arguments: call.arguments } : {})
    });
  }

  recordRequest(): void {
    const obs = this.options.observability;
    if (!obs) return;

    this.turn += 1;
    const traceId = this.deriveTurnTraceId(this.turn);
    if (!traceId) return;

    const generationId = randomUUID();
    const timestampMs = Date.now();
    const startTimeMonoNs = monotonicNowNs();
    const { captureMessages } = resolveObservabilityCaptureSettings(obs);

    const requestEvent = {
      traceId,
      generationId,
      sessionId: obs.sessionId,
      timestampMs,
      provider: this.options.spec.provider,
      model: this.options.spec.model ?? this.options.spec.provider,
      messages: filterMessagesForObservability(this.conversationMessages, captureMessages),
      metadata: obs.metadata ?? this.options.spec.metadata,
      settings: this.options.spec.settings,
      tools: this.options.tools?.map(t => ({ name: t.name, description: t.description })) ?? []
    };

    try {
      obs.exporter.recordLLMRequest(requestEvent as any);
    } catch {
      // Observability must never throw
    }

    void this.logLiveObservabilityEvent({
      eventType: 'LLM_REQUEST',
      traceId,
      generationId,
      event: requestEvent
    });

    this.pendingTurns.push({
      traceId,
      generationId,
      startTimeMonoNs,
      requestTimestampMs: timestampMs,
      toolCalls: []
    });
  }

  recordResponse(options: { content?: ContentPart[]; error?: { message: string; code?: string } }): void {
    const obs = this.options.observability;
    const pending = this.pendingTurns[0];
    if (!obs || !pending) return;

    const timestampMs = Date.now();
    const durationMs = monotonicElapsedMs(pending.startTimeMonoNs);
    const { captureMessages, captureToolArgs } = resolveObservabilityCaptureSettings(obs);

    const responseEvent: any = {
      traceId: pending.traceId,
      generationId: pending.generationId,
      sessionId: obs.sessionId,
      timestampMs,
      provider: this.options.spec.provider,
      model: this.options.spec.model ?? this.options.spec.provider,
      content: filterContentForObservability(options.content ?? [], captureMessages),
      metadata: obs.metadata ?? this.options.spec.metadata,
      durationMs,
      ...(options.error ? { error: options.error } : {})
    };

    if (pending.toolCalls.length > 0) {
      responseEvent.toolCalls = pending.toolCalls.map(tc => {
        if (!captureToolArgs) return { id: tc.id, name: tc.name };
        return { id: tc.id, name: tc.name, ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}) };
      });
    }

    try {
      obs.exporter.recordLLMResponse(responseEvent as any);
    } catch {
      // Observability must never throw
    }

    void this.logLiveObservabilityEvent({
      eventType: 'LLM_RESPONSE',
      traceId: pending.traceId,
      generationId: pending.generationId,
      event: responseEvent
    });

    this.pendingTurns.shift();
  }

  flushPendingTurnsOnClose(reason: string): void {
    if (!this.options.observability) return;

    while (this.pendingTurns.length > 0) {
      this.recordResponse({
        error: { message: `Realtime session closed before assistant response (${String(reason)})` }
      });
    }
  }

  private buildInitialConversationMessages(): Message[] {
    const out: Message[] = [];

    const systemPrompt = this.options.spec.systemPrompt;
    if (systemPrompt !== undefined && systemPrompt !== null) {
      const text = String(systemPrompt);
      if (text) {
        out.push({ role: Role.SYSTEM, content: [{ type: 'text', text }] });
      }
    }

    const history = this.options.spec.history;
    if (Array.isArray(history) && history.length > 0) {
      for (const item of history) {
        const roleRaw = String((item as any)?.role ?? '').toLowerCase();
        const text = String((item as any)?.text ?? '');
        if (!text) continue;

        const role =
          roleRaw === 'system'
            ? Role.SYSTEM
            : roleRaw === 'assistant'
              ? Role.ASSISTANT
              : Role.USER;

        out.push({ role, content: [{ type: 'text', text }] });
      }
    }

    return out;
  }

  private deriveTurnTraceId(turn: number): string {
    const base = String(this.options.observability?.baseTraceId ?? '');
    if (!base) return '';
    if (turn <= 1) return base;
    return `${base}:${turn}`;
  }

  private async logLiveObservabilityEvent(payload: {
    eventType: 'LLM_REQUEST' | 'LLM_RESPONSE';
    traceId?: string;
    generationId?: string;
    event: unknown;
  }): Promise<void> {
    if (process.env.LLM_LIVE !== '1') return;

    try {
      logObservabilityEvent(payload as any, this.options.spec.metadata);
    } catch {
      // best-effort
    }
  }
}
