import { jest } from '@jest/globals';

import fs from 'fs';

import { createUnifiedProgram, defaultDependencies } from '@/modules/cli/internal/unified-cli.ts';

describe('cli extension commands', () => {
  test('default importCliExtension can import node built-ins', async () => {
    const mod = await defaultDependencies.importCliExtension('fs');
    expect(typeof (mod as any).readFileSync).toBe('function');
  });

  test('default listCliExtensions returns [] when fs read fails', () => {
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(defaultDependencies.listCliExtensions()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('ignores extension registration when listCliExtensions throws', () => {
    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      getRealtimeStdio: () => ({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr
      }),
      listCliExtensions: () => {
        throw new Error('boom');
      },
      importCliExtension: jest.fn()
    };

    const program = createUnifiedProgram(deps as any);
    expect(program.helpInformation()).toContain('llm-adapter');
  });

  test('forwards argv to extension runCli', async () => {
    const runCli = jest.fn().mockResolvedValue(undefined);

    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      getRealtimeStdio: () => ({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr
      }),
      listCliExtensions: () => ['demo'],
      importCliExtension: jest.fn().mockResolvedValue({
        default: { name: 'demo', runCli }
      })
    };

    const program = createUnifiedProgram(deps as any);

    await program.parseAsync(['node', 'llm-adapter', 'demo', 'call', '--foo', '1']);

    expect(deps.importCliExtension).toHaveBeenCalledTimes(1);
    expect(deps.importCliExtension).toHaveBeenCalledWith('../../../extensions/demo/index.js');

    expect(runCli).toHaveBeenCalledTimes(1);
    const call = runCli.mock.calls[0]![0];
    expect(call.argv).toEqual(['node', 'llm-adapter', 'call', '--foo', '1']);
    expect(call.deps.log).toBe(deps.log);
    expect(call.deps.error).toBe(deps.error);
    expect(call.deps.exit).toBe(deps.exit);
  });

  test('writes a structured error when extension default export is missing', async () => {
    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      getRealtimeStdio: () => ({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr
      }),
      listCliExtensions: () => ['demo'],
      importCliExtension: jest.fn().mockResolvedValue({})
    };

    const program = createUnifiedProgram(deps as any);

    await program.parseAsync(['node', 'llm-adapter', 'demo', 'call']);

    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.error).toHaveBeenCalled();
    const lastError = String((deps.error as any).mock.calls.at(-1)?.[0] ?? '');
    expect(lastError).toContain('did not export a default extension object');
  });

  test('writes a structured error when extension name is missing', async () => {
    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      getRealtimeStdio: () => ({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr
      }),
      listCliExtensions: () => ['demo'],
      importCliExtension: jest.fn().mockResolvedValue({
        default: { name: 123, runCli: jest.fn() }
      })
    };

    const program = createUnifiedProgram(deps as any);

    await program.parseAsync(['node', 'llm-adapter', 'demo', 'call']);

    expect(deps.exit).toHaveBeenCalledWith(1);
    const lastError = String((deps.error as any).mock.calls.at(-1)?.[0] ?? '');
    expect(lastError).toContain('missing required name');
  });

  test('writes a structured error when extension name mismatches', async () => {
    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      getRealtimeStdio: () => ({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr
      }),
      listCliExtensions: () => ['demo'],
      importCliExtension: jest.fn().mockResolvedValue({
        default: { name: 'other', runCli: jest.fn() }
      })
    };

    const program = createUnifiedProgram(deps as any);

    await program.parseAsync(['node', 'llm-adapter', 'demo', 'call']);

    expect(deps.exit).toHaveBeenCalledWith(1);
    const lastError = String((deps.error as any).mock.calls.at(-1)?.[0] ?? '');
    expect(lastError).toContain('Extension name mismatch');
  });

  test('writes a structured error when extension runCli is missing', async () => {
    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      getRealtimeStdio: () => ({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr
      }),
      listCliExtensions: () => ['demo'],
      importCliExtension: jest.fn().mockResolvedValue({
        default: { name: 'demo' }
      })
    };

    const program = createUnifiedProgram(deps as any);

    await program.parseAsync(['node', 'llm-adapter', 'demo', 'call']);

    expect(deps.exit).toHaveBeenCalledWith(1);
    const lastError = String((deps.error as any).mock.calls.at(-1)?.[0] ?? '');
    expect(lastError).toContain('did not export a runCli function');
  });

  test('skips registering an extension command when it collides with a built-in command', () => {
    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      getRealtimeStdio: () => ({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr
      }),
      listCliExtensions: () => ['serve', 'demo'],
      importCliExtension: jest.fn()
    };

    const program = createUnifiedProgram(deps as any);
    expect(program.commands.filter(cmd => cmd.name() === 'serve')).toHaveLength(1);
    expect(program.commands.filter(cmd => cmd.name() === 'demo')).toHaveLength(1);
    expect(deps.error).toHaveBeenCalledTimes(1);
    expect(String((deps.error as any).mock.calls[0]?.[0] ?? '')).toContain("warning: CLI extension 'serve'");
  });
});
