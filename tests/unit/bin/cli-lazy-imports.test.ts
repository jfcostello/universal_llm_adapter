import { jest } from '@jest/globals';

describe('bin/cli lazy import guardrails', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    process.argv = [...originalArgv];
  });

  test('importing bin/cli and running --help does not import CLI internals', async () => {
    jest.resetModules();

    const imported: string[] = [];

    (jest as any).unstable_mockModule('@/modules/cli/internal/spec-loader.ts', () => {
      imported.push('spec-loader');
      return {
        loadSpec: async () => {
          throw new Error('spec-loader should not be imported for help/program creation');
        }
      };
    });

    (jest as any).unstable_mockModule('@/modules/cli/internal/stdout-writer.ts', () => {
      imported.push('stdout-writer');
      return {
        writeJsonToStdout: async () => {
          throw new Error('stdout-writer should not be imported for help/program creation');
        }
      };
    });

    // Additional guardrails (these should not load until a command executes)
    (jest as any).unstable_mockModule('@/modules/lifecycle/index.ts', () => {
      imported.push('lifecycle');
      return {};
    });
    (jest as any).unstable_mockModule('@/modules/server/index.ts', () => {
      imported.push('server');
      return {};
    });
    (jest as any).unstable_mockModule('@/modules/llm/index.ts', () => {
      imported.push('llm');
      return {};
    });
    (jest as any).unstable_mockModule('@/modules/vector/index.ts', () => {
      imported.push('vector');
      return {};
    });
    (jest as any).unstable_mockModule('@/modules/embeddings/index.ts', () => {
      imported.push('embeddings');
      return {};
    });

    process.argv = ['node', '/not/bin/cli.ts'];

    const cli = await import('@/bin/cli.ts');
    jest.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as any);
    jest.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
    jest.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);

    await expect(cli.runUnifiedCli(['node', 'llm-adapter', '--help'])).rejects.toBeDefined();
    expect(imported).toEqual([]);
  });
});
