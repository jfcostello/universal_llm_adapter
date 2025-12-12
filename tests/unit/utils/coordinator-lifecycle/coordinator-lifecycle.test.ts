import { jest } from '@jest/globals';
import type { PluginRegistryLike } from '@/utils/coordinator-lifecycle/index.ts';
import {
  runWithCoordinatorLifecycle,
  streamWithCoordinatorLifecycle
} from '@/utils/coordinator-lifecycle/index.ts';

interface FakeSpec {
  foo: string;
}

function createDeps(overrides: Partial<any> = {}) {
  const registry: PluginRegistryLike = {
    loadAll: jest.fn().mockResolvedValue(undefined)
  };

  const coordinator = {
    close: jest.fn().mockResolvedValue(undefined)
  };

  const closeLogger = jest.fn().mockResolvedValue(undefined);

  const deps = {
    createRegistry: jest.fn().mockResolvedValue(registry),
    createCoordinator: jest.fn().mockResolvedValue(coordinator),
    closeLogger,
    ...overrides
  };

  return { deps, registry, coordinator, closeLogger };
}

describe('utils/coordinator-lifecycle runWithCoordinatorLifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.LLM_ADAPTER_BATCH_ID;
  });

  test('creates registry and coordinator per call and cleans up', async () => {
    const { deps, registry, coordinator, closeLogger } = createDeps();

    const result = await runWithCoordinatorLifecycle<FakeSpec, any, any, { ok: boolean }>({
      spec: { foo: 'bar' },
      pluginsPath: './plugins',
      batchId: 'batch-1',
      closeLoggerAfter: true,
      deps,
      run: async () => ({ ok: true })
    });

    expect(result).toEqual({ ok: true });
    expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('batch-1');
    expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
    expect(registry.loadAll).toHaveBeenCalled();
    expect(deps.createCoordinator).toHaveBeenCalledWith(registry);
    expect(coordinator.close).toHaveBeenCalled();
    expect(closeLogger).toHaveBeenCalled();
  });

  test('uses provided registry and skips createRegistry', async () => {
    const { deps, registry } = createDeps();

    await runWithCoordinatorLifecycle<FakeSpec, any, any, string>({
      spec: { foo: 'x' },
      registry,
      deps,
      run: async () => 'ok'
    });

    expect(deps.createRegistry).not.toHaveBeenCalled();
    expect(deps.createCoordinator).toHaveBeenCalledWith(registry);
  });

  test('ensures cleanup on run error without masking primary error', async () => {
    const closeSpy = jest.fn().mockRejectedValue(new Error('close failed'));
    const { deps, closeLogger } = createDeps({
      createCoordinator: jest.fn().mockResolvedValue({ close: closeSpy })
    });

    await expect(
      runWithCoordinatorLifecycle<FakeSpec, any, any, never>({
        spec: { foo: 'boom' },
        deps,
        closeLoggerAfter: true,
        run: async () => {
          throw new Error('primary failure');
        }
      })
    ).rejects.toThrow('primary failure');

    expect(closeSpy).toHaveBeenCalled();
    expect(closeLogger).toHaveBeenCalled();
  });

  test('skips closeLogger when closeLoggerAfter=false and loadAll missing', async () => {
    const registry = {} as any;
    const closeLogger = jest.fn().mockResolvedValue(undefined);
    const closeSpy = jest.fn().mockResolvedValue(undefined);
    const deps = {
      createRegistry: jest.fn().mockResolvedValue(registry),
      createCoordinator: jest.fn().mockResolvedValue({ close: closeSpy }),
      closeLogger
    };

    const result = await runWithCoordinatorLifecycle<FakeSpec, any, any, string>({
      spec: { foo: 'bar' },
      deps,
      closeLoggerAfter: false,
      run: async () => 'ok'
    });

    expect(result).toBe('ok');
    expect(closeSpy).toHaveBeenCalled();
    expect(closeLogger).not.toHaveBeenCalled();
  });

  test('surfaces closeLogger error when no primary/cleanup error', async () => {
    const { deps } = createDeps({
      closeLogger: jest.fn().mockRejectedValue(new Error('logger failed'))
    });

    await expect(
      runWithCoordinatorLifecycle<FakeSpec, any, any, string>({
        spec: { foo: 'bar' },
        deps,
        run: async () => 'ok'
      })
    ).rejects.toThrow('logger failed');
  });

  test('does not override close error with closeLogger error', async () => {
    const closeSpy = jest.fn().mockRejectedValue(new Error('close failed'));
    const deps = {
      createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
      createCoordinator: jest.fn().mockResolvedValue({ close: closeSpy }),
      closeLogger: jest.fn().mockRejectedValue(new Error('logger failed'))
    };

    await expect(
      runWithCoordinatorLifecycle<FakeSpec, any, any, string>({
        spec: { foo: 'bar' },
        deps,
        run: async () => 'ok'
      })
    ).rejects.toThrow('close failed');
  });

  test('falls back to default createRegistry and closeLogger', async () => {
    const createCoordinator = jest.fn().mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) });
    const result = await runWithCoordinatorLifecycle<FakeSpec, any, any, string>({
      spec: { foo: 'bar' },
      pluginsPath: './plugins',
      deps: { createCoordinator },
      run: async () => 'ok'
    });

    expect(result).toBe('ok');
    expect(createCoordinator).toHaveBeenCalled();
  });
});

describe('utils/coordinator-lifecycle streamWithCoordinatorLifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.LLM_ADAPTER_BATCH_ID;
  });

  test('streams events and cleans up after completion', async () => {
    const { deps, coordinator, closeLogger } = createDeps();

    async function* fakeStream() {
      yield { type: 'first' };
      yield { type: 'second' };
    }

    const events: any[] = [];
    for await (const ev of streamWithCoordinatorLifecycle<FakeSpec, any, any, any>({
      spec: { foo: 'bar' },
      deps,
      closeLoggerAfter: true,
      stream: async function* () {
        yield* fakeStream();
      }
    })) {
      events.push(ev);
    }

    expect(events).toEqual([{ type: 'first' }, { type: 'second' }]);
    expect(coordinator.close).toHaveBeenCalled();
    expect(closeLogger).toHaveBeenCalled();
  });

  test('ensures cleanup on stream error and rethrows primary error', async () => {
    const { deps, coordinator, closeLogger } = createDeps();

    async function* badStream() {
      yield { type: 'first' };
      throw new Error('stream failed');
    }

    const iterator = streamWithCoordinatorLifecycle<FakeSpec, any, any, any>({
      spec: { foo: 'bar' },
      deps,
      closeLoggerAfter: true,
      stream: async function* () {
        yield* badStream();
      }
    });

    const received: any[] = [];
    await expect(async () => {
      for await (const ev of iterator) {
        received.push(ev);
      }
    }).rejects.toThrow('stream failed');

    expect(received).toEqual([{ type: 'first' }]);
    expect(coordinator.close).toHaveBeenCalled();
    expect(closeLogger).toHaveBeenCalled();
  });

  test('cleans up when consumer terminates early', async () => {
    const { deps, coordinator } = createDeps();

    async function* longStream() {
      yield { n: 1 };
      yield { n: 2 };
      yield { n: 3 };
    }

    const iterator = streamWithCoordinatorLifecycle<FakeSpec, any, any, any>({
      spec: { foo: 'bar' },
      deps,
      stream: async function* () {
        yield* longStream();
      }
    });

    const first = await iterator.next();
    expect(first.value).toEqual({ n: 1 });

    await iterator.return?.();

    expect(coordinator.close).toHaveBeenCalled();
  });

  test('surfaces coordinator close error when stream completes', async () => {
    const closeSpy = jest.fn().mockRejectedValue(new Error('close failed'));
    const createCoordinator = jest.fn().mockResolvedValue({ close: closeSpy });
    const deps = { createCoordinator } as any;

    async function* shortStream() {
      yield { n: 1 };
    }

    const iterator = streamWithCoordinatorLifecycle<FakeSpec, any, any, any>({
      spec: { foo: 'bar' },
      pluginsPath: './plugins',
      closeLoggerAfter: false,
      deps,
      stream: async function* () {
        yield* shortStream();
      }
    });

    await expect(async () => {
      for await (const _ of iterator) {
        // consume
      }
    }).rejects.toThrow('close failed');
  });

  test('surfaces closeLogger error when no primary error and loadAll missing', async () => {
    const registry = {} as any;
    const closeLogger = jest.fn().mockRejectedValue(new Error('logger failed'));
    const closeSpy = jest.fn().mockResolvedValue(undefined);
    const deps = {
      createRegistry: jest.fn().mockResolvedValue(registry),
      createCoordinator: jest.fn().mockResolvedValue({ close: closeSpy }),
      closeLogger
    } as any;

    const iterator = streamWithCoordinatorLifecycle<FakeSpec, any, any, any>({
      spec: { foo: 'bar' },
      deps,
      closeLoggerAfter: true,
      stream: async function* () {
        // no events
      }
    });

    await expect(async () => {
      for await (const _ of iterator) {
        // consume
      }
    }).rejects.toThrow('logger failed');
  });

  test('does not override primary stream error with closeLogger error', async () => {
    const { deps } = createDeps({
      closeLogger: jest.fn().mockRejectedValue(new Error('logger failed'))
    });

    async function* badStream() {
      throw new Error('stream failed');
    }

    const iterator = streamWithCoordinatorLifecycle<FakeSpec, any, any, any>({
      spec: { foo: 'bar' },
      deps,
      closeLoggerAfter: true,
      stream: async function* () {
        yield* badStream();
      }
    });

    await expect(async () => {
      for await (const _ of iterator) {
        // consume
      }
    }).rejects.toThrow('stream failed');
  });

  test('falls back to default closeLogger when deps.closeLogger missing', async () => {
    const deps = {
      createRegistry: jest.fn().mockResolvedValue({ loadAll: jest.fn() }),
      createCoordinator: jest.fn().mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) })
    } as any;

    const iterator = streamWithCoordinatorLifecycle<FakeSpec, any, any, any>({
      spec: { foo: 'bar' },
      deps,
      closeLoggerAfter: true,
      stream: async function* () {
        // no events
      }
    });

    for await (const _ of iterator) {
      // consume
    }

    expect(deps.createCoordinator).toHaveBeenCalled();
  });
});
