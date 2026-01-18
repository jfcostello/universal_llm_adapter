import type { Command } from 'commander';

import type { EmbeddingCallSpec } from '../../../../../kernel/index.js';
import type { EmbeddingCoordinatorLike, FactoryPluginRegistryLike as PluginRegistryLike } from '../../../../lifecycle/index.js';

import type { UnifiedCliContext } from './types.js';

export function registerEmbeddingsCommands(program: Command, ctx: UnifiedCliContext): void {
  const embeddings = program
    .command('embeddings')
    .description('Embedding operations');

  embeddings
    .command('run')
    .description('Execute an embedding operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        const { loadSpec } = await import('../../spec-loader.js');
        const { writeJsonToStdout } = await import('../../stdout-writer.js');
        const { runWithCoordinatorLifecycle } = await import('../../../../lifecycle/index.js');
        const { assertValidEmbeddingSpec } = await import('../../../../transport/index.js');

        const spec = await loadSpec<EmbeddingCallSpec>(options);
        assertValidEmbeddingSpec(spec);
        const result = await runWithCoordinatorLifecycle<EmbeddingCallSpec, PluginRegistryLike, EmbeddingCoordinatorLike, unknown>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: ctx.deps.createRegistry,
            createCoordinator: ctx.deps.createEmbeddingCoordinator,
            closeLogger: ctx.deps.closeLogger
          },
          run: (coordinator, s) => coordinator.execute(s)
        });

        const wrappedResponse = { type: 'response', data: result };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
        ctx.deps.exit(0);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
      }
    });
}
