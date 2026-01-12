import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import { createUnifiedProgram, defaultDependencies } from '@/modules/cli/internal/unified-cli.ts';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('cli extension commands', () => {
  test('default importCliExtension can import node built-ins', async () => {
    const mod = await defaultDependencies.importCliExtension('fs');
    expect(typeof (mod as any).readFileSync).toBe('function');
  });

  test('--help does not scan/register extensions at startup', () => {
    const readdirSpy = jest.spyOn(fs, 'readdirSync');
    try {
      const program = createUnifiedProgram({
        createRegistry: jest.fn(),
        createLlmCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn(),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      } as any);

      expect(program.helpInformation()).toContain('llm-adapter');
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      readdirSpy.mockRestore();
    }
  });

  test('unknown command does not scan extensions (direct resolve only)', async () => {
    const readdirSpy = jest.spyOn(fs, 'readdirSync');
    const deps = {
      createRegistry: jest.fn(),
      createLlmCoordinator: jest.fn(),
      createVectorCoordinator: jest.fn(),
      createEmbeddingCoordinator: jest.fn(),
      closeLogger: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      exit: jest.fn(),
      importCliExtension: jest.fn()
    };

    const program = createUnifiedProgram(deps as any);
    await program.parseAsync(['node', 'llm-adapter', 'definitely-not-a-real-extension']);

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(deps.importCliExtension).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining('\"code\":\"extension_not_found\"')
    );
    expect(deps.exit).toHaveBeenCalledWith(1);

    readdirSpy.mockRestore();
  });

  test('dispatches to extension runCli and forwards argv (without extension name)', async () => {
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
      importCliExtension: jest.fn().mockResolvedValue({
        default: { name: 'voice', runCli }
      })
    };

    const program = createUnifiedProgram(deps as any);

    await program.parseAsync(['node', 'llm-adapter', 'voice', 'call', '--foo', '1']);

    expect(deps.importCliExtension).toHaveBeenCalledTimes(1);
    expect(deps.importCliExtension).toHaveBeenCalledWith('../../../extensions/voice/index.js');

    expect(runCli).toHaveBeenCalledTimes(1);
    const call = runCli.mock.calls[0]![0];
    expect(call.argv).toEqual(['node', 'llm-adapter', 'call', '--foo', '1']);
    expect(call.deps.log).toBe(deps.log);
    expect(call.deps.error).toBe(deps.error);
    expect(call.deps.exit).toBe(deps.exit);
  });

  test('extensions list scans roots explicitly', async () => {
    await withTempCwd('cli-extensions-list', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'demo'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'demo', 'index.js'),
        "export default { name: 'demo', runCli: async () => {} };",
        'utf-8'
      );

      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              lookup: {
                extensions: { builtin: false, externalRoots: ['./pack-a'] }
              }
            }
          },
          null,
          2
        ),
        'utf-8'
      );

      const stdoutWrites: string[] = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((...args: any[]) => {
        stdoutWrites.push(String(args[0] ?? ''));
        const callback = args.find((arg: any) => typeof arg === 'function');
        if (callback) setImmediate(callback);
        return true;
      });

      const program = createUnifiedProgram({
        createRegistry: jest.fn(),
        createLlmCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn(),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      } as any);

      await program.parseAsync(['node', 'llm-adapter', 'extensions', 'list']);

      const output = stdoutWrites.join('');
      expect(output).toContain('\"name\":\"demo\"');
    });
  });

  test('dispatches to an external extension using a file:// import specifier', async () => {
    await withTempCwd('cli-extension-dispatch-external', async (cwd) => {
      const packRoot = path.join(cwd, 'pack-a');
      fs.mkdirSync(path.join(packRoot, 'extensions', 'demo'), { recursive: true });
      fs.writeFileSync(
        path.join(packRoot, 'extensions', 'demo', 'index.js'),
        "export default { name: 'demo', runCli: async () => {} };",
        'utf-8'
      );

      fs.writeFileSync(
        path.join(cwd, 'llm-adapter.paths.json'),
        JSON.stringify(
          {
            paths: {
              lookup: {
                extensions: { builtin: false, externalRoots: ['./pack-a'] }
              }
            }
          },
          null,
          2
        ),
        'utf-8'
      );

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
        importCliExtension: jest.fn().mockResolvedValue({
          default: { name: 'demo', runCli }
        })
      };

      const program = createUnifiedProgram(deps as any);
      await program.parseAsync(['node', 'llm-adapter', 'demo', 'call', '--foo', '1']);

      expect(deps.importCliExtension).toHaveBeenCalledTimes(1);
      const specifier = String((deps.importCliExtension as any).mock.calls[0][0]);
      expect(specifier.startsWith('file://')).toBe(true);
      expect(specifier).toContain('/pack-a/extensions/demo/index.js');

      expect(runCli).toHaveBeenCalledTimes(1);
      expect(runCli.mock.calls[0]![0].argv).toEqual(['node', 'llm-adapter', 'call', '--foo', '1']);
    });
  });

  test('extensions list reports errors (stdout writer failure)', async () => {
    await withTempCwd('cli-extensions-list-error', async () => {
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementationOnce(() => {
        throw new Error('boom');
      });

      const deps = {
        createRegistry: jest.fn(),
        createLlmCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn(),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn()
      };

      try {
        const program = createUnifiedProgram(deps as any);
        await program.parseAsync(['node', 'llm-adapter', 'extensions', 'list']);
        expect(deps.exit).toHaveBeenCalledWith(1);
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  test('extension dispatch errors when default export is missing', async () => {
    await withTempCwd('cli-extension-dispatch-bad-default', async () => {
      const deps = {
        createRegistry: jest.fn(),
        createLlmCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn(),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn(),
        importCliExtension: jest.fn().mockResolvedValue({})
      };

      const program = createUnifiedProgram(deps as any);
      await program.parseAsync(['node', 'llm-adapter', 'voice']);
      expect(deps.exit).toHaveBeenCalledWith(1);
    });
  });

  test('extension dispatch errors when name is missing', async () => {
    await withTempCwd('cli-extension-dispatch-missing-name', async () => {
      const deps = {
        createRegistry: jest.fn(),
        createLlmCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn(),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn(),
        importCliExtension: jest.fn().mockResolvedValue({ default: { runCli: async () => {} } })
      };

      const program = createUnifiedProgram(deps as any);
      await program.parseAsync(['node', 'llm-adapter', 'voice']);
      expect(deps.exit).toHaveBeenCalledWith(1);
    });
  });

  test('extension dispatch errors when name mismatches folder', async () => {
    await withTempCwd('cli-extension-dispatch-name-mismatch', async () => {
      const deps = {
        createRegistry: jest.fn(),
        createLlmCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn(),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn(),
        importCliExtension: jest.fn().mockResolvedValue({ default: { name: 'nope', runCli: async () => {} } })
      };

      const program = createUnifiedProgram(deps as any);
      await program.parseAsync(['node', 'llm-adapter', 'voice']);
      expect(deps.exit).toHaveBeenCalledWith(1);
    });
  });

  test('extension dispatch errors when runCli is missing', async () => {
    await withTempCwd('cli-extension-dispatch-missing-runcli', async () => {
      const deps = {
        createRegistry: jest.fn(),
        createLlmCoordinator: jest.fn(),
        createVectorCoordinator: jest.fn(),
        createEmbeddingCoordinator: jest.fn(),
        closeLogger: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        exit: jest.fn(),
        importCliExtension: jest.fn().mockResolvedValue({ default: { name: 'voice' } })
      };

      const program = createUnifiedProgram(deps as any);
      await program.parseAsync(['node', 'llm-adapter', 'voice']);
      expect(deps.exit).toHaveBeenCalledWith(1);
    });
  });
});
