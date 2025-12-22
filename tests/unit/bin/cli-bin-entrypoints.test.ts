import { jest } from '@jest/globals';

describe('bin/* entrypoints', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    process.argv = [...originalArgv];
  });

  describe('bin/cli (unified)', () => {
    test('bin/cli exports __isEntryPoint', async () => {
      const module = await import('@/bin/cli.ts');
      expect(typeof module.__isEntryPoint).toBe('boolean');
    });

    test('bin/cli exports runUnifiedCli', async () => {
      const module = await import('@/bin/cli.ts');
      expect(typeof module.runUnifiedCli).toBe('function');
    });

    test('bin/cli auto-runs when invoked directly', async () => {
      jest.resetModules();

      const moduleUrl = new URL('../../../bin/cli.ts', import.meta.url);
      const modulePath = decodeURIComponent(moduleUrl.pathname);
      process.argv = ['node', modulePath];

      await jest.isolateModulesAsync(async () => {
        // Avoid running the real CLI in this unit test (it calls process.exit by design).
        (jest as any).unstable_mockModule('@/index.ts', () => ({
          runUnifiedCli: async () => {}
        }));

        const module = await import('@/bin/cli.ts');
        expect(module.__isEntryPoint).toBe(true);
      });
    });

    test('bin/cli __isEntryPoint is false when not invoked directly', async () => {
      jest.resetModules();

      // Set argv to something other than the module path
      process.argv = ['node', '/some/other/path.js'];

      const module = await import('@/bin/cli.ts');
      expect(module.__isEntryPoint).toBe(false);
    });
  });

});
