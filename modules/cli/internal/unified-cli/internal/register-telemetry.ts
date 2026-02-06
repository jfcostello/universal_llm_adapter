import type { Command } from 'commander';

import type { UnifiedCliContext } from './types.js';

export function registerTelemetryCommands(program: Command, ctx: UnifiedCliContext): void {
  program
    .command('telemetry')
    .description('Submit telemetry (signal or trace_update)')
    .option('-f, --file <path>', 'Path to telemetry JSON payload file')
    .option('-s, --spec <json>', 'Telemetry payload as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      let registry: any;

      try {
        const { loadSpec } = await import('../../spec-loader.js');
        const { writeJsonToStdout } = await import('../../stdout-writer.js');
        const { assertValidTelemetrySubmission } = await import('../../../../transport/index.js');
        const { submitTelemetry } = await import('../../../../observability/index.js');

        const payload = await loadSpec(options);
        assertValidTelemetrySubmission(payload);

        registry = await ctx.deps.createRegistry(options.plugins);

        const result = await submitTelemetry(registry as any, payload as any, {
          runtime: { batchId: options.batchId }
        });

        await writeJsonToStdout({ type: 'response', data: result }, { pretty: options.pretty });
        await ctx.deps.closeLogger();
        ctx.deps.exit(0);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        try {
          await ctx.deps.closeLogger();
        } catch {}
        ctx.deps.exit(1);
      }
    });
}
