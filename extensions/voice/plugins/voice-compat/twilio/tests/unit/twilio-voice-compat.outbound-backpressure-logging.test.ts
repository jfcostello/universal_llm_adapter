import http from 'http';
import { jest } from '@jest/globals';

describe('plugins/voice-compat/twilio — outbound_backpressure logging', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    else process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('throttles outbound_backpressure logs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    await jest.isolateModulesAsync(async () => {
      let captured: any;

      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: (options: any) => {
          captured = options;
          return { handleConnection: async () => {} };
        }
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      const logger = { warning: jest.fn(), error: jest.fn() };

      await compat.handleMediaConnection({
        ws: {},
        req: new http.IncomingMessage(null as any),
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: {} },
        voiceProvider: 'twilio',
        registry: {},
        providerDefaults: {},
        logger
      });

      expect(typeof captured?.callbacks?.onError).toBe('function');

      captured.callbacks.onError({
        message: 'Outbound backpressure',
        code: 'outbound_backpressure',
        metadata: { streamSid: 'stream_1', callSid: 'call_1' }
      });
      captured.callbacks.onError({ message: 'Outbound backpressure', code: 'outbound_backpressure' });
      expect(logger.warning).toHaveBeenCalledTimes(1);
      expect(logger.warning).toHaveBeenCalledWith(
        'voice.media.outbound_backpressure',
        expect.objectContaining({
          providerStreamId: 'stream_1',
          providerCallId: 'call_1',
          code: 'outbound_backpressure'
        })
      );

      jest.setSystemTime(new Date('2025-01-01T00:00:10.000Z'));
      captured.callbacks.onError({ message: 'Outbound backpressure', code: 'outbound_backpressure' });
      expect(logger.warning).toHaveBeenCalledTimes(2);

      // Cover the code === undefined branch.
      captured.callbacks.onError({ message: 'Boom', code: undefined });
      expect(logger.error).toHaveBeenCalledWith(
        'voice.media.bridge_error',
        expect.objectContaining({
          code: '',
          message: 'Boom'
        })
      );
    });
  });
});
