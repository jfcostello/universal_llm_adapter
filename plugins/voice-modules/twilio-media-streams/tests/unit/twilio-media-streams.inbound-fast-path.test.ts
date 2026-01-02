import { jest } from '@jest/globals';

import { bytesToBase64 } from '@/modules/audio/index.ts';
import { createSignedWsToken } from '@/modules/security/index.ts';
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
  const streamSid = options.streamSid ?? 'MZ123';
  return JSON.stringify({
    event: 'start',
    streamSid,
    start: {
      streamSid,
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

function mediaMessage(options: { streamSid?: string; payloadBase64: string }) {
  return JSON.stringify({
    event: 'media',
    streamSid: options.streamSid ?? 'MZ123',
    media: { payload: options.payloadBase64 }
  });
}

function stopMessage(options: { streamSid?: string }) {
  return JSON.stringify({
    event: 'stop',
    streamSid: options.streamSid ?? 'MZ123'
  });
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('plugins/voice-modules/twilio-media-streams — inbound fast-path', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('does not invoke convertAudioBytes when negotiated session input is g711_ulaw@8k mono', async () => {
    const secret = 'secret';
    const token = makeToken(secret);

    await jest.isolateModulesAsync(async () => {
      const convertAudioBytes = jest.fn(() => {
        throw new Error('convertAudioBytes should not be called');
      });
      const frameAudioBytes = jest.fn(() => []);

      jest.unstable_mockModule('../../internal/audio.js', () => ({
        convertAudioBytes,
        frameAudioBytes
      }));

      const { createTwilioMediaStreamsBridge } = await import('@/plugins/voice-modules/twilio-media-streams/index.ts');

      const session = new MockRealtimeSession();
      session.push({
        type: 'ready',
        sessionId: 's1',
        audio: {
          input: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 },
          output: { format: 'g711_ulaw', sampleRateHz: 8000, channels: 1 }
        }
      } as any);

      const bridge = createTwilioMediaStreamsBridge({
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
      const payloadBase64 = bytesToBase64(inboundBytes);
      ws.emitMessage(mediaMessage({ payloadBase64 }));
      await flush();

      expect(session.sendAudio).toHaveBeenCalledTimes(1);
      const sentFrame = (session.sendAudio as any).mock.calls[0][0];
      expect(sentFrame.format).toBe('g711_ulaw');
      expect(sentFrame.sampleRateHz).toBe(8000);
      expect(sentFrame.channels).toBe(1);
      expect(sentFrame.dataBase64).toBe(payloadBase64);

      expect(convertAudioBytes).not.toHaveBeenCalled();

      ws.emitMessage(stopMessage({}));
      await task;
    });
  });
});

