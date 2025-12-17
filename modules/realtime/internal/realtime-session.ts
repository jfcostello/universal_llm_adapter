import type {
  JsonValue,
  ProcessRouteManifest,
  ProviderManifest,
  RealtimeAudioFrame,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../kernel/index.js';
import { AsyncQueue } from './async-queue.js';

export interface RealtimeSession {
  sendText: (options: { text: string; role?: 'system' | 'user' }) => Promise<void>;
  sendAudio: (frame: RealtimeAudioFrame) => Promise<void>;
  commit: () => Promise<void>;
  interrupt: (options?: { reason?: string }) => Promise<void>;
  close: () => Promise<void>;
  events: () => AsyncIterable<RealtimeEvent>;
}

export interface RealtimeSessionControllerOptions {
  registry: { getProcessRoutes: () => Promise<ProcessRouteManifest[]> };
  provider: ProviderManifest;
  spec: RealtimeSessionSpec;
  compatSession: RealtimeCompatSession;
  tools?: UnifiedTool[];
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

class RealtimeSessionController implements RealtimeSession {
  private readonly queue = new AsyncQueue<RealtimeEvent>();
  private startedAtMs = Date.now();
  private lastActivityAtMs = Date.now();
  private maxDurationMs: number;
  private idleTimeoutMs: number;
  private onTimeout: NonNullable<RealtimeSessionSpec['timeout']>['onTimeout'];
  private closed = false;
  private eventsConsumed = false;
  private maxTimer: any | undefined;
  private idleTimer: any | undefined;

  private enabledToolNames: Set<string> | undefined;
  private toolCoordinatorPromise: Promise<ToolCoordinatorLike> | undefined;

  constructor(private options: RealtimeSessionControllerOptions) {
    const timeoutCfg = options.spec.timeout ?? {};
    this.maxDurationMs = timeoutCfg.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.idleTimeoutMs = timeoutCfg.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onTimeout = timeoutCfg.onTimeout ?? DEFAULT_ON_TIMEOUT;

    if (options.spec.functionToolNames && options.spec.functionToolNames.length > 0) {
      this.enabledToolNames = new Set(options.spec.functionToolNames);
    }

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
    this.onActivity();
    await this.options.compatSession.sendText(options);
  }

  async sendAudio(frame: RealtimeAudioFrame): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    await this.options.compatSession.sendAudio(frame);
  }

  async commit(): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    await this.options.compatSession.commit();
  }

  async interrupt(_options: { reason?: string } = {}): Promise<void> {
    this.ensureOpen();
    this.onActivity();
    await this.options.compatSession.interrupt({ reason: _options.reason });
    this.queue.push({
      type: 'playback.clear_requested',
      reason: 'interrupt',
      atMs: Date.now()
    });
  }

  async close(): Promise<void> {
    await this.closeInternal({ reason: 'client_close' });
  }

  private start(): void {
    this.scheduleMaxTimer();
    this.scheduleIdleTimer();
    void this.pumpCompatEvents();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Realtime session is closed');
    }
  }

  private onActivity(): void {
    if (this.closed) return;
    this.lastActivityAtMs = Date.now();
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

    this.queue.push({
      type: 'timeout',
      reason,
      elapsedMs,
      configuredMs
    });

    this.queue.push({
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
        this.queue.push({ type: 'error', message: 'First realtime event must be ready', code: 'invalid_first_event' });
        await this.closeInternal({ reason: 'error', emitClosedEvent: true });
        return;
      }

      this.onActivity();
      this.queue.push(first.value);

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
        this.queue.push({ type: 'error', message: error?.message ?? String(error), code: 'compat_error' });
        await this.closeInternal({ reason: 'error', emitClosedEvent: true });
      }
    }
  }

  private async handleCompatEvent(event: RealtimeEvent): Promise<void> {
    if (this.closed) return;
    this.onActivity();

    if (event.type === 'user_speech.started') {
      await this.maybeBargeIn('user_speech.started');
    } else if (event.type === 'user_transcript.delta') {
      await this.maybeBargeIn('user_transcript.delta');
    }

    this.queue.push(event);

    if (event.type === 'tool_call.end') {
      await this.handleToolCallEnd(event);
    }

    if (event.type === 'closed') {
      await this.closeInternal({ reason: event.reason ?? 'provider_close', emitClosedEvent: false });
    }
  }

  private async maybeBargeIn(trigger: 'user_speech.started' | 'user_transcript.delta'): Promise<void> {
    const cfg = this.options.spec.bargeIn;
    if (!cfg?.enabled) return;

    const triggers = cfg.triggers ?? ['user_speech.started'];
    if (!triggers.includes(trigger)) return;

    await this.options.compatSession.interrupt({ reason: 'barge_in' });
    this.queue.push({ type: 'playback.clear_requested', reason: 'barge_in', atMs: Date.now() });
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
      this.queue.push({ type: 'error', message: 'Tool call received but tools are not enabled', code: 'tools_disabled' });
      await this.closeInternal({ reason: 'error', emitClosedEvent: true });
      return;
    }

    if (!this.enabledToolNames.has(event.name)) {
      this.queue.push({ type: 'error', message: `Tool not enabled: ${event.name}`, code: 'tool_not_enabled' });
      await this.closeInternal({ reason: 'error', emitClosedEvent: true });
      return;
    }

    const coordinator = await this.ensureToolCoordinator();
    try {
      const result = await coordinator.routeAndInvoke(
        event.name,
        event.toolCallId,
        event.arguments,
        {
          provider: this.options.spec.provider,
          model: this.options.spec.model ?? this.options.spec.provider
        }
      );
      await this.options.compatSession.sendToolResult({
        toolCallId: event.toolCallId,
        result: result as JsonValue
      });
      this.queue.push({ type: 'tool_result.sent', toolCallId: event.toolCallId });
    } catch (error: any) {
      this.queue.push({ type: 'error', message: `Tool execution failed: ${error?.message ?? String(error)}`, code: 'tool_error' });
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

    if (options.emitClosedEvent !== false) {
      this.queue.push({ type: 'closed', reason: options.reason });
    }

    try {
      await this.options.compatSession.close();
    } catch {}

    this.queue.close();
  }
}

export function createRealtimeSessionController(options: RealtimeSessionControllerOptions): RealtimeSession {
  return new RealtimeSessionController(options);
}
