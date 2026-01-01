import { randomUUID } from 'crypto';

import type {
  ContentPart,
  JsonValue,
  Message,
  ProcessRouteManifest,
  RealtimeProviderManifest,
  RealtimeAudioFrame,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeHistoryItem,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../../kernel/index.js';
import { AsyncQueue, Role } from '../../../kernel/index.js';
import type { ObservabilityRuntime } from '../../observability/index.js';
import {
  filterContentForObservability,
  filterMessagesForObservability,
  logObservabilityEvent,
  monotonicElapsedMs,
  monotonicNowNs
} from '../../shared/index.js';

export interface RealtimeSession {
  sendText: (options: { text: string; role?: 'system' | 'user' }) => Promise<void>;
  injectContext: (items: RealtimeHistoryItem[]) => Promise<void>;
  sendDTMF: (digit: string) => Promise<void>;
  sendAudio: (frame: RealtimeAudioFrame) => Promise<void>;
  commit: () => Promise<void>;
  interrupt: (options?: { reason?: string }) => Promise<void>;
  close: () => Promise<void>;
  events: () => AsyncIterable<RealtimeEvent>;
}

export interface RealtimeSessionControllerOptions {
  registry: { getProcessRoutes: () => Promise<ProcessRouteManifest[]> };
  provider: RealtimeProviderManifest;
  spec: RealtimeSessionSpec;
  compatSession: RealtimeCompatSession;
  tools?: UnifiedTool[];
  observability?: ObservabilityRuntime;
  logger?: RealtimeSessionLogger;
}

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_ON_TIMEOUT: NonNullable<RealtimeSessionSpec['timeout']>['onTimeout'] = 'close';

type ToolCoordinatorLike = {
  routeAndInvoke: (
    toolName: string,
    callId: string,
    args: any,
    context: { provider: string; model: string; metadata?: any; logger?: any; callProgress?: any }
  ) => Promise<any>;
};

type RealtimeSessionLogger = {
  withCorrelation: (correlationId: string | string[]) => RealtimeSessionLogger;
  debug: (message: string, data?: any) => void;
  info: (message: string, data?: any) => void;
  warning: (message: string, data?: any) => void;
  error: (message: string, data?: any) => void;
};

class RealtimeSessionController implements RealtimeSession {
  private readonly queue = new AsyncQueue<RealtimeEvent>();
  private maxBufferedEvents: number | undefined;
  private bufferOverflowed = false;
  private startedAtMs = Date.now();
  private lastActivityAtMs = Date.now();
  private ready = false;
  private maxDurationMs: number;
  private idleTimeoutMs: number;
  private onTimeout: NonNullable<RealtimeSessionSpec['timeout']>['onTimeout'];
  private closed = false;
  private eventsConsumed = false;
  private maxTimer: any | undefined;
  private idleTimer: any | undefined;

  private enabledToolNames: Set<string> | undefined;
  private toolCoordinatorPromise: Promise<ToolCoordinatorLike> | undefined;

  private dtmfMode: NonNullable<RealtimeSessionSpec['dtmf']>['mode'];
  private dtmfTerminators: Set<string>;
  private dtmfMaxDigits: number;
  private dtmfBuffer = '';
  private dtmfBargedInThisBuffer = false;

  private readonly observability: ObservabilityRuntime | undefined;
  private readonly logger: RealtimeSessionLogger | undefined;
  private conversationMessages: Message[] = [];
  private observabilityTurn = 0;
  private pendingTurns: Array<{
    traceId: string;
    generationId: string;
    startTimeMonoNs: bigint;
    requestTimestampMs: number;
    toolCalls: Array<{ id: string; name: string; arguments?: any }>;
  }> = [];

  constructor(private options: RealtimeSessionControllerOptions) {
    this.observability = options.observability;
    this.logger = options.logger as any;

    const timeoutCfg = options.spec.timeout ?? {};
    this.maxDurationMs = timeoutCfg.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.idleTimeoutMs = timeoutCfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onTimeout = timeoutCfg.onTimeout ?? DEFAULT_ON_TIMEOUT;

    const eventBufferCfg = options.spec.eventBuffer ?? {};
    const maxEvents = Number((eventBufferCfg as any).maxEvents);
    if (Number.isFinite(maxEvents) && maxEvents > 0) {
      this.maxBufferedEvents = Math.floor(maxEvents);
    }

    const dtmfCfg = options.spec.dtmf ?? {};
    this.dtmfMode = dtmfCfg.mode ?? 'digit';
    this.dtmfTerminators = new Set((dtmfCfg.terminators ?? ['#']).map(s => String(s)));
    this.dtmfMaxDigits = Math.max(1, Math.floor(dtmfCfg.maxDigits ?? 32));

    if (options.spec.functionToolNames && options.spec.functionToolNames.length > 0) {
      this.enabledToolNames = new Set(options.spec.functionToolNames);
    }

    this.conversationMessages = this.buildInitialConversationMessages();
    this.safeLog('info', 'realtime.session.created', {
      provider: this.options.spec.provider,
      model: this.options.spec.model ?? this.options.spec.provider,
      systemPrompt: this.options.spec.systemPrompt,
      history: this.options.spec.history,
      metadata: this.options.spec.metadata
    });
    this.start();
  }

  private safeLog(level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any): void {
    try {
      const fn = this.logger?.[level];
      if (typeof fn === 'function') fn(message, data);
    } catch {}
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

  private pushConversationMessage(options: { role: Message['role']; text: string }): void {
    const text = String(options.text ?? '');
    if (!text) return;
    this.conversationMessages.push({
      role: options.role,
      content: [{ type: 'text', text }]
    });
  }

  private deriveTurnTraceId(turn: number): string {
    const base = String(this.observability?.baseTraceId ?? '');
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

  private recordObservabilityRequest(): void {
    const obs = this.observability;
    if (!obs) return;

    this.observabilityTurn += 1;
    const turn = this.observabilityTurn;
    const traceId = this.deriveTurnTraceId(turn);
    if (!traceId) return;

    const generationId = randomUUID();
    const timestampMs = Date.now();
    const startTimeMonoNs = monotonicNowNs();
    const captureMessages = (obs.captureMessages ?? 'full') as any;

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

  private recordObservabilityResponse(options: { content?: ContentPart[]; error?: { message: string; code?: string } }): void {
    const obs = this.observability;
    const pending = this.pendingTurns[0];
    if (!obs || !pending) return;

    const timestampMs = Date.now();
    const durationMs = monotonicElapsedMs(pending.startTimeMonoNs);
    const captureMessages = (obs.captureMessages ?? 'full') as any;
    const captureToolArgs = Boolean(obs.captureToolArgs);

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

  events(): AsyncIterable<RealtimeEvent> {
    if (this.eventsConsumed) {
      throw new Error('events() can only be consumed once');
    }
    this.eventsConsumed = true;
    return this.queue.iterate();
  }

  private pushEvent(event: RealtimeEvent): void {
    if (this.closed) return;

    if (!this.bufferOverflowed && this.maxBufferedEvents !== undefined) {
      if (this.queue.getBufferedCount() >= this.maxBufferedEvents) {
        void this.handleEventBufferOverflow();
        return;
      }
    }

    this.queue.push(event);
  }

  private async handleEventBufferOverflow(): Promise<void> {
    this.bufferOverflowed = true;

    // Drop buffered events to free memory; downstream consumers will receive an explicit error + close.
    this.queue.clear();
    const now = Date.now();
    this.queue.push({
      type: 'error',
      message: 'Realtime event buffer overflow: consumer is not draining events()',
      code: 'event_buffer_overflow'
    });
    this.queue.push({ type: 'playback.clear_requested', reason: 'error', atMs: now });

    await this.closeInternal({ reason: 'error', emitClosedEvent: true });
  }

  async sendText(options: { text: string; role?: 'system' | 'user' }): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    const role = options.role === 'system' ? Role.SYSTEM : Role.USER;
    this.pushConversationMessage({ role, text: options.text });
    this.safeLog('info', 'realtime.send_text', { role: options.role ?? 'user', text: options.text });
    await this.options.compatSession.sendText(options);
  }

  async injectContext(items: RealtimeHistoryItem[]): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    if (Array.isArray(items)) {
      for (const item of items) {
        const roleRaw = String((item as any)?.role ?? '').toLowerCase();
        const role =
          roleRaw === 'system'
            ? Role.SYSTEM
            : roleRaw === 'assistant'
              ? Role.ASSISTANT
              : Role.USER;
        this.pushConversationMessage({ role, text: String((item as any)?.text ?? '') });
      }
    }
    this.safeLog('info', 'realtime.inject_context', { items });
    await this.options.compatSession.injectContext(items);
  }

  async sendDTMF(digit: string): Promise<void> {
    this.ensureOpen();
    this.onActivity();

    const d = String(digit ?? '');
    if (!d) {
      throw new Error('DTMF digit must be a non-empty string');
    }

    if (this.dtmfMode === 'sequence' && this.dtmfBuffer.length === 0) {
      this.dtmfBargedInThisBuffer = false;
      this.dtmfBargedInThisBuffer = await this.maybeBargeIn('user_dtmf.digit');
    } else if (this.dtmfMode === 'digit') {
      await this.maybeBargeIn('user_dtmf.digit');
    }
    this.pushEvent({ type: 'user_dtmf.digit', digit: d });

    if (this.dtmfMode === 'digit') {
      await this.options.compatSession.sendText({ text: `DTMF: ${d}`, role: 'user' });
      await this.options.compatSession.commit();
      return;
    }

    // sequence mode
    this.dtmfBuffer += d;
    const terminator = this.dtmfTerminators.has(d) ? d : undefined;
    const shouldFlush = Boolean(terminator) || this.dtmfBuffer.length >= this.dtmfMaxDigits;
    if (!shouldFlush) return;

    const digits = this.dtmfBuffer;
    this.dtmfBuffer = '';

    if (!this.dtmfBargedInThisBuffer) {
      await this.maybeBargeIn('user_dtmf.sequence');
    }
    this.pushEvent({ type: 'user_dtmf.sequence', digits, ...(terminator ? { terminator } : {}) });

    await this.options.compatSession.sendText({ text: `DTMF sequence: ${digits}`, role: 'user' });
    await this.options.compatSession.commit();
    this.dtmfBargedInThisBuffer = false;
  }

  async sendAudio(frame: RealtimeAudioFrame): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    this.safeLog('debug', 'realtime.send_audio', { frame });
    await this.options.compatSession.sendAudio(frame);
  }

  async commit(): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    this.safeLog('info', 'realtime.commit', { turn: this.observabilityTurn + 1 });
    this.recordObservabilityRequest();
    await this.options.compatSession.commit();
    // Give the async event pump a chance to process any immediate assistant events before the next turn.
    await Promise.resolve();
  }

  async interrupt(_options: { reason?: string } = {}): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    this.safeLog('info', 'realtime.interrupt', { reason: _options.reason });
    await this.options.compatSession.interrupt({ reason: _options.reason });
    this.pushEvent({
      type: 'playback.clear_requested',
      reason: 'interrupt',
      atMs: Date.now()
    });
  }

  async close(): Promise<void> {
    await this.closeInternal({ reason: 'client_close' });
  }

  private start(): void {
    void this.pumpCompatEvents();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Realtime session is closed');
    }
  }

  private startTimeouts(): void {
    if (this.closed || this.ready) return;
    this.ready = true;
    const now = Date.now();
    this.startedAtMs = now;
    this.lastActivityAtMs = now;
    this.scheduleMaxTimer();
    this.scheduleIdleTimer();
  }

  private onActivity(): void {
    if (this.closed) return;
    this.lastActivityAtMs = Date.now();
    if (!this.ready) return;
    this.scheduleIdleTimer();
  }

  private scheduleMaxTimer(): void {
    if (!Number.isFinite(this.maxDurationMs) || this.maxDurationMs <= 0) return;
    this.clearMaxTimer();
    this.maxTimer = setTimeout(() => void this.handleTimeout('max_duration'), this.maxDurationMs);
  }

  private scheduleIdleTimer(): void {
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.handleTimeout('idle'), this.idleTimeoutMs);
  }

  private clearMaxTimer(): void {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async handleTimeout(reason: 'max_duration' | 'idle'): Promise<void> {
    if (this.closed) return;

    const now = Date.now();
    const elapsedMs = reason === 'idle' ? now - this.lastActivityAtMs : now - this.startedAtMs;
    const configuredMs = reason === 'idle' ? this.idleTimeoutMs : this.maxDurationMs;

    this.pushEvent({
      type: 'timeout',
      reason,
      elapsedMs,
      configuredMs
    });

    this.pushEvent({
      type: 'playback.clear_requested',
      reason: 'timeout',
      atMs: now
    });

    if (this.onTimeout === 'close') {
      await this.closeInternal({ reason: 'timeout' });
    }
  }

  private async pumpCompatEvents(): Promise<void> {
    try {
      const iter = this.options.compatSession.events()[Symbol.asyncIterator]();

      const first = await iter.next();
      if (first.done) {
        await this.closeInternal({ reason: 'provider_close', emitClosedEvent: true });
        return;
      }
      if (!first.value || (first.value as any).type !== 'ready') {
        this.pushEvent({ type: 'error', message: 'First realtime event must be ready', code: 'invalid_first_event' });
        await this.closeInternal({ reason: 'error', emitClosedEvent: true });
        return;
      }

      const history = this.options.spec.history;
      if (Array.isArray(history) && history.length > 0) {
        try {
          await this.options.compatSession.injectContext(history);
        } catch (err: any) {
          this.pushEvent({
            type: 'error',
            message: err?.message ?? String(err),
            code: 'history_injection_failed'
          });
          await this.closeInternal({ reason: 'error', emitClosedEvent: true });
          return;
        }
      }

      this.startTimeouts();
      this.pushEvent(first.value);

      while (true) {
        const next = await iter.next();
        if (next.done) break;
        await this.handleCompatEvent(next.value);
        if (this.closed) break;
      }

      if (!this.closed) {
        await this.closeInternal({ reason: 'provider_close', emitClosedEvent: true });
      }
    } catch (error: any) {
      if (!this.closed) {
        this.pushEvent({ type: 'error', message: error?.message ?? String(error), code: 'compat_error' });
        await this.closeInternal({ reason: 'error', emitClosedEvent: true });
      }
    }
  }

  private async handleCompatEvent(event: RealtimeEvent): Promise<void> {
    if (this.closed) return;
    this.onActivity();

    const eventType = String((event as any)?.type ?? '');
    if (
      eventType === 'ready' ||
      eventType === 'closed' ||
      eventType === 'timeout' ||
      eventType === 'error' ||
      eventType.endsWith('.final') ||
      eventType.startsWith('tool_call.')
    ) {
      this.safeLog('info', 'realtime.event', { event });
    }

    if (event.type === 'user_speech.started') {
      await this.maybeBargeIn('user_speech.started');
    } else if (event.type === 'user_transcript.delta') {
      await this.maybeBargeIn('user_transcript.delta');
    }

    this.pushEvent(event);

    if (event.type === 'assistant_text.final' || event.type === 'assistant_transcript.final') {
      const text = String((event as any).text ?? '');
      this.pushConversationMessage({ role: Role.ASSISTANT, text });
      this.recordObservabilityResponse({ content: [{ type: 'text', text }] });
    }

    if (event.type === 'error') {
      this.recordObservabilityResponse({
        error: { message: String((event as any).message ?? 'error'), code: (event as any).code ? String((event as any).code) : undefined }
      });
    }

    if (event.type === 'tool_call.end') {
      await this.handleToolCallEnd(event);
    }

    if (event.type === 'closed') {
      await this.closeInternal({ reason: event.reason ?? 'provider_close', emitClosedEvent: false });
    }
  }

  private async maybeBargeIn(
    trigger: 'user_speech.started' | 'user_transcript.delta' | 'user_dtmf.digit' | 'user_dtmf.sequence'
  ): Promise<boolean> {
    const cfg = this.options.spec.bargeIn;
    if (!cfg?.enabled) return false;

    const triggers = cfg.triggers ?? ['user_speech.started', 'user_dtmf.digit'];
    if (!triggers.includes(trigger)) return false;

    await this.options.compatSession.interrupt({ reason: 'barge_in' });
    this.pushEvent({ type: 'playback.clear_requested', reason: 'barge_in', atMs: Date.now() });
    return true;
  }

  private async ensureToolCoordinator(): Promise<ToolCoordinatorLike> {
    if (!this.toolCoordinatorPromise) {
      this.toolCoordinatorPromise = (async () => {
        const routes = await this.options.registry.getProcessRoutes();
        const { ToolCoordinator } = await import('../../tools/index.js');
        return new ToolCoordinator(routes as any) as unknown as ToolCoordinatorLike;
      })();
    }
    return await this.toolCoordinatorPromise;
  }

  private async handleToolCallEnd(event: Extract<RealtimeEvent, { type: 'tool_call.end' }>): Promise<void> {
    if (!this.enabledToolNames) {
      this.pushEvent({ type: 'error', message: 'Tool call received but tools are not enabled', code: 'tools_disabled' });
      await this.closeInternal({ reason: 'error', emitClosedEvent: true });
      return;
    }

    if (!this.enabledToolNames.has(event.name)) {
      this.pushEvent({ type: 'error', message: `Tool not enabled: ${event.name}`, code: 'tool_not_enabled' });
      await this.closeInternal({ reason: 'error', emitClosedEvent: true });
      return;
    }

    const pending = this.pendingTurns[0];
    if (pending) {
      pending.toolCalls.push({
        id: event.toolCallId,
        name: event.name,
        arguments: event.arguments
      });
    }

    const coordinator = await this.ensureToolCoordinator();
    try {
      const result = await coordinator.routeAndInvoke(
        event.name,
        event.toolCallId,
        event.arguments,
        {
          provider: this.options.spec.provider,
          model: this.options.spec.model ?? this.options.spec.provider,
          metadata: this.options.spec.metadata ?? {}
        }
      );
      await this.options.compatSession.sendToolResult({
        toolCallId: event.toolCallId,
        result: result as JsonValue
      });
      this.pushEvent({ type: 'tool_result.sent', toolCallId: event.toolCallId });
    } catch (error: any) {
      this.pushEvent({ type: 'error', message: `Tool execution failed: ${error?.message ?? String(error)}`, code: 'tool_error' });
      await this.closeInternal({ reason: 'error', emitClosedEvent: true });
    }
  }

  private async closeInternal(options: {
    reason: Extract<RealtimeEvent, { type: 'closed' }>['reason'];
    emitClosedEvent?: boolean;
  }): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.clearMaxTimer();
    this.clearIdleTimer();

    this.safeLog('info', 'realtime.session.closing', { reason: options.reason });

    if (this.pendingTurns.length > 0) {
      // Ensure pending turns are closed out so traces aren't left dangling.
      while (this.pendingTurns.length > 0) {
        this.recordObservabilityResponse({
          error: { message: `Realtime session closed before assistant response (${String(options.reason)})` }
        });
      }
    }

    if (options.emitClosedEvent !== false) {
      this.queue.push({ type: 'closed', reason: options.reason });
    }

    try {
      await this.options.compatSession.close();
    } catch {}

    try {
      await this.observability?.exporter.flush();
    } catch {}

    this.queue.close();
  }
}

export function createRealtimeSessionController(options: RealtimeSessionControllerOptions): RealtimeSession {
  return new RealtimeSessionController(options);
}
