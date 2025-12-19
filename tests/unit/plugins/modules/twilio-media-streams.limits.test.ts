import { jest } from '@jest/globals';
import { createSignedWsToken } from '@/modules/security/index.ts';
import { createTwilioMediaStreamsBridge } from '@/plugins/modules/twilio-media-streams/index.ts';
import { MockRealtimeSession } from '@tests/helpers/mock-realtime-session.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';

function makeToken(secret: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return createSignedWsToken({
    secret,
    payload: { iat: nowSeconds, exp: nowSeconds + 60, nonce: 'n1' }
  });
}

function startMessage(options: { streamSid?: string; accountSid?: string; customParameters?: Record<string, any> }) {
  return JSON.stringify({
    event: 'start',
    streamSid: options.streamSid ?? 'MZ123',
    start: {
      streamSid: options.streamSid ?? 'MZ123',
      accountSid: options.accountSid ?? 'AC123',
      callSid: 'CA123',
      customParameters: options.customParameters ?? {
        from: '+15551234567',
        to: '+15557654321',
        direction: 'inbound'
      }
    }
  });
}

function mediaMessage(options: { streamSid?: string; payloadBase64?: string }) {
  return JSON.stringify({
    event: 'media',
    streamSid: options.streamSid ?? 'MZ123',
    media: { payload: options.payloadBase64 ?? Buffer.alloc(200).toString('base64') }
  });
}

describe('plugins/modules/twilio-media-streams (limits + security)', () => {
  test('rejects missing token', async () => {
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: 'secret' }
    });

    const ws = new MockWebSocket();
    await bridge.handleConnection(ws as any, { url: '/ws' });
    expect(ws.closed[0]?.code).toBe(1008);
  });

  test('rejects invalid token', async () => {
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: 'secret' }
    });

    const ws = new MockWebSocket();
    await bridge.handleConnection(ws as any, { url: '/ws?token=invalid' });
    expect(ws.closed[0]?.code).toBe(1008);
  });

  test('enforces max WS message size', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTwilioMediaStreamsBridge({
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

    const bridge = createTwilioMediaStreamsBridge({
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

    const bridge = createTwilioMediaStreamsBridge({
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

    const bridge = createTwilioMediaStreamsBridge({
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

  test('enforces AccountSid allowlist on start', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret, allowedAccountSids: ['AC_OK'] },
      limits: { startTimeoutMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(startMessage({ accountSid: 'AC_BAD' }));
    await task;
    expect(ws.closed.some(c => c.code === 1008)).toBe(true);
    jest.useRealTimers();
  });

  test('enforces audio byte rate limit', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const onError = jest.fn();
    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
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
});
