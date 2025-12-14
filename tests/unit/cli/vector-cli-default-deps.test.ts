import { jest } from '@jest/globals';

async function importVectorCliModule() {
  return import('@/modules/cli/index.ts');
}

describe('vector_store_coordinator default wiring', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    process.argv = [...originalArgv];
  });

  test('uses default dependencies for query command', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const executeMock = jest.fn().mockResolvedValue({ success: true, results: [] });
    const closeMock = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance),
      getDefaults: () => ({ timeouts: { loggerFlush: 0 } })
    }));

    (jest as any).unstable_mockModule('@/modules/vector/index.ts', () => ({
      VectorStoreCoordinator: jest.fn().mockImplementation(() => ({
        execute: executeMock,
        executeStream: jest.fn(),
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

    const { createVectorStoreCoordinatorProgram: createProgram } = await importVectorCliModule();
    const spec = JSON.stringify({ operation: 'query', store: 'test', input: { vector: [0.1], topK: 5 } });
    const program = createProgram();

    await program.parseAsync(['node', 'vector-store-coordinator', 'query', '--spec', spec, '--plugins', './plugins']);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    expect(registryInstance.loadAll).toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('uses default error function', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockRejectedValue(new Error('Registry error'))
    };

    (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance),
      getDefaults: () => ({ timeouts: { loggerFlush: 0 } })
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const { createVectorStoreCoordinatorProgram: createProgram } = await importVectorCliModule();
    const spec = JSON.stringify({ operation: 'query', store: 'test' });
    const program = createProgram();

    await program.parseAsync(['node', 'vector-store-coordinator', 'query', '--spec', spec]);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Registry error'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('runCli delegates to program.parseAsync', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const executeMock = jest.fn().mockResolvedValue({ success: true });
    const closeMock = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance),
      getDefaults: () => ({ timeouts: { loggerFlush: 0 } })
    }));

    (jest as any).unstable_mockModule('@/modules/vector/index.ts', () => ({
      VectorStoreCoordinator: jest.fn().mockImplementation(() => ({
        execute: executeMock,
        executeStream: jest.fn(),
        close: closeMock
      }))
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
      const callback = args.find((arg: any) => typeof arg === 'function');
      if (callback) setImmediate(callback);
      return true;
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const module = await importVectorCliModule();
    const spec = JSON.stringify({ operation: 'embed', store: 'test', embeddingPriority: [{ provider: 'openrouter' }] });

    await module.runVectorStoreCoordinatorCli(['node', 'vector-store-coordinator', 'embed', '--spec', spec]);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('uses default log function for streaming', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const executeStreamMock = jest.fn().mockImplementation(async function* () {
      yield { type: 'progress', progress: { current: 0, total: 1, message: 'test' } };
      yield { type: 'result', result: { success: true, embedded: 1 } };
      yield { type: 'done' };
    });
    const closeMock = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance),
      getDefaults: () => ({ timeouts: { loggerFlush: 0 } })
    }));

    (jest as any).unstable_mockModule('@/modules/vector/index.ts', () => ({
      VectorStoreCoordinator: jest.fn().mockImplementation(() => ({
        execute: jest.fn(),
        executeStream: executeStreamMock,
        close: closeMock
      }))
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const { createVectorStoreCoordinatorProgram: createProgram } = await importVectorCliModule();
    const spec = JSON.stringify({ operation: 'embed', store: 'test', embeddingPriority: [{ provider: 'test' }], input: { texts: ['hello'] } });
    const program = createProgram();

    await program.parseAsync(['node', 'vector-store-coordinator', 'embed', '--spec', spec, '--stream']);

    // Default log function is console.log which is called for each stream event
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('__isEntryPoint is exported', async () => {
    const module = await import('@/vector_store_coordinator.ts');
    expect(typeof module.__isEntryPoint).toBe('boolean');
  });

  test('__isEntryPoint is true when module is main entry point', async () => {
    jest.resetModules();

    // Mock dependencies to prevent actual execution
    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const closeMock = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance),
      getDefaults: () => ({ timeouts: { loggerFlush: 0 } })
    }));

    (jest as any).unstable_mockModule('@/modules/vector/index.ts', () => ({
      VectorStoreCoordinator: jest.fn().mockImplementation(() => ({
        execute: jest.fn().mockResolvedValue({ success: true }),
        executeStream: jest.fn(),
        close: closeMock
      }))
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
      const callback = args.find((arg: any) => typeof arg === 'function');
      if (callback) setImmediate(callback);
      return true;
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    const moduleUrl = new URL('../../../vector_store_coordinator.ts', import.meta.url);
    const modulePath = decodeURIComponent(moduleUrl.pathname);
    process.argv = ['node', modulePath];

    const module = await import('@/vector_store_coordinator.ts');
    expect(module.__isEntryPoint).toBe(true);
  });

  test('runCli uses process.argv when called without arguments', async () => {
    jest.resetModules();

    const registryInstance = {
      loadAll: jest.fn().mockResolvedValue(undefined)
    };

    const executeMock = jest.fn().mockResolvedValue({ success: true, embedded: 0 });
    const closeMock = jest.fn().mockResolvedValue(undefined);

    (jest as any).unstable_mockModule('@/modules/kernel/index.ts', () => ({
      PluginRegistry: jest.fn().mockImplementation(() => registryInstance),
      getDefaults: () => ({ timeouts: { loggerFlush: 0 } })
    }));

    (jest as any).unstable_mockModule('@/modules/vector/index.ts', () => ({
      VectorStoreCoordinator: jest.fn().mockImplementation(() => ({
        execute: executeMock,
        executeStream: jest.fn(),
        close: closeMock
      }))
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
      const callback = args.find((arg: any) => typeof arg === 'function');
      if (callback) setImmediate(callback);
      return true;
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => undefined) as any);

    // Set process.argv to simulate CLI invocation
    const spec = JSON.stringify({ operation: 'embed', store: 'test', embeddingPriority: [{ provider: 'test' }] });
    process.argv = ['node', 'vector-store-coordinator', 'embed', '--spec', spec];

    // Call runCli without arguments - it should use process.argv
    const { runVectorStoreCoordinatorCli } = await importVectorCliModule();
    await runVectorStoreCoordinatorCli();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
