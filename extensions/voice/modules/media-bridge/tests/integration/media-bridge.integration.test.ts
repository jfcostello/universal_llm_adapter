import { jest } from '@jest/globals';
import { bytesToBase64, base64ToBytes } from '@/modules/audio/index.ts';
import { createRealtimeSessionController } from '@/modules/realtime/internal/realtime-session.ts';
import { createSignedWsToken } from '@/modules/security/index.ts';
import { MockRealtimeSession } from '@tests/helpers/mock-realtime-session.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';

import type { RealtimeCompatSession } from '@/kernel/index.ts';
import { createTestMediaBridge, dtmfMessage, markMessage, mediaMessage, startMessage, stopMessage } from '../helpers/test-media-protocol.ts';

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

describe('extensions/voice/modules/media-bridge: integration', () => {
  test('forwards DTMF to session (sequence mode) as a model-visible turn', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    let closeCompat: (() => void) | undefined;
    const compatClosed = new Promise<void>(resolve => {
      closeCompat = resolve;
    });

    const compatSession: RealtimeCompatSession = {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn().mockImplementation(() => closeCompat?.()),
      events: async function* () {
        yield { type: 'ready', sessionId: 's1' };
        await compatClosed;
      }
    };

    const session = createRealtimeSessionController({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      provider: { id: 'p' } as any,
      spec: {
        provider: 'p',
        timeout: { maxDurationMs: 0, idleTimeoutMs: 0, onTimeout: 'close' },
        dtmf: { mode: 'sequence', terminators: ['#'] }
      },
      compatSession
    });

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false } }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({}));
    await flush();

    ws.emitMessage(dtmfMessage({ digit: '1' }));
    ws.emitMessage(dtmfMessage({ digit: '2' }));
    ws.emitMessage(dtmfMessage({ digit: '#' }));
    await flush();

    expect(compatSession.sendText).toHaveBeenCalledWith({ text: 'DTMF sequence: 12#', role: 'user' });
    expect(compatSession.commit).toHaveBeenCalledTimes(1);

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('bridges inbound media to realtime session and returns assistant audio', async () => {
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

    const onCallStart = jest.fn();
    const onMark = jest.fn();
    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { markEveryMs: 20, pacing: { enabled: false } },
      callbacks: { onCallStart, onMark }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(startMessage({}));
    await flush();

    const inboundBytes = new Uint8Array(160).fill(0xff);
    ws.emitMessage(mediaMessage({ payloadBase64: bytesToBase64(inboundBytes) }));
    await flush();

    expect(session.sendAudio).toHaveBeenCalledTimes(1);
    const sentFrame = (session.sendAudio as any).mock.calls[0][0];
    expect(sentFrame.format).toBe('g711_ulaw');
    expect(sentFrame.sampleRateHz).toBe(8000);
    expect(sentFrame.channels).toBe(1);
    expect(base64ToBytes(sentFrame.dataBase64)).toEqual(inboundBytes);

    // Send 40ms of assistant audio => two 20ms media frames.
    const outBytes = new Uint8Array(320).fill(0xab);
    session.push({
      type: 'assistant_audio.chunk',
      frame: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, dataBase64: bytesToBase64(outBytes) }
    });
    await flush();

    const sent = ws.sent.map(s => JSON.parse(s));
    const media = sent.filter(m => m.event === 'media');
    expect(media).toHaveLength(2);
    expect(base64ToBytes(media[0].media.payload)).toEqual(new Uint8Array(160).fill(0xab));
    expect(base64ToBytes(media[1].media.payload)).toEqual(new Uint8Array(160).fill(0xab));

    const marks = sent.filter(m => m.event === 'mark');
    expect(marks.length).toBeGreaterThanOrEqual(2);

    // Mark receipt updates callback.
    ws.emitMessage(markMessage({ name: marks[0].mark.name }));
    await flush();
    expect(onMark).toHaveBeenCalledWith(expect.objectContaining({ name: marks[0].mark.name }));

    ws.emitMessage(stopMessage({}));
    await task;
    expect(session.close).toHaveBeenCalled();
  });

  test('sends a drain mark after assistant_audio.end and reports it via onMark', async () => {
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

    const onMark = jest.fn();
    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { markEveryMs: 1000, pacing: { enabled: false } },
      callbacks: { onMark }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(startMessage({}));
    await flush();

    // Send 40ms of assistant audio => two 20ms media frames.
    const outBytes = new Uint8Array(320).fill(0xab);
    session.push({
      type: 'assistant_audio.chunk',
      frame: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, dataBase64: bytesToBase64(outBytes) }
    });
    await flush();

    session.push({ type: 'assistant_audio.end' });
    await flush();

    const sent = ws.sent.map(s => JSON.parse(s));
    const lastMediaIndex = sent.map(m => m.event).lastIndexOf('media');
    expect(lastMediaIndex).toBeGreaterThanOrEqual(0);

    const drainMarks = sent.filter(m => m.event === 'mark' && typeof m?.mark?.name === 'string' && m.mark.name.startsWith('d'));
    expect(drainMarks).toHaveLength(1);

    const drainMark = drainMarks[0];
    const drainMarkIndex = sent.indexOf(drainMark);
    expect(drainMarkIndex).toBeGreaterThan(lastMediaIndex);

    ws.emitMessage(markMessage({ name: drainMark.mark.name }));
    await flush();

    expect(onMark).toHaveBeenCalledWith(expect.objectContaining({ name: drainMark.mark.name, kind: 'drain', playedMs: 40 }));

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('converts buffered pre-ready inbound media to negotiated pcm16 input', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false } }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });

    ws.emitMessage(startMessage({}));
    await flush();

    const inboundBytes = new Uint8Array(160).fill(0xff);
    ws.emitMessage(mediaMessage({ payloadBase64: bytesToBase64(inboundBytes) }));
    await flush();

    session.push({
      type: 'ready',
      sessionId: 's1',
      audio: {
        input: { format: 'pcm16', sampleRateHz: 8000, channels: 1 },
        output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
      }
    } as any);
    await flush();

    expect(session.sendAudio).toHaveBeenCalledTimes(1);
    const sentFrame = (session.sendAudio as any).mock.calls[0][0];
    expect(sentFrame.format).toBe('pcm16');
    expect(sentFrame.sampleRateHz).toBe(8000);
    expect(sentFrame.channels).toBe(1);
    expect(base64ToBytes(sentFrame.dataBase64).length).toBeGreaterThan(inboundBytes.length);

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('strips voiceMediaToken from call metadata customParameters', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const onCallStart = jest.fn();
    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false } },
      callbacks: { onCallStart }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({
      customParameters: {
        from: '+15551234567',
        to: '+15557654321',
        direction: 'inbound',
        voiceMediaToken: 'abc'
      }
    }));
    await flush();

    expect(onCallStart).toHaveBeenCalledTimes(1);
    const metadata = onCallStart.mock.calls[0]![0];
    expect(metadata?.customParameters?.voiceMediaToken).toBeUndefined();

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('drops in-flight audio after playback.clear_requested', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    let paceCalls = 0;
    let resolveSecond: (() => void) | undefined;
    const pacer = {
      reset: jest.fn(),
      paceBytes: jest.fn(async () => {
        paceCalls++;
        if (paceCalls === 1) return;
        await new Promise<void>(resolve => {
          resolveSecond = resolve;
        });
      })
    };

    const session = new MockRealtimeSession();
    session.push({
      type: 'ready',
      sessionId: 's1',
      audio: {
        input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
        output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
      }
    });

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { markEveryMs: 1000, pacing: { enabled: true, pacer } }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({}));
    await flush();

    const outBytes = new Uint8Array(320).fill(0xcd);
    session.push({
      type: 'assistant_audio.chunk',
      frame: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1, dataBase64: bytesToBase64(outBytes) }
    });

    // Wait for the second paceBytes call to be queued (meaning first frame sent).
    while ((pacer.paceBytes as any).mock.calls.length < 2) {
      await flush();
    }

    session.push({ type: 'playback.clear_requested', reason: 'barge_in', atMs: Date.now() });
    await flush();

    expect(ws.sent.map(s => JSON.parse(s)).some(m => m.event === 'clear')).toBe(true);

    // Unblock second frame pacing; it should be dropped due to generation change.
    resolveSecond?.();
    await flush();

    const sent = ws.sent.map(s => JSON.parse(s));
    const media = sent.filter(m => m.event === 'media');
    expect(media).toHaveLength(1);

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('auto-commits on user_speech.stopped after speech started', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false } }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({}));
    await flush();

    session.push({ type: 'user_speech.started' });
    session.push({ type: 'user_speech.stopped' });
    await flush();

    expect(session.commit).toHaveBeenCalledTimes(1);

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('firstTurnGraceMs delays first auto-commit within the grace window', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, firstTurnGraceMs: 50 } as any,
      audio: { pacing: { enabled: false } }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({}));
    await flush();

    session.push({ type: 'user_speech.started' } as any);
    session.push({ type: 'user_speech.stopped' } as any);
    await flush();

    expect(session.commit).toHaveBeenCalledTimes(0);

    await new Promise(resolve => setTimeout(resolve, 60));
    await flush();

    expect(session.commit).toHaveBeenCalledTimes(1);

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('firstTurnGraceMs suppresses early user_transcript.final when no speech has started', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const onRealtimeEvent = jest.fn();
    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, firstTurnGraceMs: 50 } as any,
      audio: { pacing: { enabled: false } },
      callbacks: { onRealtimeEvent }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({}));
    await flush();

    session.push({ type: 'user_transcript.final', text: 'bogus' } as any);
    await flush();

    const emittedBogus = onRealtimeEvent.mock.calls.some(([arg]) =>
      arg?.event?.type === 'user_transcript.final' && arg?.event?.text === 'bogus'
    );
    expect(emittedBogus).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 60));
    session.push({ type: 'user_transcript.final', text: 'ok' } as any);
    await flush();

    const emittedOk = onRealtimeEvent.mock.calls.some(([arg]) =>
      arg?.event?.type === 'user_transcript.final' && arg?.event?.text === 'ok'
    );
    expect(emittedOk).toBe(true);

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('firstTurnGraceMs does not suppress transcripts once speech has started', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    const session = new MockRealtimeSession();
    session.push({ type: 'ready', sessionId: 's1' });

    const onRealtimeEvent = jest.fn();
    const bridge = createTestMediaBridge({
      createSession: async () => session,
      security: { tokenSecret: secret },
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0, firstTurnGraceMs: 50 } as any,
      audio: { pacing: { enabled: false } },
      callbacks: { onRealtimeEvent }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, { url: `/ws?token=${encodeURIComponent(token)}` });
    ws.emitMessage(startMessage({}));
    await flush();

    session.push({ type: 'user_speech.started' } as any);
    session.push({ type: 'user_transcript.final', text: 'hello' } as any);
    await flush();

    const emitted = onRealtimeEvent.mock.calls.some(([arg]) =>
      arg?.event?.type === 'user_transcript.final' && arg?.event?.text === 'hello'
    );
    expect(emitted).toBe(true);

    ws.emitMessage(stopMessage({}));
    await task;
  });
});
