import type { Command } from 'commander';

import type { UnifiedCliContext } from './types.js';

function createValidationError(message: string): Error {
  const error = new Error(message);
  (error as any).statusCode = 400;
  (error as any).code = 'validation_error';
  return error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype;
}

function parseJsonObject(raw: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw createValidationError(`${field} must be a JSON object`);
    }
    return parsed;
  } catch (error: any) {
    if (error?.code === 'validation_error') throw error;
    throw createValidationError(`${field} must be valid JSON`);
  }
}

export function registerSignalsCommands(program: Command, ctx: UnifiedCliContext): void {
  const signals = program
    .command('signals')
    .description('Signals / alerts operations');

  signals
    .command('report')
    .description('Report a signal event')
    .requiredOption('--trace-id <id>', 'Trace identifier')
    .requiredOption('--generation-id <id>', 'Generation identifier')
    .requiredOption('--level <level>', 'Signal level (debug|info|warning|error)')
    .requiredOption('--message <message>', 'Signal message')
    .option('--timestamp-ms <ms>', 'Unix timestamp (ms) for the event')
    .option('--code <code>', 'Optional code for the event')
    .option('--stack <stack>', 'Optional stack trace for the event')
    .option('--tags <json>', 'Optional tags JSON object')
    .option('--metadata <json>', 'Optional metadata JSON object')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        const { writeJsonToStdout } = await import('../../stdout-writer.js');
        const { runWithCoordinatorLifecycle } = await import('../../../../lifecycle/index.js');

        const event: any = {
          traceId: options.traceId,
          generationId: options.generationId,
          timestampMs: options.timestampMs,
          level: options.level,
          message: options.message,
          ...(options.code ? { code: options.code } : {}),
          ...(options.stack ? { stack: options.stack } : {}),
          ...(options.tags ? { tags: parseJsonObject(options.tags, 'tags') } : {}),
          ...(options.metadata ? { metadata: parseJsonObject(options.metadata, 'metadata') } : {})
        };

        const result = await runWithCoordinatorLifecycle<any, any, any, any>({
          spec: event,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: ctx.deps.createRegistry,
            createCoordinator: async (registry: any) => ({
              report: async (payload: any) => {
                const { getLogger } = await import('../../../../logging/index.js');
                const { reportSignal } = await import('../../../../signals/index.js');
                const correlationId = payload?.metadata?.correlationId as string | undefined;
                const logger = getLogger(correlationId);
                return reportSignal({ registry, event: payload, logger });
              },
              close: async () => {}
            }),
            closeLogger: ctx.deps.closeLogger
          },
          run: (coordinator: any, s: any) => coordinator.report(s)
        });

        await writeJsonToStdout({ type: 'response', data: result }, { pretty: options.pretty });
        ctx.deps.exit(0);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
      }
    });
}
