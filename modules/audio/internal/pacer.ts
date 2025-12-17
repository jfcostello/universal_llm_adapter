import { bytesPerSample, durationMsForBytes, type AudioFormat } from './framing.js';

export interface AudioPacerDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: AudioPacerDeps = {
  now: () => Date.now(),
  sleep: async (ms: number) => {
    const wait = Math.max(0, Math.floor(ms));
    await new Promise<void>(resolve => setTimeout(resolve, wait));
  }
};

export class AudioPacer {
  private nextSendAtMs: number | null = null;

  constructor(private deps: AudioPacerDeps = defaultDeps) {}

  reset() {
    this.nextSendAtMs = null;
  }

  async paceDurationMs(durationMs: number): Promise<void> {
    const dur = Math.max(0, durationMs);
    const now = this.deps.now();
    if (this.nextSendAtMs === null) this.nextSendAtMs = now;
    if (this.nextSendAtMs < now) this.nextSendAtMs = now;

    const delayMs = this.nextSendAtMs - now;
    if (delayMs > 0) {
      await this.deps.sleep(delayMs);
    }

    this.nextSendAtMs += dur;
  }

  async paceBytes(options: {
    format: AudioFormat;
    sampleRateHz: number;
    channels: 1 | 2;
    byteLength: number;
  }): Promise<void> {
    // Validate format early; durationMsForBytes calls bytesPerSample (exhaustive)
    void bytesPerSample(options.format);
    const durationMs = durationMsForBytes({
      format: options.format,
      sampleRateHz: options.sampleRateHz,
      channels: options.channels,
      byteLength: options.byteLength
    });
    await this.paceDurationMs(durationMs);
  }
}
