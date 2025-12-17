import { jest } from '@jest/globals';
import { AudioPacer } from '../../../modules/audio/index.js';

describe('audio/pacer', () => {
  test('paces based on accumulated durations', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];

    const pacer = new AudioPacer({
      now: () => nowMs,
      sleep: async (ms) => {
        const v = Math.max(0, Math.floor(ms));
        sleeps.push(v);
        nowMs += v;
      }
    });

    await pacer.paceDurationMs(20); // immediate
    await pacer.paceDurationMs(20); // +20
    await pacer.paceDurationMs(20); // +20

    expect(sleeps).toEqual([20, 20]);
    expect(nowMs).toBe(40);
  });

  test('does not sleep when behind schedule', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const pacer = new AudioPacer({
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(Math.max(0, Math.floor(ms)));
        nowMs += Math.max(0, Math.floor(ms));
      }
    });

    await pacer.paceDurationMs(20);
    nowMs = 1000; // simulate delay elsewhere
    await pacer.paceDurationMs(20);

    expect(sleeps).toEqual([]);
  });

  test('reset clears schedule', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const pacer = new AudioPacer({
      now: () => nowMs,
      sleep: async (ms) => {
        const v = Math.max(0, Math.floor(ms));
        sleeps.push(v);
        nowMs += v;
      }
    });

    await pacer.paceDurationMs(20);
    await pacer.paceDurationMs(20);
    expect(sleeps).toEqual([20]);

    pacer.reset();
    await pacer.paceDurationMs(20);
    expect(sleeps).toEqual([20]);
  });

  test('paceBytes converts byteLength to duration and paces', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const pacer = new AudioPacer({
      now: () => nowMs,
      sleep: async (ms) => {
        const v = Math.max(0, Math.floor(ms));
        sleeps.push(v);
        nowMs += v;
      }
    });

    // 8kHz * 20ms = 160 bytes for 8-bit mono
    await pacer.paceBytes({ format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, byteLength: 160 });
    await pacer.paceBytes({ format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, byteLength: 160 });
    expect(sleeps).toEqual([20]);
  });

  test('paceBytes throws on unsupported formats', async () => {
    const pacer = new AudioPacer({
      now: () => 0,
      sleep: async () => {}
    });
    await expect(
      pacer.paceBytes({ format: 'nope' as any, sampleRateHz: 8000, channels: 1, byteLength: 1 })
    ).rejects.toThrow('Unsupported audio format');
  });

  test('default deps use setTimeout for sleeping (fake timers)', async () => {
    jest.useFakeTimers();
    try {
      const pacer = new AudioPacer();
      await pacer.paceDurationMs(10); // schedule next chunk 10ms ahead
      const p = pacer.paceDurationMs(0); // should sleep ~10ms
      await jest.advanceTimersByTimeAsync(10);
      await p;
    } finally {
      jest.useRealTimers();
    }
  });
});
