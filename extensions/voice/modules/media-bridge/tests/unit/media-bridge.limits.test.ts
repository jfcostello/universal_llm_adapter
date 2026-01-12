import { jest } from '@jest/globals';
import { createSignedWsToken } from '@/modules/security/index.ts';
import { MockRealtimeSession } from '@tests/helpers/mock-realtime-session.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';
import { createTestMediaBridge, mediaMessage, startMessage, stopMessage } from '../helpers/test-media-protocol.ts';

function makeToken(secret: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return createSignedWsToken({
    secret,
    payload: { iat: nowSeconds, exp: nowSeconds + 60, nonce: 'n1' }
  });
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('extensions/voice/modules/media-bridge: limits', () => {
  test('enforces max WS message size', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTestMediaBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { maxWsMessageBytes: 10 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(Buffer.alloc(20));
    await task;
    expect(ws.closed.some(c => c.code === 1009)).toBe(true);
    jest.useRealTimers();
  });

  test('enforces start timeout', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTestMediaBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 10 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    jest.advanceTimersByTime(11);
    await task;
    expect(ws.closed.some(c => c.code === 1008)).toBe(true);
    jest.useRealTimers();
  });

  test('enforces idle timeout', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTestMediaBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { idleTimeoutMs: 10, startTimeoutMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    jest.advanceTimersByTime(11);
    await task;
    expect(ws.closed.some(c => c.code === 1000)).toBe(true);
    jest.useRealTimers();
  });

  test('enforces max session duration', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTestMediaBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { maxSessionDurationMs: 10, startTimeoutMs: 0, idleTimeoutMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    jest.advanceTimersByTime(11);
    await task;
    expect(ws.closed.some(c => c.code === 1000)).toBe(true);
    jest.useRealTimers();
  });

  test('enforces audio byte rate limit', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const onError = jest.fn();
    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { maxAudioBytesPerSecond: 10, startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(startMessage({}));
    ws.emitMessage(mediaMessage({ payloadBase64: Buffer.alloc(200).toString('base64') }));

    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'audio_rate_limited' }));
    jest.useRealTimers();
  });

  test('clamps maxPendingOutboundFrames to >= 1 to avoid permanent backpressure clears', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({
      type: 'ready',
      sessionId: 's1',
      audio: {
        input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
        output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
      }
    });

    const onError = jest.fn();
    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, maxPendingOutboundFrames: 0 },
      audio: { pacing: { enabled: false } },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(startMessage({}));
    await flush();

    // Send 40ms of assistant audio => two 20ms media frames.
    const outBytes = new Uint8Array(320).fill(0xab);
    session.push({
      type: 'assistant_audio.chunk',
      frame: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, dataBase64: Buffer.from(outBytes).toString('base64') }
    });
    await flush();

    const sent = ws.sent.map(s => JSON.parse(s));
    const media = sent.filter(m => m.event === 'media');
    expect(media).toHaveLength(1);
    expect(Buffer.from(media[0].media.payload, 'base64')).toHaveLength(160);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'outbound_backpressure' }));

    ws.emitMessage(stopMessage({}));
    await task;
  });
});
