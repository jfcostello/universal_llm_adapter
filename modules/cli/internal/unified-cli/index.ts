import { Command } from 'commander';

import { defaultDependencies, type UnifiedCliDependencies } from './internal/deps.js';
import type { UnifiedCliContext } from './internal/types.js';
import { registerEmbeddingsCommands } from './internal/register-embeddings.js';
import { registerExtensionCommands } from './internal/register-extensions.js';
import { registerLlmCommands } from './internal/register-llm.js';
import { registerRealtimeCommands } from './internal/register-realtime.js';
import { registerServeCommand } from './internal/register-serve.js';
import { registerVectorCommands } from './internal/register-vector.js';

export { defaultDependencies } from './internal/deps.js';
export type { UnifiedCliDependencies } from './internal/deps.js';

export function createUnifiedProgram(partialDeps: Partial<UnifiedCliDependencies> = {}): Command {
  const deps: UnifiedCliDependencies = { ...defaultDependencies, ...partialDeps };
  const program = new Command();

  const writeStructuredError = async (error: any) => {
    try {
      const { mapErrorToHttp } = await import('../../../transport/index.js');
      const mapped = mapErrorToHttp(error, { redactServerErrors: false });
      deps.error(JSON.stringify(mapped.body));
      return;
    } catch {
      const message = error?.message ?? String(error);
      const code = error?.code ? String(error.code) : 'internal';
      deps.error(JSON.stringify({ type: 'error', error: { message, code } }));
    }
  };

  const ctx: UnifiedCliContext = { deps, writeStructuredError };

  program
    .name('llm-adapter')
    .description('LLM Adapter CLI - Unified interface for LLM, Vector, and Embedding operations')
    .version('1.0.0');

  registerLlmCommands(program, ctx);
  registerVectorCommands(program, ctx);
  registerEmbeddingsCommands(program, ctx);
  registerServeCommand(program, ctx);
  registerRealtimeCommands(program, ctx);
  registerExtensionCommands(program, ctx);

  return program;
}

export async function runUnifiedCli(argv: string[] = process.argv): Promise<void> {
  const program = createUnifiedProgram();
  await program.parseAsync(argv);
}
