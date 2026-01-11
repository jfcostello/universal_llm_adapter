import { jest } from '@jest/globals';

describe('extensions/voice: internal logging', () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('getVoiceLogger caches base instance, supports correlation, and can be closed', async () => {
    const mod = await import('../../internal/logging.js');

    // Covers the "no-op when unopened" close path.
    await mod.closeVoiceLogger();

    const base = mod.getVoiceLogger();
    expect((base as any).getTargetDir()).toBe(mod.voiceLogDir);
    expect((base as any).getFilenamePrefix()).toBe('voice');
    expect((base as any).getMaxFiles()).toBe(mod.VOICE_MAX_FILES);
    expect((base as any).getMaxAgeDays()).toBe(mod.VOICE_MAX_AGE_DAYS);
    expect((base as any).getMaxBytes()).toBeUndefined();

    const correlated = mod.getVoiceLogger('corr-1');
    expect(correlated).not.toBe(base);

    const baseAgain = mod.getVoiceLogger();
    expect(baseAgain).toBe(base);

    await mod.closeVoiceLogger();
    const reopened = mod.getVoiceLogger();
    expect(reopened).not.toBe(base);
    await mod.closeVoiceLogger();
  });

  test('enables max-bytes rotation when LLM_ADAPTER_VOICE_LOG_MAX_BYTES is set', async () => {
    process.env.LLM_ADAPTER_VOICE_LOG_MAX_BYTES = '1';
    jest.resetModules();

    const mod = await import('../../internal/logging.js');
    const logger = mod.getVoiceLogger();
    expect((logger as any).getMaxBytes()).toBe(1);
    await mod.closeVoiceLogger();
  });
});

