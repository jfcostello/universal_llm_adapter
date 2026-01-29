import type { Message, RealtimeAudioFrame, RealtimeEvent, RealtimeHistoryItem } from '../../../../../kernel/index.js';
import { AsyncQueue, Role } from '../../../../../kernel/index.js';

import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_DURATION_MS, DEFAULT_ON_TIMEOUT } from './constants.js';
import { estimateBase64Bytes } from './base64.js';
import { RealtimeDtmfHandler } from './dtmf-handler.js';
import { RealtimeObservabilityTracker } from './observability-tracker.js';
import { RealtimeTimeoutManager } from './timeout-manager.js';
import { RealtimeToolHandler } from './tool-handler.js';
import type { RealtimeSession, RealtimeSessionControllerOptions, RealtimeSessionLogger } from './types.js';

export class RealtimeSessionController implements RealtimeSession {
  private readonly queue = new AsyncQueue<RealtimeEvent>();
  private maxBufferedEvents: number | undefined;
  private bufferOverflowed = false;
  private closed = false;
  private eventsConsumed = false;

  private readonly timeoutManager: RealtimeTimeoutManager;
  private readonly toolHandler: RealtimeToolHandler;
  private readonly dtmfHandler: RealtimeDtmfHandler;
  private readonly observabilityTracker: RealtimeObservabilityTracker;
  private readonly logger: RealtimeSessionLogger | undefined;

  private currentSpeechTurnAudioStartMs: number | undefined;
  private lastSpeechTurnAudioEndMs: number | undefined;

  private audioSent = {
    frames: 0,
    bytes: 0
  };

  constructor(private options: RealtimeSessionControllerOptions) {
    this.logger = options.logger as any;

    const timeoutCfg = options.spec.timeout ?? {};
    const maxDurationMs = timeoutCfg.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    const idleTimeoutMs = timeoutCfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const onTimeout = timeoutCfg.onTimeout ?? DEFAULT_ON_TIMEOUT;

    const eventBufferCfg = options.spec.eventBuffer ?? {};
    const maxEvents = Number((eventBufferCfg as any).maxEvents);
    if (Number.isFinite(maxEvents) && maxEvents > 0) {
      this.maxBufferedEvents = Math.floor(maxEvents);
    }

    this.observabilityTracker = new RealtimeObservabilityTracker({
      spec: options.spec,
      tools: options.tools,
      observability: options.observability
    });

    this.timeoutManager = new RealtimeTimeoutManager({
      maxDurationMs,
      idleTimeoutMs,
      onTimeout,
      isClosed: () => this.closed,
      pushEvent: event => this.pushEvent(event),
      closeOnTimeout: async () => {
        await this.closeInternal({ reason: 'timeout' });
      }
    });

    this.dtmfHandler = new RealtimeDtmfHandler(options.spec);

    this.toolHandler = new RealtimeToolHandler({
      registry: options.registry,
      spec: options.spec,
      tools: options.tools,
      compatSession: options.compatSession,
      pushEvent: event => this.pushEvent(event),
      closeOnError: async () => {
        await this.closeInternal({ reason: 'error', emitClosedEvent: true });
      },
      recordToolCall: call => this.observabilityTracker.recordToolCall(call)
    });

    this.safeLog('info', 'realtime.session.created', {
      provider: this.options.spec.provider,
      model: this.options.spec.model ?? this.options.spec.provider,
      systemPrompt: this.options.spec.systemPrompt,
      history: this.options.spec.history,
      metadata: this.options.spec.metadata
    });
    this.start();
  }

  events(): AsyncIterable<RealtimeEvent> {
    if (this.eventsConsumed) {
      throw new Error('events() can only be consumed once');
    }
    this.eventsConsumed = true;
    return this.queue.iterate();
  }

  async sendText(options: { text: string; role?: 'system' | 'user' }): Promise<void> {
    this.ensureOpen();
    this.timeoutManager.onActivity();
    const role = options.role === 'system' ? Role.SYSTEM : Role.USER;
    this.observabilityTracker.pushTextMessage({ role, text: options.text });
    this.safeLog('info', 'realtime.send_text', { role: options.role ?? 'user', text: options.text });
    await this.options.compatSession.sendText(options);
  }

  async injectContext(items: RealtimeHistoryItem[]): Promise<void> {
    this.ensureOpen();
    this.timeoutManager.onActivity();
    if (Array.isArray(items)) {
      for (const item of items) {
        const roleRaw = String((item as any)?.role ?? '').toLowerCase();
        const role =
          roleRaw === 'system'
            ? Role.SYSTEM
            : roleRaw === 'assistant'
              ? Role.ASSISTANT
              : Role.USER;
        this.observabilityTracker.pushTextMessage({ role, text: String((item as any)?.text ?? '') });
      }
    }
    this.safeLog('info', 'realtime.inject_context', { items });
    await this.options.compatSession.injectContext(items);
  }

  async sendDTMF(digit: string): Promise<void> {
    this.ensureOpen();
    this.timeoutManager.onActivity();
    await this.dtmfHandler.sendDTMF({
      digit,
      maybeBargeIn: async trigger => this.maybeBargeIn(trigger),
      pushEvent: event => this.pushEvent(event),
      compatSession: this.options.compatSession
    });
  }

  async sendAudio(frame: RealtimeAudioFrame): Promise<void> {
    this.ensureOpen();
    this.timeoutManager.onActivity();
    this.audioSent.frames += 1;
    this.audioSent.bytes += estimateBase64Bytes(String((frame as any)?.dataBase64 ?? ''));

    if (process.env.LLM_ADAPTER_REALTIME_LOG_AUDIO_FRAMES === '1') {
      this.safeLog('debug', 'realtime.send_audio', {
        format: frame.format,
        sampleRateHz: frame.sampleRateHz,
        channels: frame.channels,
        bytes: estimateBase64Bytes(frame.dataBase64)
      });
    }
    await this.options.compatSession.sendAudio(frame);
  }

  async commit(): Promise<void> {
    this.ensureOpen();
    this.timeoutManager.onActivity();
    this.safeLog('info', 'realtime.commit', { turn: this.observabilityTracker.getNextTurnNumber() });
    this.observabilityTracker.recordRequest();
    await this.options.compatSession.commit();
    // Give the async event pump a chance to process any immediate assistant events before the next turn.
    await Promise.resolve();
  }

  async interrupt(_options: { reason?: string } = {}): Promise<void> {
    this.ensureOpen();
    this.timeoutManager.onActivity();
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

  private async handleTimeout(reason: 'max_duration' | 'idle'): Promise<void> {
    await (this.timeoutManager as any).handleTimeout(reason);
  }

  private onActivity(): void {
    this.timeoutManager.onActivity();
  }

  private get idleTimer(): any {
    return (this.timeoutManager as any).idleTimer;
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

      this.timeoutManager.start();
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
    this.timeoutManager.onActivity();

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
      const audioStartMs = Number((event as any)?.audioStartMs);
      if (Number.isFinite(audioStartMs) && audioStartMs >= 0) {
        this.currentSpeechTurnAudioStartMs = audioStartMs;
      }
      await this.maybeBargeIn('user_speech.started');
    } else if (event.type === 'user_speech.stopped') {
      const audioEndMs = Number((event as any)?.audioEndMs);
      if (Number.isFinite(audioEndMs) && audioEndMs >= 0) {
        this.lastSpeechTurnAudioEndMs = Math.max(this.lastSpeechTurnAudioEndMs ?? 0, audioEndMs);
      }
    } else if (event.type === 'user_transcript.delta') {
      await this.maybeBargeIn('user_transcript.delta');
    }

    this.pushEvent(event);

    if (event.type === 'assistant_text.final' || event.type === 'assistant_transcript.final') {
      const text = String((event as any).text ?? '');
      this.observabilityTracker.pushTextMessage({ role: Role.ASSISTANT, text });
      this.observabilityTracker.recordResponse({ content: [{ type: 'text', text }] });
    }

    if (event.type === 'error') {
      this.observabilityTracker.recordResponse({
        error: {
          message: String((event as any).message ?? 'error'),
          code: (event as any).code ? String((event as any).code) : undefined
        }
      });
    }

    if (event.type === 'tool_call.end') {
      await this.toolHandler.handleToolCallEnd(event);
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

    if (
      (trigger === 'user_speech.started' || trigger === 'user_transcript.delta') &&
      this.currentSpeechTurnAudioStartMs !== undefined &&
      this.lastSpeechTurnAudioEndMs !== undefined &&
      this.currentSpeechTurnAudioStartMs <= this.lastSpeechTurnAudioEndMs
    ) {
      return false;
    }

    await this.options.compatSession.interrupt({ reason: 'barge_in' });
    this.pushEvent({ type: 'playback.clear_requested', reason: 'barge_in', atMs: Date.now() });
    return true;
  }

  private async closeInternal(options: {
    reason: Extract<RealtimeEvent, { type: 'closed' }>['reason'];
    emitClosedEvent?: boolean;
  }): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.timeoutManager.stop();

    this.safeLog('info', 'realtime.session.closing', { reason: options.reason });
    if (this.audioSent.frames > 0) {
      this.safeLog('info', 'realtime.audio.sent', { ...this.audioSent });
    }

    this.observabilityTracker.flushPendingTurnsOnClose(String(options.reason));

    if (options.emitClosedEvent !== false) {
      this.queue.push({ type: 'closed', reason: options.reason });
    }

    try {
      await this.options.compatSession.close();
    } catch {}

    try {
      await this.options.observability?.exporter.flush();
    } catch {}

    this.queue.close();
  }

  private safeLog(level: 'debug' | 'info' | 'warning' | 'error', message: string, data?: any): void {
    try {
      const fn = this.logger?.[level];
      if (typeof fn === 'function') fn(message, data);
    } catch {}
  }
}
