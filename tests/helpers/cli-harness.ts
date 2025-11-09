import { Command } from 'commander';
import { jest } from '@jest/globals';
import { createProgram, CliDependencies } from '@/llm_coordinator.ts';

export interface CliTestHarness {
  program: Command;
  outputs: string[];
  errors: string[];
  exitCodes: number[];
  registryFactory: jest.Mock;
  coordinatorFactory: jest.Mock;
  registry: { loadAll: jest.Mock };
  coordinator: {
    run: jest.Mock;
    runStream: jest.Mock;
    close: jest.Mock;
  };
  run(argv: string[]): Promise<void>;
}

export function createCliTestHarness(partial?: Partial<CliDependencies>): CliTestHarness {
  const outputs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];

  const registry = {
    loadAll: jest.fn().mockResolvedValue(undefined)
  };

  const coordinator = {
    run: jest.fn().mockResolvedValue({ result: 'ok' }),
    runStream: jest.fn().mockImplementation(() => (async function* () {})()),
    close: jest.fn().mockResolvedValue(undefined)
  };

  const registryFactory = jest.fn().mockReturnValue(registry);
  const coordinatorFactory = jest.fn().mockReturnValue(coordinator);

  // Mock process.stdout.write to capture output
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, encodingOrCallback?: any, callback?: any) => {
    const data = chunk.toString();
    outputs.push(data);

    // Call the callback if provided
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (cb) {
      setImmediate(cb);
    }
    return true;
  });

  const deps: CliDependencies = {
    createRegistry: registryFactory,
    createCoordinator: coordinatorFactory,
    log: (message) => outputs.push(message),
    error: (message) => errors.push(message),
    exit: (code) => exitCodes.push(code),
    ...partial
  };

  const program = createProgram(deps);

  program.configureOutput({
    writeOut: (str: string) => outputs.push(str),
    writeErr: (str: string) => errors.push(str),
    outputError: (str: string) => errors.push(str)
  });

  return {
    program,
    outputs,
    errors,
    exitCodes,
    registryFactory,
    coordinatorFactory,
    registry,
    coordinator,
    async run(argv: string[]) {
      await program.parseAsync(['node', 'llm-coordinator', ...argv]);
    }
  };
}

