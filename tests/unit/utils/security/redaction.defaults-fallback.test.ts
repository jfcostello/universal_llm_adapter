import { describe, expect, jest, test } from '@jest/globals';

describe('utils/security/redaction (defaults fallback)', () => {
  test('falls back to built-in sensitive keys when defaults config is empty', async () => {
    const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule })
      .unstable_mockModule;
    if (!unstableMockModule) {
      throw new Error('jest.unstable_mockModule is not available in this environment');
    }

    jest.resetModules();

    const { BUILT_IN_SENSITIVE_KEY_PATTERNS } = await import('@/kernel/internal/defaults.ts');

    await unstableMockModule('../../../../kernel/index.js', () => ({
      __esModule: true,
      BUILT_IN_SENSITIVE_KEY_PATTERNS,
      getDefaults: () => ({
        security: { redaction: { sensitiveKeys: [] } }
      })
    }));

    const security = await import('@/modules/security/index.ts');

    expect(security.redactUrlQueryCredentials('https://api.example.com?key=abcd1234')).toBe(
      'https://api.example.com/?key=***1234'
    );
  });

  test('falls back to built-in sensitive keys when defaults is not an object', async () => {
    const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule })
      .unstable_mockModule;
    if (!unstableMockModule) {
      throw new Error('jest.unstable_mockModule is not available in this environment');
    }

    jest.resetModules();

    const { BUILT_IN_SENSITIVE_KEY_PATTERNS } = await import('@/kernel/internal/defaults.ts');

    await unstableMockModule('../../../../kernel/index.js', () => ({
      __esModule: true,
      BUILT_IN_SENSITIVE_KEY_PATTERNS,
      getDefaults: () => null
    }));

    const security = await import('@/modules/security/index.ts');

    expect(security.redactUrlQueryCredentials('https://api.example.com?key=abcd1234')).toBe(
      'https://api.example.com/?key=***1234'
    );
  });

  test('falls back to built-in sensitive keys when defaults.security.redaction is not an object', async () => {
    const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule })
      .unstable_mockModule;
    if (!unstableMockModule) {
      throw new Error('jest.unstable_mockModule is not available in this environment');
    }

    jest.resetModules();

    const { BUILT_IN_SENSITIVE_KEY_PATTERNS } = await import('@/kernel/internal/defaults.ts');

    await unstableMockModule('../../../../kernel/index.js', () => ({
      __esModule: true,
      BUILT_IN_SENSITIVE_KEY_PATTERNS,
      getDefaults: () => ({
        security: { redaction: null }
      })
    }));

    const security = await import('@/modules/security/index.ts');

    expect(security.redactUrlQueryCredentials('https://api.example.com?key=abcd1234')).toBe(
      'https://api.example.com/?key=***1234'
    );
  });

  test('always includes built-in sensitive keys even when defaults provides a non-empty subset', async () => {
    const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule })
      .unstable_mockModule;
    if (!unstableMockModule) {
      throw new Error('jest.unstable_mockModule is not available in this environment');
    }

    jest.resetModules();

    const { BUILT_IN_SENSITIVE_KEY_PATTERNS } = await import('@/kernel/internal/defaults.ts');

    await unstableMockModule('../../../../kernel/index.js', () => ({
      __esModule: true,
      BUILT_IN_SENSITIVE_KEY_PATTERNS,
      getDefaults: () => ({
        security: { redaction: { sensitiveKeys: ['authorization'] } }
      })
    }));

    const security = await import('@/modules/security/index.ts');

    // `key` is part of the built-in fallback list and must still be redacted even if defaults provides a subset list.
    expect(security.redactUrlQueryCredentials('https://api.example.com?key=abcd1234')).toBe(
      'https://api.example.com/?key=***1234'
    );
  });
});
