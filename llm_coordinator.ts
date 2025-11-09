#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PluginRegistry } from './core/registry.js';
import { LLMCoordinator } from './coordinator/coordinator.js';
import { LLMCallSpec, LLMStreamEvent } from './core/types.js';
import { closeLogger } from './core/logging.js';

export interface CliDependencies {
  createRegistry: (pluginsPath: string) => PromiseLike<PluginRegistryLike> | PluginRegistryLike;
  createCoordinator: (registry: PluginRegistryLike) => PromiseLike<CoordinatorLike> | CoordinatorLike;
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
}

interface PluginRegistryLike {
  loadAll(): Promise<void>;
}

interface CoordinatorLike {
  run(spec: LLMCallSpec): Promise<unknown>;
  runStream(spec: LLMCallSpec): AsyncIterable<LLMStreamEvent>;
  close(): Promise<void>;
}

const defaultDependencies: CliDependencies = {
  createRegistry: (pluginsPath: string) => new PluginRegistry(pluginsPath),
  createCoordinator: (registry: PluginRegistryLike) => new LLMCoordinator(registry as PluginRegistry),
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
  exit: (code: number) => process.exit(code)
};

export function createProgram(partialDeps: Partial<CliDependencies> = {}): Command {
  const deps: CliDependencies = { ...defaultDependencies, ...partialDeps };
  const program = new Command();

  program
    .name('llm-coordinator')
    .description('LLM Adapter CLI')
    .version('1.0.0');

  program
    .command('run')
    .description('Execute a non-streaming LLM call')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        if (options.batchId) {
          // Expose to logging subsystem prior to any logger creation
          process.env.LLM_ADAPTER_BATCH_ID = String(options.batchId);
        }
        const spec = await loadSpec(options);
        const registry = await deps.createRegistry(options.plugins ?? './plugins');
        await registry.loadAll();

        const coordinator = await deps.createCoordinator(registry);

        const response = await coordinator.run(spec);

        await coordinator.close();

        await closeLogger();

        const wrappedResponse = { type: 'response', data: response };
        const output = options.pretty
          ? JSON.stringify(wrappedResponse, null, 2)
          : JSON.stringify(wrappedResponse);

        // Force write completion before exit to avoid race condition with large responses
        // console.log is async when stdout is piped, causing 240KB+ responses to be truncated
        const writeComplete = new Promise<void>((resolve) => {
          process.stdout.write(output + '\n', () => {
            resolve();
          });
        });

        // Race with timeout for test environments where callback may not fire
        await Promise.race([
          writeComplete,
          new Promise<void>(resolve => setTimeout(resolve, 100))
        ]);

        deps.exit(0);
      } catch (error: any) {
        deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
        deps.exit(1);
      }
    });

  program
    .command('stream')
    .description('Execute a streaming LLM call')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .action(async (options) => {
      try {
        if (options.batchId) {
          process.env.LLM_ADAPTER_BATCH_ID = String(options.batchId);
        }
        const spec = await loadSpec(options);
        const registry = await deps.createRegistry(options.plugins ?? './plugins');
        await registry.loadAll();

        const coordinator = await deps.createCoordinator(registry);

        for await (const event of coordinator.runStream(spec)) {
          deps.log(JSON.stringify(event));
        }

        await coordinator.close();
        await closeLogger(); // Flush all Winston buffers before exit
        deps.exit(0);
      } catch (error: any) {
        deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
        deps.exit(1);
      }
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

export async function loadSpec(options: any, stdin: NodeJS.ReadableStream = process.stdin): Promise<LLMCallSpec> {
  let specData: any;
  
  if (options.file) {
    const content = fs.readFileSync(options.file, 'utf-8');
    specData = JSON.parse(content);
  } else if (options.spec) {
    specData = JSON.parse(options.spec);
  } else {
    // Read from stdin
    let input = '';
    stdin.setEncoding('utf-8');
    
    for await (const chunk of stdin) {
      input += chunk;
    }
    
    specData = JSON.parse(input);
  }
  
  return specData as LLMCallSpec;
}

const isEntryPoint = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

export const __isEntryPoint = isEntryPoint;

if (isEntryPoint) {
  void runCli(process.argv);
}
