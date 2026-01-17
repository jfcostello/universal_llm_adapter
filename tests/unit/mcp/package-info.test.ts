import { describe, expect, jest, test } from '@jest/globals';

describe('mcp/internal/client/internal/package-info', () => {
  test('readPackageInfo returns fallback when package.json read fails', async () => {
    jest.resetModules();

    const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
    if (!unstableMockModule) {
      throw new Error('jest.unstable_mockModule is required for this test suite');
    }

    unstableMockModule('fs', () => ({
      readFileSync: () => {
        throw new Error('boom');
      }
    }));

    const mod = await import('@/modules/mcp/internal/client/internal/package-info.ts');

    expect(mod.PACKAGE_INFO).toEqual({ name: 'llm-adapter', version: '1.0.0' });
    expect(mod.readPackageInfo({ fallback: { name: 'x', version: 'y' } })).toEqual({ name: 'x', version: 'y' });
  });
});
