import { Command } from 'commander';

import type { VoiceCliCommandContext, VoiceCliDeps, VoiceCliIo } from './internal/types.js';
import { writeStructuredError } from './internal/utils.js';
import { registerCallCommand } from './internal/commands/call.js';
import { registerEndCommand } from './internal/commands/end.js';
import { registerEventsCommand } from './internal/commands/events.js';
import { registerRecordingCommand } from './internal/commands/recording.js';
import { registerTransferCommand } from './internal/commands/transfer.js';

export async function runVoiceCli(ctx: { argv: string[]; deps: any; io?: Partial<VoiceCliIo> }): Promise<void> {
  const deps: VoiceCliDeps = {
    error: typeof ctx.deps?.error === 'function' ? ctx.deps.error.bind(ctx.deps) : (m) => console.error(m),
    exit: typeof ctx.deps?.exit === 'function' ? ctx.deps.exit.bind(ctx.deps) : (c) => { process.exitCode = c; }
  };

  const io: VoiceCliIo = {
    stdin: ctx.io?.stdin ?? process.stdin,
    stdout: ctx.io?.stdout ?? process.stdout,
    stderr: ctx.io?.stderr ?? process.stderr
  };

  const commandCtx: VoiceCliCommandContext = { deps, io };

  const program = new Command();
  program
    .name('llm-adapter voice')
    .description('Voice extension commands')
    .version('1.0.0');
  program.exitOverride();

  registerCallCommand(program, commandCtx);
  registerEndCommand(program, commandCtx);
  registerTransferCommand(program, commandCtx);
  registerEventsCommand(program, commandCtx);
  registerRecordingCommand(program, commandCtx);

  try {
    await program.parseAsync(ctx.argv);
  } catch (error: any) {
    await writeStructuredError(deps, error);
    deps.exit(1);
  }
}

