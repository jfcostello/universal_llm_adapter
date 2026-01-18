import type { RealtimeEvent, RealtimeSessionSpec } from '../../../../../kernel/index.js';

export class RealtimeTimeoutManager {
  private startedAtMs = Date.now();
  private lastActivityAtMs = Date.now();
  private ready = false;
  private maxTimer: any | undefined;
  private idleTimer: any | undefined;

  constructor(private options: {
    maxDurationMs: number;
    idleTimeoutMs: number;
    onTimeout: NonNullable<RealtimeSessionSpec['timeout']>['onTimeout'];
    isClosed: () => boolean;
    pushEvent: (event: RealtimeEvent) => void;
    closeOnTimeout: () => Promise<void>;
  }) {}

  start(): void {
    if (this.options.isClosed() || this.ready) return;
    this.ready = true;
    const now = Date.now();
    this.startedAtMs = now;
    this.lastActivityAtMs = now;
    this.scheduleMaxTimer();
    this.scheduleIdleTimer();
  }

  onActivity(): void {
    if (this.options.isClosed()) return;
    this.lastActivityAtMs = Date.now();
    if (!this.ready) return;
    this.scheduleIdleTimer();
  }

  stop(): void {
    this.clearMaxTimer();
    this.clearIdleTimer();
  }

  private scheduleMaxTimer(): void {
    if (!Number.isFinite(this.options.maxDurationMs) || this.options.maxDurationMs <= 0) return;
    this.clearMaxTimer();
    this.maxTimer = setTimeout(() => void this.handleTimeout('max_duration'), this.options.maxDurationMs);
  }

  private scheduleIdleTimer(): void {
    if (!Number.isFinite(this.options.idleTimeoutMs) || this.options.idleTimeoutMs <= 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.handleTimeout('idle'), this.options.idleTimeoutMs);
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
    if (this.options.isClosed()) return;

    const now = Date.now();
    const elapsedMs = reason === 'idle' ? now - this.lastActivityAtMs : now - this.startedAtMs;
    const configuredMs = reason === 'idle' ? this.options.idleTimeoutMs : this.options.maxDurationMs;

    this.options.pushEvent({
      type: 'timeout',
      reason,
      elapsedMs,
      configuredMs
    });

    this.options.pushEvent({
      type: 'playback.clear_requested',
      reason: 'timeout',
      atMs: now
    });

    if (this.options.onTimeout === 'close') {
      await this.options.closeOnTimeout();
    }
  }
}
