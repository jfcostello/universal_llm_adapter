import { describe, expect, jest, test } from '@jest/globals';

describe('utils/security/redaction (defaults fallback)', () => {
  test('falls back to built-in sensitive keys when defaults config is empty', async () => {
    const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule })
      .unstable_mockModule;
    if (!unstableMockModule) {
      throw new Error('jest.unstable_mockModule is not available in this environment');
    }

    jest.resetModules();

    await unstableMockModule('../../../../kernel/index.js', () => ({
      __esModule: true,
      getDefaults: () => ({
        security: { redaction: { sensitiveKeys: [] } }
      })
    }));

    const security = await import('@/modules/security/index.ts');

    expect(security.redactUrlQueryCredentials('https://api.example.com?key=abcd1234')).toBe(
      'https://api.example.com/?key=***1234'
    );
  });
});
