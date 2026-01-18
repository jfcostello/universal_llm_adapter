import type { Command } from 'commander';

import type { VectorCallSpec, VectorStreamEvent } from '../../../../../kernel/index.js';
import type { FactoryPluginRegistryLike as PluginRegistryLike, VectorCoordinatorLike } from '../../../../lifecycle/index.js';

import type { UnifiedCliContext } from './types.js';

export function registerVectorCommands(program: Command, ctx: UnifiedCliContext): void {
  const vector = program
    .command('vector')
    .description('Vector store operations');

  const handleVectorCommand = async (options: any, streaming: boolean) => {
    try {
      const { loadSpec } = await import('../../spec-loader.js');
      const { writeJsonToStdout } = await import('../../stdout-writer.js');
      const { runWithCoordinatorLifecycle, streamWithCoordinatorLifecycle } = await import('../../../../lifecycle/index.js');
      const { assertValidVectorSpec } = await import('../../../../transport/index.js');

      const spec = await loadSpec<VectorCallSpec>(options);
      assertValidVectorSpec(spec);

      if (streaming) {
        for await (const event of streamWithCoordinatorLifecycle<VectorCallSpec, PluginRegistryLike, VectorCoordinatorLike, VectorStreamEvent>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: ctx.deps.createRegistry,
            createCoordinator: ctx.deps.createVectorCoordinator,
            closeLogger: ctx.deps.closeLogger
          },
          stream: (coordinator, s) => coordinator.executeStream(s) as AsyncIterable<VectorStreamEvent>
        })) {
          ctx.deps.log(JSON.stringify(event));
        }
      } else {
        const result = await runWithCoordinatorLifecycle<VectorCallSpec, PluginRegistryLike, VectorCoordinatorLike, unknown>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: ctx.deps.createRegistry,
            createCoordinator: ctx.deps.createVectorCoordinator,
            closeLogger: ctx.deps.closeLogger
          },
          run: (coordinator, s) => coordinator.execute(s)
        });
        const wrappedResponse = { type: 'response', data: result };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
      }
      ctx.deps.exit(0);
    } catch (error: any) {
      await ctx.writeStructuredError(error);
      ctx.deps.exit(1);
    }
  };

  vector
    .command('run')
    .description('Execute a non-streaming vector operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleVectorCommand(options, false);
    });

  vector
    .command('stream')
    .description('Execute a streaming vector operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .action(async (options) => {
      await handleVectorCommand(options, true);
    });

  const addVectorConvenienceCommand = (name: string, description: string, supportsStream: boolean = false) => {
    const cmd = vector
      .command(name)
      .description(description)
      .option('-f, --file <path>', 'Path to spec JSON file')
      .option('-s, --spec <json>', 'Spec as JSON string')
      .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
      .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
      .option('--pretty', 'Pretty print output');

    if (supportsStream) {
      cmd.option('--stream', 'Stream progress events');
    }

    cmd.action(async (options) => {
      await handleVectorCommand(options, options.stream === true);
    });
  };

  addVectorConvenienceCommand('query', 'Query a vector store');
  addVectorConvenienceCommand('upsert', 'Upsert vectors to a store');
  addVectorConvenienceCommand('embed', 'Embed texts and upsert to a vector store', true);
  addVectorConvenienceCommand('delete', 'Delete vectors by ID');
  addVectorConvenienceCommand('collections', 'Manage collections (list, create, delete, exists)');
}
