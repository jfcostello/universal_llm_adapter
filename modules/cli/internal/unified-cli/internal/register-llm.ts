import type { Command } from 'commander';

import type { LLMCallSpec, LLMStreamEvent } from '../../../../../kernel/index.js';
import type { FactoryPluginRegistryLike as PluginRegistryLike, LLMCoordinatorLike } from '../../../../lifecycle/index.js';

import type { UnifiedCliContext } from './types.js';

export function registerLlmCommands(program: Command, ctx: UnifiedCliContext): void {
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
        const { loadSpec } = await import('../../spec-loader.js');
        const { writeJsonToStdout } = await import('../../stdout-writer.js');
        const { runWithCoordinatorLifecycle } = await import('../../../../lifecycle/index.js');
        const { assertValidSpec } = await import('../../../../transport/index.js');

        const spec = await loadSpec<LLMCallSpec>(options);
        assertValidSpec(spec);
        const response = await runWithCoordinatorLifecycle<LLMCallSpec, PluginRegistryLike, LLMCoordinatorLike, unknown>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: ctx.deps.createRegistry,
            createCoordinator: ctx.deps.createLlmCoordinator,
            closeLogger: ctx.deps.closeLogger
          },
          run: (coordinator, s) => coordinator.run(s)
        });

        const wrappedResponse = { type: 'response', data: response };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
        ctx.deps.exit(0);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
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
        const { loadSpec } = await import('../../spec-loader.js');
        const { streamWithCoordinatorLifecycle } = await import('../../../../lifecycle/index.js');
        const { assertValidSpec } = await import('../../../../transport/index.js');

        const spec = await loadSpec<LLMCallSpec>(options);
        assertValidSpec(spec);
        for await (const event of streamWithCoordinatorLifecycle<LLMCallSpec, PluginRegistryLike, LLMCoordinatorLike, LLMStreamEvent>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: ctx.deps.createRegistry,
            createCoordinator: ctx.deps.createLlmCoordinator,
            closeLogger: ctx.deps.closeLogger
          },
          stream: (coordinator, s) => coordinator.runStream(s) as AsyncIterable<LLMStreamEvent>
        })) {
          ctx.deps.log(JSON.stringify(event));
        }
        ctx.deps.exit(0);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
      }
    });
}
