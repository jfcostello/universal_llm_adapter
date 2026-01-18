import type { RealtimeCompatSession, RealtimeEvent, RealtimeSessionSpec } from '../../../../../kernel/index.js';

export class RealtimeDtmfHandler {
  private mode: NonNullable<RealtimeSessionSpec['dtmf']>['mode'];
  private terminators: Set<string>;
  private maxDigits: number;
  private buffer = '';
  private bargedInThisBuffer = false;

  constructor(spec: RealtimeSessionSpec) {
    const dtmfCfg = spec.dtmf ?? {};
    this.mode = dtmfCfg.mode ?? 'digit';
    this.terminators = new Set((dtmfCfg.terminators ?? ['#']).map(s => String(s)));
    this.maxDigits = Math.max(1, Math.floor(dtmfCfg.maxDigits ?? 32));
  }

  async sendDTMF(options: {
    digit: string;
    maybeBargeIn: (trigger: 'user_dtmf.digit' | 'user_dtmf.sequence') => Promise<boolean>;
    pushEvent: (event: RealtimeEvent) => void;
    compatSession: RealtimeCompatSession;
  }): Promise<void> {
    const d = String(options.digit ?? '');
    if (!d) {
      throw new Error('DTMF digit must be a non-empty string');
    }

    if (this.mode === 'sequence' && this.buffer.length === 0) {
      this.bargedInThisBuffer = false;
      this.bargedInThisBuffer = await options.maybeBargeIn('user_dtmf.digit');
    } else if (this.mode === 'digit') {
      await options.maybeBargeIn('user_dtmf.digit');
    }
    options.pushEvent({ type: 'user_dtmf.digit', digit: d });

    if (this.mode === 'digit') {
      await options.compatSession.sendText({ text: `DTMF: ${d}`, role: 'user' });
      await options.compatSession.commit();
      return;
    }

    // sequence mode
    this.buffer += d;
    const terminator = this.terminators.has(d) ? d : undefined;
    const shouldFlush = Boolean(terminator) || this.buffer.length >= this.maxDigits;
    if (!shouldFlush) return;

    const digits = this.buffer;
    this.buffer = '';

    if (!this.bargedInThisBuffer) {
      await options.maybeBargeIn('user_dtmf.sequence');
    }
    options.pushEvent({ type: 'user_dtmf.sequence', digits, ...(terminator ? { terminator } : {}) });

    await options.compatSession.sendText({ text: `DTMF sequence: ${digits}`, role: 'user' });
    await options.compatSession.commit();
    this.bargedInThisBuffer = false;
  }
}
