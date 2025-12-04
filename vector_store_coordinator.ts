#!/usr/bin/env node

/**
 * Vector Store Coordinator CLI
 * Handles vector store operations: embed, upsert, query, delete, collections
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PluginRegistry } from './core/registry.js';
import { VectorStoreCoordinator } from './coordinator/vector-coordinator.js';
import { VectorCallSpec, VectorStreamEvent } from './core/vector-spec-types.js';
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
  execute(spec: VectorCallSpec): Promise<any>;
  executeStream(spec: VectorCallSpec): AsyncIterable<VectorStreamEvent>;
  close(): Promise<void>;
}

const defaultDependencies: CliDependencies = {
  createRegistry: (pluginsPath: string) => new PluginRegistry(pluginsPath),
  createCoordinator: (registry: PluginRegistryLike) => new VectorStoreCoordinator(registry as PluginRegistry),
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
  exit: (code: number) => process.exit(code)
};

export function createProgram(partialDeps: Partial<CliDependencies> = {}): Command {
  const deps: CliDependencies = { ...defaultDependencies, ...partialDeps };
  const program = new Command();

  program
    .name('vector-store-coordinator')
    .description('Vector Store Operations CLI')
    .version('1.0.0');

  // Common action handler for all commands
  const handleCommand = async (
    options: any,
    streaming: boolean = false
  ) => {
    try {
      if (options.batchId) {
        process.env.LLM_ADAPTER_BATCH_ID = String(options.batchId);
      }

      const spec = await loadSpec(options);
      // options.plugins always has a value because Commander's .option() provides a default
      const registry = await deps.createRegistry(options.plugins);
      await registry.loadAll();

      const coordinator = await deps.createCoordinator(registry);

      if (streaming) {
        for await (const event of coordinator.executeStream(spec)) {
          deps.log(JSON.stringify(event));
        }
      } else {
        const result = await coordinator.execute(spec);
        const wrappedResponse = { type: 'response', data: result };
        const output = options.pretty
          ? JSON.stringify(wrappedResponse, null, 2)
          : JSON.stringify(wrappedResponse);

        // Force write completion before exit
        const writeComplete = new Promise<void>((resolve) => {
          process.stdout.write(output + '\n', () => {
            resolve();
          });
        });

        await Promise.race([
          writeComplete,
          new Promise<void>(resolve => setTimeout(resolve, 100))
        ]);
      }

      await coordinator.close();
      await closeLogger();
      deps.exit(0);
    } catch (error: any) {
      deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
      deps.exit(1);
    }
  };

  // Embed command
  program
    .command('embed')
    .description('Embed texts and upsert to a vector store')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .option('--stream', 'Stream progress events')
    .action(async (options) => {
      await handleCommand(options, options.stream);
    });

  // Upsert command
  program
    .command('upsert')
    .description('Upsert pre-computed vectors to a store')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleCommand(options);
    });

  // Query command
  program
    .command('query')
    .description('Query a vector store')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleCommand(options);
    });

  // Delete command
  program
    .command('delete')
    .description('Delete vectors by ID')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleCommand(options);
    });

  // Collections command
  program
    .command('collections')
    .description('Manage collections (list, create, delete, exists)')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleCommand(options);
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

export async function loadSpec(
  options: any,
  stdin: NodeJS.ReadableStream = process.stdin
): Promise<VectorCallSpec> {
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

  return specData as VectorCallSpec;
}

const isEntryPoint = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

export const __isEntryPoint = isEntryPoint;

if (isEntryPoint) {
  void runCli(process.argv);
}
