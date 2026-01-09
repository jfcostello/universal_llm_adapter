import http from 'http';
import { jest } from '@jest/globals';

describe('plugins/voice-compat/twilio — outbound buffer wiring', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
  const prevCap = process.env.LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    else process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;

    if (prevCap === undefined) delete process.env.LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP;
    else process.env.LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP = prevCap;

    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('uses provider defaults and allows per-call override', async () => {
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

      await compat.handleMediaConnection({
        ws: {},
        req: new http.IncomingMessage(null as any),
        callConfigId: 'cfg_1',
        callConfig: { realtimeSpec: {} },
        voiceProvider: 'twilio',
        registry: {},
        providerDefaults: { mediaStreams: { outboundBufferMaxFrames: 123 } }
      });

      expect(captured?.limits?.maxPendingOutboundFrames).toBe(123);

      captured = undefined;
      await compat.handleMediaConnection({
        ws: {},
        req: new http.IncomingMessage(null as any),
        callConfigId: 'cfg_2',
        callConfig: { realtimeSpec: {}, providerConfig: { mediaStreams: { outboundBufferMaxFrames: 456 } } },
        voiceProvider: 'twilio',
        registry: {},
        providerDefaults: { mediaStreams: { outboundBufferMaxFrames: 123 } }
      });

      expect(captured?.limits?.maxPendingOutboundFrames).toBe(456);
    });
  });

  test('rejects invalid per-call outboundBufferMaxFrames override', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: () => ({ handleConnection: async () => {} })
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      await expect(
        compat.handleMediaConnection({
          ws: {},
          req: new http.IncomingMessage(null as any),
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: {}, providerConfig: { mediaStreams: { outboundBufferMaxFrames: -1 } } },
          voiceProvider: 'twilio',
          registry: {},
          providerDefaults: {}
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
    });
  });

  test('rejects per-call outboundBufferMaxFrames override above cap', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP = '10';

    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: () => ({ handleConnection: async () => {} })
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      await expect(
        compat.handleMediaConnection({
          ws: {},
          req: new http.IncomingMessage(null as any),
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: {}, providerConfig: { mediaStreams: { outboundBufferMaxFrames: 11 } } },
          voiceProvider: 'twilio',
          registry: {},
          providerDefaults: {}
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
    });
  });

  test('rejects provider default outboundBufferMaxFrames above cap', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP = '10';

    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: () => ({ handleConnection: async () => {} })
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      await expect(
        compat.handleMediaConnection({
          ws: {},
          req: new http.IncomingMessage(null as any),
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: {} },
          voiceProvider: 'twilio',
          registry: {},
          providerDefaults: { mediaStreams: { outboundBufferMaxFrames: 11 } }
        })
      ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
    });
  });

  test('rejects per-call providerConfig.mediaStreams when it is not an object', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: () => ({ handleConnection: async () => {} })
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      await expect(
        compat.handleMediaConnection({
          ws: {},
          req: new http.IncomingMessage(null as any),
          callConfigId: 'cfg_1',
          // @ts-expect-error
          callConfig: { realtimeSpec: {}, providerConfig: { mediaStreams: 'nope' } },
          voiceProvider: 'twilio',
          registry: {},
          providerDefaults: {}
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'validation_error' });
    });
  });

  test('rejects defaults.mediaStreams when it is not an object', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: () => ({ handleConnection: async () => {} })
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      await expect(
        compat.handleMediaConnection({
          ws: {},
          req: new http.IncomingMessage(null as any),
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: {} },
          voiceProvider: 'twilio',
          registry: {},
          // @ts-expect-error
          providerDefaults: { mediaStreams: 'nope' }
        })
      ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
    });
  });

  test('rejects invalid LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';
    process.env.LLM_ADAPTER_TWILIO_MEDIA_STREAMS_OUTBOUND_BUFFER_MAX_FRAMES_CAP = 'nope';

    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: () => ({ handleConnection: async () => {} })
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      await expect(
        compat.handleMediaConnection({
          ws: {},
          req: new http.IncomingMessage(null as any),
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: {} },
          voiceProvider: 'twilio',
          registry: {},
          providerDefaults: {}
        })
      ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
    });
  });

  test('rejects provider default outboundBufferMaxFrames when it is invalid (<= 0)', async () => {
    process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = 'secret';

    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('../../../../voice-modules/twilio-media-streams/index.js', () => ({
        createTwilioMediaStreamsBridge: () => ({ handleConnection: async () => {} })
      }));

      const TwilioVoiceCompat = (await import('../../index.ts')).default;
      const compat = new TwilioVoiceCompat();

      await expect(
        compat.handleMediaConnection({
          ws: {},
          req: new http.IncomingMessage(null as any),
          callConfigId: 'cfg_1',
          callConfig: { realtimeSpec: {} },
          voiceProvider: 'twilio',
          registry: {},
          providerDefaults: { mediaStreams: { outboundBufferMaxFrames: 0 } }
        })
      ).rejects.toMatchObject({ statusCode: 500, code: 'provider_config_error' });
    });
  });
});
