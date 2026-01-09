import { jest } from '@jest/globals';
import { bytesToBase64 } from '@/modules/audio/index.ts';
import { createSignedWsToken } from '@/modules/security/index.ts';
import { createTwilioMediaStreamsBridge } from '@/plugins/voice-modules/twilio-media-streams/index.ts';
import { MockRealtimeSession } from '@tests/helpers/mock-realtime-session.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';

function makeToken(secret: string, payload: Record<string, unknown> = {}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return createSignedWsToken({
    secret,
    payload: { iat: nowSeconds, exp: nowSeconds + 60, nonce: 'n1', ...payload }
  });
}

function startMessage(options: { streamSid?: string; accountSid?: string; customParameters?: any } = {}) {
  const streamSid = options.streamSid ?? 'MZ123';
  return JSON.stringify({
    event: 'start',
    streamSid,
    start: {
      streamSid,
      callSid: 'CA123',
      accountSid: options.accountSid ?? 'AC123',
      customParameters: options.customParameters
    }
  });
}

function mediaMessage(options: { streamSid?: string; payloadBase64?: string } = {}) {
  return JSON.stringify({
    event: 'media',
    streamSid: options.streamSid ?? 'MZ123',
    media: { payload: options.payloadBase64 ?? bytesToBase64(new Uint8Array(160).fill(0xff)) }
  });
}

function markMessage(options: { streamSid?: string; name?: string } = {}) {
  return JSON.stringify({
    event: 'mark',
    streamSid: options.streamSid ?? 'MZ123',
    mark: { name: options.name ?? 'm1' }
  });
}

function dtmfMessage(options: { streamSid?: string; digit?: string } = {}) {
  return JSON.stringify({
    event: 'dtmf',
    streamSid: options.streamSid ?? 'MZ123',
    dtmf: { digit: options.digit ?? '5' }
  });
}

function connectedMessage() {
  return JSON.stringify({ event: 'connected' });
}

function stopMessage(options: { streamSid?: string } = {}) {
  return JSON.stringify({ event: 'stop', streamSid: options.streamSid ?? 'MZ123' });
}

async function flush(): Promise<void> {
  // microtask flush that works under fake timers
  await Promise.resolve();
  await Promise.resolve();
}

describe('plugins/voice-modules/twilio-media-streams — bridge coverage cases', () => {
  test('throws if tokenSecret missing', () => {
    expect(() =>
      createTwilioMediaStreamsBridge({
        // @ts-expect-error
        createSession: async () => new MockRealtimeSession(),
        security: { tokenSecret: '' }
      })
    ).toThrow('tokenSecret');
  });

  test('throws if tokenSecret is undefined (covers nullish default branch)', () => {
    expect(() =>
      createTwilioMediaStreamsBridge({
        // @ts-expect-error
        createSession: async () => new MockRealtimeSession(),
        // @ts-expect-error
        security: { tokenSecret: undefined }
      })
    ).toThrow('tokenSecret');
  });

  test('rejects when req.url is missing (parseUrl urlLike fallback)', async () => {
    const secret = 'secret';
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret }
    });

    const ws = new MockWebSocket();
    await bridge.handleConnection(ws as any, {});
    expect(ws.closed[0]?.code).toBe(1008);
  });

  test('handles invalid request url via parseUrl fallback', async () => {
    const secret = 'secret';
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret }
    });

    const ws = new MockWebSocket();
    // Invalid absolute URL triggers parseUrl catch and falls back to localhost.
    await bridge.handleConnection(ws as any, { url: 'http://[' });
    expect(ws.closed[0]?.code).toBe(1008);
  });

  test('supports custom tokenParam', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret, tokenParam: 't' },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?t=${encodeURIComponent(token)}` });
    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('rejects when expectedTokenPayload binding mismatches', async () => {
    const secret = 'secret';
    const token = makeToken(secret, { purpose: 'other' });

    const createSession = jest.fn(async () => new MockRealtimeSession());
    const bridge = createTwilioMediaStreamsBridge({
      createSession,
      security: { tokenSecret: secret, expectedTokenPayload: { purpose: 'voice_media' } }
    });

    const ws = new MockWebSocket();
    await bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    expect(ws.closed[0]?.code).toBe(1008);
    expect(createSession).not.toHaveBeenCalled();
  });

  test('accepts when expectedTokenPayload binding matches', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret, { purpose: 'voice_media' });

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret, expectedTokenPayload: { purpose: 'voice_media' } },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y', direction: 'inbound' } }));
    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('start clears start timer (no missing_start after start)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 10, idleTimeoutMs: 0, maxSessionDurationMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y', direction: 'inbound' } }));

    jest.advanceTimersByTime(11);
    expect(ws.closed.length).toBe(0);

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('parses/sanitizes customParameters and direction variants', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const onCallStart = jest.fn();
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onCallStart }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    // Mix of string, null, and non-string values; also use callDirection in lowercase to hit lower-case fallback.
    ws.emitMessage(startMessage({
      customParameters: {
        FROM: '+15550001111',
        to: '+15550002222',
        calldirection: 'outbound',
        dropMe: null,
        num: 123
      }
    }));

    await flush();
    expect(onCallStart).toHaveBeenCalledWith(expect.objectContaining({
      from: '+15550001111',
      to: '+15550002222',
      direction: 'outbound',
      customParameters: expect.objectContaining({ num: '123' })
    }));
    expect((onCallStart as any).mock.calls[0][0].customParameters.dropMe).toBeUndefined();

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('customParameters can be non-object (sanitizeCustomParameters early return)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const onCallStart = jest.fn();
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onCallStart }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(startMessage({ customParameters: 'nope' }));
    await flush();

    expect(onCallStart).toHaveBeenCalledWith(expect.objectContaining({
      from: '',
      to: '',
      customParameters: {}
    }));

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('start metadata defaults callSid/accountSid when missing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const onCallStart = jest.fn();
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onCallStart }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(JSON.stringify({
      event: 'start',
      streamSid: 'MZ123',
      start: {
        streamSid: 'MZ123',
        customParameters: { from: 'x', to: 'y', direction: 'inbound' }
      }
    }));
    await flush();

    expect(onCallStart).toHaveBeenCalledWith(expect.objectContaining({
      callSid: '',
      accountSid: ''
    }));

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('ignores duplicate start after metadata set', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onCallStart = jest.fn();

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const createSession = jest.fn(async () => session);
    const bridge = createTwilioMediaStreamsBridge({
      createSession,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onCallStart }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    ws.emitMessage(startMessage({ customParameters: { from: 'x2', to: 'y2' } }));
    await flush();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(onCallStart).toHaveBeenCalledTimes(1);

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('sendJson no-ops after close (closed early return)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.close = jest.fn(async () => {});
    session.push({ type: 'ready', sessionId: 's1' });

    const reset = jest.fn();
    const pacer = { paceBytes: jest.fn(async () => {}), reset };

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false, pacer }, markEveryMs: 1000 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    ws.emitMessage(stopMessage({}));
    await task;

    session.push({ type: 'playback.clear_requested' });
    for (let i = 0; i < 10; i++) {
      await flush();
      if (reset.mock.calls.length > 0) break;
    }

    expect(reset).toHaveBeenCalled();
    expect(ws.sent).toHaveLength(0);

    session.finish();
    await flush();
    jest.useRealTimers();
  });

  test('playback.clear_requested drops queued outbound frames (covers generation mismatch guard)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });
    session.push({
      type: 'assistant_audio.chunk',
      frame: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, dataBase64: bytesToBase64(new Uint8Array(160 * 20)) }
    });
    session.push({ type: 'playback.clear_requested' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false }, markEveryMs: 1000 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y', direction: 'inbound' } }));

    for (let i = 0; i < 10; i++) {
      await flush();
      if (ws.sent.some(msg => JSON.parse(msg)?.event === 'clear')) break;
    }

    const sent = ws.sent.map(s => JSON.parse(s));
    expect(sent.some(m => m.event === 'clear')).toBe(true);
    expect(sent.filter(m => m.event === 'media').length).toBeLessThan(20);

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('sendJson reports ws_send_failed when socket not open', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const onError = jest.fn();
    const session = new MockRealtimeSession();
    session.push({
      type: 'ready',
      sessionId: 's1',
      audio: {
        input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
        output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
      }
    });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false }, markEveryMs: 1000 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    ws.readyState = 0;
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y', direction: 'inbound' } }));
    await flush();

    session.push({
      type: 'assistant_audio.chunk',
      frame: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, dataBase64: bytesToBase64(new Uint8Array(160)) }
    });

    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ws_send_failed' }));
    jest.useRealTimers();
  });

  test('sendJson uses String(err) fallback when ws.send throws non-Error', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const onError = jest.fn();
    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false }, markEveryMs: 1000 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    // @ts-expect-error
    ws.send = () => { throw 'boom'; };
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    session.push({
      type: 'assistant_audio.chunk',
      frame: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, dataBase64: bytesToBase64(new Uint8Array(160)) }
    });

    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ws_send_failed', message: 'boom' }));
    jest.useRealTimers();
  });

  test('ready audio config uses defaults when sampleRateHz/channels missing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({
      type: 'ready',
      sessionId: 's1',
      // @ts-expect-error
      audio: { input: { format: 'g711_ulaw' }, output: { format: 'g711_ulaw' } }
    });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();
    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('media before start closes with media_before_start', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(mediaMessage({}));
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'media_before_start' }));
    jest.useRealTimers();
  });

  test('streamSid mismatch closes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ streamSid: 'MZ_A', customParameters: { from: 'x', to: 'y' } }));
    ws.emitMessage(mediaMessage({ streamSid: 'MZ_B' }));
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'stream_sid_mismatch' }));
    jest.useRealTimers();
  });

  test('inbound backpressure closes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { maxPendingInboundFrames: 0, startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    ws.emitMessage(mediaMessage({}));
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'inbound_backpressure' }));
    jest.useRealTimers();
  });

  test('outbound backpressure clears playback without interrupt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { maxPendingOutboundFrames: 1, startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false }, markEveryMs: 1000 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    session.push({
      type: 'assistant_audio.chunk',
      frame: {
        format: 'g711_ulaw',
        sampleRateHz: 8000,
        channels: 1,
        // 320 bytes @ 8kHz ulaw mono is 40ms (2 frames at the default 20ms frame size).
        dataBase64: bytesToBase64(new Uint8Array(320).fill(0xff))
      }
    });

    let sawClear = false;
    for (let i = 0; i < 10; i++) {
      await flush();
      sawClear = ws.sent.map(s => JSON.parse(s)).some(m => m.event === 'clear');
      if (sawClear) break;
    }

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'outbound_backpressure' }));
    expect(session.interrupt).not.toHaveBeenCalled();
    expect(sawClear).toBe(true);

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('mark/dtmf before start are ignored; connected is accepted', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 5 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(connectedMessage());
    ws.emitMessage(markMessage({ name: 'm1' }));
    ws.emitMessage(dtmfMessage({ digit: '1' }));
    jest.advanceTimersByTime(6);
    await task;
    jest.useRealTimers();
  });

  test('dtmf after start emits callback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onDtmf = jest.fn();

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onDtmf }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();
    ws.emitMessage(dtmfMessage({ digit: '9' }));
    await flush();

    expect(onDtmf).toHaveBeenCalledWith(expect.objectContaining({ digit: '9' }));
    expect(session.sendDTMF).toHaveBeenCalledWith('9');

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('session sendDTMF failure closes with session_send_dtmf_failed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.sendDTMF.mockImplementation(async () => { throw new Error('boom'); });
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();
    ws.emitMessage(dtmfMessage({ digit: '5' }));

    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_send_dtmf_failed' }));
    jest.useRealTimers();
  });

  test('session sendDTMF failure stringifies non-Error throwables', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.sendDTMF.mockImplementation(async () => { throw {}; });
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();
    ws.emitMessage(dtmfMessage({ digit: '5' }));

    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_send_dtmf_failed', message: '[object Object]' }));
    jest.useRealTimers();
  });

  test('session sendDTMF failure closes even without onError callback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.sendDTMF.mockImplementation(async () => { throw new Error('boom'); });
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();
    ws.emitMessage(dtmfMessage({ digit: '5' }));

    await task;
    expect(ws.closed.length).toBeGreaterThan(0);
    jest.useRealTimers();
  });

  test('invalid JSON message closes with invalid_twilio_message', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage('{');
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_twilio_message' }));
    jest.useRealTimers();
  });

  test('session sendAudio failure closes with session_send_audio_failed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.sendAudio.mockImplementation(async () => { throw new Error('boom'); });
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    ws.emitMessage(mediaMessage({}));
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_send_audio_failed' }));
    jest.useRealTimers();
  });

  test('session sendAudio failure uses String(err) fallback when non-Error thrown', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    // @ts-expect-error
    session.sendAudio.mockImplementation(async () => { throw 'boom'; });
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    ws.emitMessage(mediaMessage({}));
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_send_audio_failed', message: 'boom' }));
    jest.useRealTimers();
  });

  test('session ready not first closes with session_pump_failed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.push({ type: 'assistant_audio.end' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_pump_failed' }));
    jest.useRealTimers();
  });

  test('session pump failure uses String(err) fallback when session.events throws non-Error', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    // @ts-expect-error
    session.events = () => { throw 'boom'; };

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await task;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_pump_failed', message: 'boom' }));
    jest.useRealTimers();
  });

  test('commit failure reports session_commit_failed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    session.commit.mockImplementation(async () => { throw new Error('commit boom'); });
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    session.push({ type: 'user_speech.started' });
    session.push({ type: 'user_speech.stopped' });
    await task;

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_commit_failed' }));
    jest.useRealTimers();
  });

  test('commit failure uses String(err) fallback when non-Error thrown', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);
    const onError = jest.fn();

    const session = new MockRealtimeSession();
    // @ts-expect-error
    session.commit.mockImplementation(async () => { throw 'boom'; });
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: { onError }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    session.push({ type: 'user_speech.started' });
    session.push({ type: 'user_speech.stopped' });
    await task;

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_commit_failed', message: 'boom' }));
    jest.useRealTimers();
  });

	  test('grace-window scheduled commit failure reports session_commit_failed', async () => {
	    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
	    const secret = 'secret';
	    const token = makeToken(secret);
	    const onError = jest.fn();
	    let resolveSawStopped: (() => void) | undefined;
	    const sawStopped = new Promise<void>(resolve => {
	      resolveSawStopped = resolve;
	    });

	    const session = new MockRealtimeSession();
	    session.commit.mockImplementation(async () => { throw new Error('commit boom'); });
	    session.push({ type: 'ready', sessionId: 's1' });

	    const bridge = createTwilioMediaStreamsBridge({
	      createSession: async () => session,
	      security: { tokenSecret: secret },
	      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, firstTurnGraceMs: 50 } as any,
	      callbacks: {
	        onError,
	        onRealtimeEvent: ({ event }) => {
	          if (event?.type === 'user_speech.stopped') resolveSawStopped?.();
	        }
	      }
	    });

	    const ws = new MockWebSocket();
	    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
	    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
	    await flush();

	    session.push({ type: 'user_speech.started' });
	    session.push({ type: 'user_speech.stopped' });
	    await flush();
	    await sawStopped;

	    expect(session.commit).not.toHaveBeenCalled();
	    expect(onError).not.toHaveBeenCalled();
	    expect(ws.closed.length).toBe(0);

    jest.advanceTimersByTime(49);
    await flush();

    expect(session.commit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flush();

    await task;

	    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_commit_failed', message: 'commit boom' }));
	    jest.useRealTimers();
	  });

	  test('grace-window scheduled commit failure uses String(err) fallback when non-Error thrown', async () => {
	    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
	    const secret = 'secret';
	    const token = makeToken(secret);
	    const onError = jest.fn();
	    let resolveSawStopped: (() => void) | undefined;
	    const sawStopped = new Promise<void>(resolve => {
	      resolveSawStopped = resolve;
	    });

	    const session = new MockRealtimeSession();
	    // eslint-disable-next-line no-throw-literal
	    session.commit.mockImplementation(async () => { throw 'boom'; });
	    session.push({ type: 'ready', sessionId: 's1' });

	    const bridge = createTwilioMediaStreamsBridge({
	      createSession: async () => session,
	      security: { tokenSecret: secret },
	      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, firstTurnGraceMs: 50 } as any,
	      callbacks: {
	        onError,
	        onRealtimeEvent: ({ event }) => {
	          if (event?.type === 'user_speech.stopped') resolveSawStopped?.();
	        }
	      }
	    });

	    const ws = new MockWebSocket();
	    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
	    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
	    await flush();

	    session.push({ type: 'user_speech.started' });
	    session.push({ type: 'user_speech.stopped' });
	    await flush();
	    await sawStopped;

	    jest.advanceTimersByTime(60);
	    await flush();

	    await task;

	    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_commit_failed', message: 'boom' }));
	    jest.useRealTimers();
	  });

	  test('grace-window cancels pending commit if user starts speaking again before grace ends', async () => {
	    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
	    const secret = 'secret';
	    const token = makeToken(secret);

	    const session = new MockRealtimeSession();
	    session.push({ type: 'ready', sessionId: 's1' });

	    let startedCount = 0;
	    let stoppedCount = 0;
	    let resolveFirstStop: (() => void) | undefined;
	    let resolveSecondStart: (() => void) | undefined;
	    let resolveSecondStop: (() => void) | undefined;
	    const firstStop = new Promise<void>(resolve => { resolveFirstStop = resolve; });
	    const secondStart = new Promise<void>(resolve => { resolveSecondStart = resolve; });
	    const secondStop = new Promise<void>(resolve => { resolveSecondStop = resolve; });

	    const bridge = createTwilioMediaStreamsBridge({
	      createSession: async () => session,
	      security: { tokenSecret: secret },
	      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, firstTurnGraceMs: 50 } as any,
	      callbacks: {
	        onRealtimeEvent: ({ event }) => {
	          if (event?.type === 'user_speech.started') {
	            startedCount += 1;
	            if (startedCount === 2) resolveSecondStart?.();
	          } else if (event?.type === 'user_speech.stopped') {
	            stoppedCount += 1;
	            if (stoppedCount === 1) resolveFirstStop?.();
	            if (stoppedCount === 2) resolveSecondStop?.();
	          }
	        }
	      }
	    });

	    const ws = new MockWebSocket();
	    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
	    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
	    await flush();

	    session.push({ type: 'user_speech.started' });
	    session.push({ type: 'user_speech.stopped' });
	    await firstStop;

	    // Start speaking again before grace ends, which should cancel the pending grace commit.
	    session.push({ type: 'user_speech.started' });
	    await secondStart;

	    jest.advanceTimersByTime(60);
	    await flush();
	    expect(session.commit).not.toHaveBeenCalled();

	    // Stop speaking after grace ends; commit should happen immediately (non-grace path).
	    session.push({ type: 'user_speech.stopped' });
	    await secondStop;
	    expect(session.commit).toHaveBeenCalledTimes(1);

	    ws.emitMessage(stopMessage({}));
	    await task;
	    jest.useRealTimers();
	  });

	  test('treats firstTurnGraceMs as 0 when explicitly undefined', async () => {
	    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
	    const secret = 'secret';
	    const token = makeToken(secret);

	    const session = new MockRealtimeSession();
	    session.push({ type: 'ready', sessionId: 's1' });

	    const bridge = createTwilioMediaStreamsBridge({
	      createSession: async () => session,
	      security: { tokenSecret: secret },
	      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, firstTurnGraceMs: undefined } as any
	    });

	    const ws = new MockWebSocket();
	    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
	    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
	    await flush();
	    ws.emitMessage(stopMessage({}));
	    await task;
	    jest.useRealTimers();
	  });

	  test('bridge_error uses fallback code when non-coded error thrown in message handler', async () => {
	    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
	    const secret = 'secret';
	    const token = makeToken(secret);
	    const onError = jest.fn();

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      callbacks: {
        onCallStart: () => { throw 'boom'; },
        onError
      }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await task;

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'bridge_error', message: 'boom' }));
    jest.useRealTimers();
  });

  test('inbound queue ignores pushes after close', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    ws.emitMessage(stopMessage({}));
    await task;

    // After closeAll, inboundAudioQueue is closed; media triggers a push that should no-op.
    ws.emitMessage(mediaMessage({}));

    jest.useRealTimers();
  });

  test('timeout event triggers clear message', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false }, markEveryMs: 1000 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    session.push({ type: 'timeout', reason: 'idle', elapsedMs: 1, configuredMs: 1 });
    let sawClear = false;
    for (let i = 0; i < 10; i++) {
      await flush();
      sawClear = ws.sent.map(s => JSON.parse(s)).some(m => m.event === 'clear');
      if (sawClear) break;
    }
    expect(sawClear).toBe(true);

    ws.emitMessage(stopMessage({}));
    await task;
    jest.useRealTimers();
  });

  test('ws error event triggers closeAll', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const secret = 'secret';
    const token = makeToken(secret);

    const bridge = createTwilioMediaStreamsBridge({
      createSession: async () => new MockRealtimeSession(),
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emit('error', new Error('boom'));
    await task;
    jest.useRealTimers();
  });
});
