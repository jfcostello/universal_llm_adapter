import { jest } from '@jest/globals';

describe('bin/* entrypoints', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    process.argv = [...originalArgv];
  });

  test('bin/llm-coordinator exports __isEntryPoint', async () => {
    const module = await import('@/bin/llm-coordinator/index.ts');
    expect(typeof module.__isEntryPoint).toBe('boolean');
  });

  test('bin/llm-coordinator auto-runs when invoked directly', async () => {
    jest.resetModules();

    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    const moduleUrl = new URL('../../../bin/llm-coordinator/index.ts', import.meta.url);
    const modulePath = decodeURIComponent(moduleUrl.pathname);
    process.argv = ['node', modulePath];

    const module = await import('@/bin/llm-coordinator/index.ts');
    expect(module.__isEntryPoint).toBe(true);
  });

  test('bin/vector-coordinator exports __isEntryPoint', async () => {
    const module = await import('@/bin/vector-coordinator/index.ts');
    expect(typeof module.__isEntryPoint).toBe('boolean');
  });

  test('bin/vector-coordinator auto-runs when invoked directly', async () => {
    jest.resetModules();

    jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    const moduleUrl = new URL('../../../bin/vector-coordinator/index.ts', import.meta.url);
    const modulePath = decodeURIComponent(moduleUrl.pathname);
    process.argv = ['node', modulePath];

    const module = await import('@/bin/vector-coordinator/index.ts');
    expect(module.__isEntryPoint).toBe(true);
  });
});
