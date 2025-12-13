import { Command } from 'commander';
import { loadSpec } from './spec-loader.js';
import { writeJsonToStdout } from './stdout-writer.js';
import type { EmbeddingCallSpec } from '../../../core/embedding-spec-types.js';
import type { VectorCallSpec, VectorStreamEvent } from '../../../core/vector-spec-types.js';

export interface VectorCliDependencies {
  createRegistry: (
    pluginsPath: string
  ) => PromiseLike<PluginRegistryLike> | PluginRegistryLike;
  createCoordinator: (
    registry: PluginRegistryLike
  ) => PromiseLike<CoordinatorLike> | CoordinatorLike;
  createEmbeddingCoordinator?: (
    registry: PluginRegistryLike
  ) => PromiseLike<EmbeddingCoordinatorLike> | EmbeddingCoordinatorLike;
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

interface EmbeddingCoordinatorLike {
  execute(spec: EmbeddingCallSpec): Promise<unknown>;
  close(): Promise<void>;
}

const defaultDependencies: VectorCliDependencies = {
  createRegistry: async (pluginsPath: string) => {
    const module = await import('../../../core/registry.js');
    return new module.PluginRegistry(pluginsPath);
  },
  createCoordinator: async (registry: PluginRegistryLike) => {
    const module = await import('../../../coordinator/vector-coordinator.js');
    return new module.VectorStoreCoordinator(registry as any);
  },
  createEmbeddingCoordinator: async (registry: PluginRegistryLike) => {
    const module = await import('../../../coordinator/embedding-coordinator.js');
    return new module.EmbeddingCoordinator(registry as any);
  },
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
  exit: (code: number) => process.exit(code)
};

export function createVectorStoreCoordinatorProgram(
  partialDeps: Partial<VectorCliDependencies> = {}
): Command {
  const deps: VectorCliDependencies = { ...defaultDependencies, ...partialDeps };
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
      const spec = await loadSpec(options);
      const { runWithCoordinatorLifecycle, streamWithCoordinatorLifecycle } = await import(
        '../../lifecycle/index.js'
      );
      if (streaming) {
        for await (const event of streamWithCoordinatorLifecycle<VectorCallSpec, any, any, VectorStreamEvent>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createCoordinator
          },
          stream: (coordinator, s) => coordinator.executeStream(s)
        })) {
          deps.log(JSON.stringify(event));
        }
      } else {
        const result = await runWithCoordinatorLifecycle<VectorCallSpec, any, any, any>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createCoordinator
          },
          run: (coordinator, s) => coordinator.execute(s)
        });
        const wrappedResponse = { type: 'response', data: result };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
      }
      deps.exit(0);
    } catch (error: any) {
      deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
      deps.exit(1);
    }
  };

  const handleEmbeddingCommand = async (options: any) => {
    try {
      const spec = await loadSpec(options);

      if (!deps.createEmbeddingCoordinator) {
        throw new Error('createEmbeddingCoordinator dependency missing');
      }

      const { runWithCoordinatorLifecycle } = await import('../../lifecycle/index.js');
      const result = await runWithCoordinatorLifecycle<EmbeddingCallSpec, any, any, any>({
        spec,
        pluginsPath: options.plugins,
        batchId: options.batchId,
        closeLoggerAfter: true,
        deps: {
          createRegistry: deps.createRegistry,
          createCoordinator: deps.createEmbeddingCoordinator
        },
        run: (coordinator: any, s) => coordinator.execute(s)
      });

      const wrappedResponse = { type: 'response', data: result };
      await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
      deps.exit(0);
    } catch (error: any) {
      deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
      deps.exit(1);
    }
  };

  // Generic run command (operation-agnostic)
  program
    .command('run')
    .description('Execute a non-streaming vector operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleCommand(options, false);
    });

  // Generic stream command (operation-agnostic)
  program
    .command('stream')
    .description('Execute a streaming vector operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .action(async (options) => {
      await handleCommand(options, true);
    });

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

  const embeddings = program
    .command('embeddings')
    .description('Embedding operations (via vector coordinator CLI)');

  embeddings
    .command('run')
    .description('Execute an embedding operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleEmbeddingCommand(options);
    });

  return program;
}

export async function runVectorStoreCoordinatorCli(argv: string[] = process.argv): Promise<void> {
  const program = createVectorStoreCoordinatorProgram();
  await program.parseAsync(argv);
}
