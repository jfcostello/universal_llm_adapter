#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PluginRegistry } from './core/registry.js';
import { LLMCoordinator } from './coordinator/coordinator.js';
import { LLMCallSpec, LLMStreamEvent } from './core/types.js';
import { closeLogger } from './core/logging.js';
import { loadSpec, writeJsonToStdout } from './utils/cli/index.js';
import {
  runWithCoordinatorLifecycle,
  streamWithCoordinatorLifecycle
} from './utils/coordinator-lifecycle/index.js';

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
        const spec = await loadSpec(options);
        const response = await runWithCoordinatorLifecycle<LLMCallSpec, any, any, unknown>({
          spec,
          pluginsPath: options.plugins ?? './plugins',
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createCoordinator,
            closeLogger
          },
          run: (coordinator, s) => coordinator.run(s)
        });

        const wrappedResponse = { type: 'response', data: response };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });

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
        const spec = await loadSpec(options);
        for await (const event of streamWithCoordinatorLifecycle<LLMCallSpec, any, any, LLMStreamEvent>({
          spec,
          pluginsPath: options.plugins ?? './plugins',
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createCoordinator,
            closeLogger
          },
          stream: (coordinator, s) => coordinator.runStream(s)
        })) {
          deps.log(JSON.stringify(event));
        }
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

const isEntryPoint = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

export const __isEntryPoint = isEntryPoint;

if (isEntryPoint) {
  void runCli(process.argv);
}
