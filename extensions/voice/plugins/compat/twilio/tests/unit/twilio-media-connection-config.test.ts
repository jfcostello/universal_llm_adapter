import { resolveMediaConnectionConfig } from '../../internal/media/media-connection-config.ts';

describe('plugins/compat/twilio — media connection config', () => {
  test('accepts undefined callConfig', () => {
    const out = resolveMediaConnectionConfig({
      callConfig: undefined,
      providerDefaults: undefined,
      outboundBufferMaxFramesCap: 0
    });

    expect(out.callTimeoutMs).toBeUndefined();
    expect(out.silenceTimeoutMs).toBeUndefined();
    expect(out.assistantFirstTurnEnabled).toBe(false);
    expect(out.outboundBufferMaxFrames).toBeUndefined();
  });
});
