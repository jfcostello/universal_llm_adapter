import path from 'path';
import { pathToFileURL } from 'url';
import { jest } from '@jest/globals';

async function importCoordinatorModule() {
  return import('@/llm_coordinator.ts');
}

describe('llm_coordinator default wiring', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    process.argv = [...originalArgv];
  });

  test('run command uses default dependencies', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const runMock = jest.fn().mockResolvedValue({ ok: true });
    const closeMock = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('@/core/registry.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance)
    }));

    (jest as any).unstable_mockModule('@/coordinator/coordinator.ts', () => ({
      LLMCoordinator: jest.fn().mockImplementation(() => ({
        run: runMock,
        runStream: jest.fn(),
        close: closeMock
      }))
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
      const callback = args.find((arg: any) => typeof arg === 'function');
      if (callback) setImmediate(callback);
      return true;
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const { createProgram } = await importCoordinatorModule();
    const spec = JSON.stringify({ messages: [], llmPriority: [], settings: {} });
    const program = createProgram();

    await program.parseAsync(['node', 'llm-coordinator', 'run', '--spec', spec, '--plugins', './plugins']);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    expect(registryInstance.loadAll).toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledWith(expect.any(Object));
    expect(closeMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('stream command surfaces errors via default logger', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    (jest as any).unstable_mockModule('@/core/registry.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance)
    }));

    (jest as any).unstable_mockModule('@/coordinator/coordinator.ts', () => ({
      LLMCoordinator: jest.fn().mockImplementation(() => ({
        run: jest.fn(),
        runStream: jest.fn().mockImplementation(async function* () {
          throw new Error('stream-fail');
        }),
        close: jest.fn().mockResolvedValue(undefined)
      }))
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const { createProgram } = await importCoordinatorModule();
    const spec = JSON.stringify({ messages: [], llmPriority: [], settings: {} });
    const program = createProgram();

    await program.parseAsync(['node', 'llm-coordinator', 'stream', '--spec', spec]);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stream-fail'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('stream command uses default log function', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const closeMock = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('@/core/registry.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance)
    }));

    (jest as any).unstable_mockModule('@/coordinator/coordinator.ts', () => ({
      LLMCoordinator: jest.fn().mockImplementation(() => ({
        run: jest.fn(),
        runStream: jest.fn().mockImplementation(async function* () {
          yield { type: 'test', data: 'hello' };
        }),
        close: closeMock
      }))
    }));

    // This will allow the default log function (line 33) to be called
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const { createProgram } = await importCoordinatorModule();
    const spec = JSON.stringify({ messages: [], llmPriority: [], settings: {} });

    // Create program with NO deps - this uses defaults, and stream command calls deps.log()
    const program = createProgram();

    await program.parseAsync(['node', 'llm-coordinator', 'stream', '--spec', spec]);

    // The default log function should have been called, which calls console.log (line 33)
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('runCli delegates to program.parseAsync', async () => {
    jest.resetModules();

    const parseSpy = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('commander', () => {
      class MockCommand {
        name() { return this; }
        description() { return this; }
        version() { return this; }
        command() { return this; }
        option() { return this; }
        action() { return this; }
        parseAsync(argv: string[]) {
          parseSpy(argv);
          return Promise.resolve();
        }
      }
      return { Command: MockCommand };
    });

    const module = await importCoordinatorModule();
    await module.runCli(['node', 'llm-coordinator', '--version']);

    expect(parseSpy).toHaveBeenCalledWith(['node', 'llm-coordinator', '--version']);
  });

  test('auto-run bootstrap triggers when invoked directly', async () => {
    jest.resetModules();

    const registryInstance = { loadAll: jest.fn().mockResolvedValue(undefined) };
    (jest as any).unstable_mockModule('@/core/registry.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance)
    }));

    (jest as any).unstable_mockModule('@/coordinator/coordinator.ts', () => ({
      LLMCoordinator: jest.fn().mockImplementation(() => ({
        run: jest.fn().mockResolvedValue({}),
        runStream: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined)
      }))
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const moduleUrl = new URL('../../../llm_coordinator.ts', import.meta.url);
    const modulePath = decodeURIComponent(moduleUrl.pathname);
    process.argv = ['node', modulePath];

    const module = await import('@/llm_coordinator.ts');
    expect(module.__isEntryPoint).toBe(true);
  });

});
