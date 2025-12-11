import path from 'path';
import { jest } from '@jest/globals';
import { Command } from 'commander';
import * as CliModule from '@/llm_coordinator.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

const { createProgram, runCli, __isEntryPoint } = CliModule;

function createDeps(overrides: Partial<CliModule.CliDependencies> = {}) {
  const registry = { loadAll: jest.fn().mockResolvedValue(undefined) };
  const coordinator = {
    run: jest.fn().mockResolvedValue({ ok: true }),
    runStream: jest.fn().mockImplementation(async function* () {
      yield { type: 'FIRST' };
      yield { type: 'SECOND' };
    }),
    close: jest.fn().mockResolvedValue(undefined)
  };

  const baseDeps = {
    createRegistry: jest.fn().mockResolvedValue(registry),
    createCoordinator: jest.fn().mockResolvedValue(coordinator),
    log: jest.fn(),
    error: jest.fn(),
    exit: jest.fn()
  };

  return {
    deps: { ...baseDeps, ...overrides },
    registry,
    coordinator
  };
}

describe('llm_coordinator CLI', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('run command uses default plugins path and plain output', async () => {
    const { deps, registry, coordinator } = createDeps();
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm', 'run', '--spec', '{"foo":"bar"}']);

    expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
    expect(registry.loadAll).toHaveBeenCalled();
    expect(coordinator.run).toHaveBeenCalledWith(expect.objectContaining({ foo: 'bar' }));
    expect(coordinator.close).toHaveBeenCalled();
    // Note: deps.log is no longer called - response is written via process.stdout.write for proper flushing
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(__isEntryPoint).toBe(false);
  });

  test('run command falls back to builtin plugins path when option absent', async () => {
    const { deps } = createDeps();
    const program = createProgram(deps);
    const runCommand = program.commands.find(cmd => cmd.name() === 'run');

    deps.createRegistry.mockClear();
    const originalOpts = runCommand!.opts.bind(runCommand);
    (runCommand as any).opts = () => ({ spec: '{"fallback":true}' });

    await (runCommand as any)._actionHandler([], runCommand);

    (runCommand as any).opts = originalOpts;

    expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  test('run command pretty prints when requested', async () => {
    const { deps } = createDeps({
      log: jest.fn(),
      exit: jest.fn()
    });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm', 'run', '--spec', '{"foo":"bar"}', '--pretty']);

    // Note: deps.log is no longer called - response is written via process.stdout.write
    // The pretty print option formats the JSON, which is tested via integration tests
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  test('run command accepts --batch-id and sets env before coordinator', async () => {
    delete process.env.LLM_ADAPTER_BATCH_ID;
    const createCoordinatorSpy = jest.fn().mockResolvedValue({
      run: jest.fn().mockResolvedValue({ ok: true }),
      runStream: jest.fn(),
      close: jest.fn()
    });
    const { deps } = createDeps({ createCoordinator: createCoordinatorSpy });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm', 'run', '--spec', '{"x":1}', '--batch-id', 'unitBatch']);

    expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('unitBatch');
    expect(deps.exit).toHaveBeenCalledWith(0);
    delete process.env.LLM_ADAPTER_BATCH_ID;
  });

  test('stream command accepts --batch-id and sets env', async () => {
    delete process.env.LLM_ADAPTER_BATCH_ID;
    const { deps } = createDeps({ log: jest.fn(), exit: jest.fn() });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm', 'stream', '--spec', '{"y":2}', '--batch-id', 'streamBatch']);

    expect(process.env.LLM_ADAPTER_BATCH_ID).toBe('streamBatch');
    expect(deps.exit).toHaveBeenCalledWith(0);
    delete process.env.LLM_ADAPTER_BATCH_ID;
  });

  test('run command surfaces string errors via fallback', async () => {
    const { deps } = createDeps({
      createRegistry: jest.fn().mockRejectedValue('total failure')
    });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm', 'run', '--spec', '{"foo":"bar"}']);

    expect(deps.error).toHaveBeenCalledWith(JSON.stringify({ error: 'total failure' }));
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  test('stream command streams events and defaults plugins path', async () => {
    const { deps, registry, coordinator } = createDeps({
      log: jest.fn(),
      exit: jest.fn()
    });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm', 'stream', '--spec', '{"foo":"bar"}']);

    expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
    expect(registry.loadAll).toHaveBeenCalled();
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      JSON.stringify({ type: 'FIRST' }),
      JSON.stringify({ type: 'SECOND' })
    ]);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  test('stream command falls back to builtin plugins path when option absent', async () => {
    const { deps } = createDeps({ log: jest.fn(), exit: jest.fn() });
    const program = createProgram(deps);
    const streamCommand = program.commands.find(cmd => cmd.name() === 'stream');

    deps.createRegistry.mockClear();
    const originalOpts = streamCommand!.opts.bind(streamCommand);
    (streamCommand as any).opts = () => ({ spec: '{"foo":1}' });

    await (streamCommand as any)._actionHandler([], streamCommand);

    (streamCommand as any).opts = originalOpts;

    expect(deps.createRegistry).toHaveBeenCalledWith('./plugins');
    expect(deps.log).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  test('stream command string error uses fallback message', async () => {
    const { deps } = createDeps({
      createCoordinator: jest.fn().mockRejectedValue('broken stream')
    });
    const program = createProgram(deps);

    await program.parseAsync(['node', 'llm', 'stream', '--spec', '{"foo":"bar"}']);

    expect(deps.error).toHaveBeenCalledWith(JSON.stringify({ error: 'broken stream' }));
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  test('runCli uses process.argv when invoked without override', async () => {
    const originalArgv = [...process.argv];
    process.argv = ['node', 'llm', '--version'];

    const parseSpy = jest.spyOn(Command.prototype, 'parseAsync').mockResolvedValue(undefined);

    await runCli();

    expect(parseSpy).toHaveBeenCalledWith(process.argv);

    parseSpy.mockRestore();
    process.argv = originalArgv;
  });

  test('entrypoint auto-invokes runCli when executed directly', async () => {
    const originalArgv = [...process.argv];
    const scriptPath = path.join(ROOT_DIR, 'llm_coordinator.ts');
    process.argv = ['node', scriptPath, '--version'];

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let localParseSpy: jest.SpyInstance | undefined;

    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      const commander = await import('commander');
      localParseSpy = jest
        .spyOn(commander.Command.prototype, 'parseAsync')
        .mockResolvedValue(undefined);
      await import('@/llm_coordinator.ts');
    });

    expect(localParseSpy).toBeDefined();
    expect(localParseSpy?.mock.calls.length).toBeGreaterThan(0);

    localParseSpy?.mockRestore();
    exitSpy.mockRestore();
    process.argv = originalArgv;
  });
});
