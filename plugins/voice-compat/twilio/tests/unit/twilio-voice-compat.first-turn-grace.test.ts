import http from 'http';
import { jest } from '@jest/globals';

describe('plugins/voice-compat/twilio — firstTurnGraceMs wiring', () => {
  const prevSecret = process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET;
    else process.env.LLM_ADAPTER_VOICE_WS_TOKEN_SECRET = prevSecret;
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('does not default grace and allows explicit override (including 0)', async () => {
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
        callConfig: { realtimeSpec: { provider: 'grok' } },
        voiceProvider: 'twilio',
        registry: {},
        providerDefaults: {}
      });

      expect(captured?.limits?.firstTurnGraceMs).toBeUndefined();

      captured = undefined;
      await compat.handleMediaConnection({
        ws: {},
        req: new http.IncomingMessage(null as any),
        callConfigId: 'cfg_2',
        callConfig: { realtimeSpec: { provider: 'grok' }, timeouts: { firstTurnGraceMs: 0 } },
        voiceProvider: 'twilio',
        registry: {},
        providerDefaults: {}
      });

      expect(captured?.limits?.firstTurnGraceMs).toBe(0);

      captured = undefined;
      await compat.handleMediaConnection({
        ws: {},
        req: new http.IncomingMessage(null as any),
        callConfigId: 'cfg_3',
        callConfig: { realtimeSpec: { provider: 'openai' } },
        voiceProvider: 'twilio',
        registry: {},
        providerDefaults: {}
      });

      expect(captured?.limits?.firstTurnGraceMs).toBeUndefined();
    });
  });
});
