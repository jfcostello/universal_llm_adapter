import { jest } from '@jest/globals';

import { bytesToBase64 } from '@/modules/audio/index.ts';
import { MockRealtimeSession } from '@tests/helpers/mock-realtime-session.ts';
import { MockWebSocket } from '@tests/helpers/mock-ws.ts';

import { createTestMediaBridge, mediaMessage, startMessage, stopMessage } from '../helpers/test-media-protocol.ts';

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('extensions/voice/modules/media-bridge: inbound audio', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('forwards inbound audio without conversion when session input matches', async () => {
    const session = new MockRealtimeSession();
    session.push({
      type: 'ready',
      sessionId: 's1',
      audio: {
        input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
        output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
      }
    } as any);

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false } }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, {});

    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    const inboundBytes = new Uint8Array(160).fill(0xff);
    const payloadBase64 = bytesToBase64(inboundBytes);
    ws.emitMessage(mediaMessage({ payloadBase64 }));
    await flush();

    expect(session.sendAudio).toHaveBeenCalledTimes(1);
    const sentFrame = (session.sendAudio as any).mock.calls[0][0];
    expect(sentFrame.format).toBe('g711_ulaw');
    expect(sentFrame.sampleRateHz).toBe(8000);
    expect(sentFrame.channels).toBe(1);
    expect(sentFrame.dataBase64).toBe(payloadBase64);

    ws.emitMessage(stopMessage({}));
    await task;
  });

  test('converts inbound audio when session input differs', async () => {
    const session = new MockRealtimeSession();
    session.push({
      type: 'ready',
      sessionId: 's1',
      audio: {
        input: { format: 'pcm16', sampleRateHz: 8000, channels: 1 },
        output: { format: 'pcm16', sampleRateHz: 8000, channels: 1 }
      }
    } as any);

    const bridge = createTestMediaBridge({
      createSession: async () => session,
      limits: { startTimeoutMs: 0, idleTimeoutMs: 0, maxSessionDurationMs: 0 },
      audio: { pacing: { enabled: false } }
    });

    const ws = new MockWebSocket();
    const task = bridge.handleConnection(ws as any, {});

    ws.emitMessage(startMessage({ customParameters: { from: 'x', to: 'y' } }));
    await flush();

    const inboundBytes = new Uint8Array(160).fill(0xff);
    const payloadBase64 = bytesToBase64(inboundBytes);
    ws.emitMessage(mediaMessage({ payloadBase64 }));
    await flush();

    expect(session.sendAudio).toHaveBeenCalledTimes(1);
    const sentFrame = (session.sendAudio as any).mock.calls[0][0];
    expect(sentFrame.format).toBe('pcm16');

    ws.emitMessage(stopMessage({}));
    await task;
  });
});

