import { jest } from '@jest/globals';

describe('core/defaults loading fallback', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('uses fallback when no JSON file exists (via module reimport with mocked fs)', async () => {
    jest.resetModules();

    const originalFs = await import('fs');

    // Mock fs.existsSync to always return false for defaults.json.
    const fsMock: any = {
      __esModule: true,
      existsSync: jest.fn((filePath: string) => {
        if (filePath.includes('defaults.json')) {
          return false;
        }
        return originalFs.existsSync(filePath);
      }),
      readFileSync: originalFs.readFileSync
    };
    fsMock.default = fsMock;

    (jest as any).unstable_mockModule('fs', () => fsMock);

    const { getDefaults } = await import('@/kernel/index.ts');
    const defaults = getDefaults();

    // Should use fallback defaults (same values, but via fallback path).
    expect(defaults.retry.maxAttempts).toBe(3);
    expect(defaults.tools.countdownEnabled).toBe(true);
    expect(defaults.vector.topK).toBe(5);

    jest.resetModules();
  });

  test('uses fallback when JSON file is invalid (via module reimport with mocked fs)', async () => {
    jest.resetModules();

    const originalFs = await import('fs');

    // Mock fs to return true for defaults.json, but invalid JSON content.
    const fsMock: any = {
      __esModule: true,
      existsSync: jest.fn((filePath: string) => {
        if (filePath.includes('defaults.json')) {
          return true;
        }
        return originalFs.existsSync(filePath);
      }),
      readFileSync: jest.fn((filePath: string) => {
        if (filePath.includes('defaults.json')) {
          return '{ invalid json }';
        }
        return originalFs.readFileSync(filePath);
      })
    };
    fsMock.default = fsMock;

    (jest as any).unstable_mockModule('fs', () => fsMock);

    const { getDefaults } = await import('@/kernel/index.ts');
    const defaults = getDefaults();

    // Should use fallback defaults due to parse error.
    expect(defaults.retry.maxAttempts).toBe(3);
    expect(defaults.tools.countdownEnabled).toBe(true);

    jest.resetModules();
  });
});
