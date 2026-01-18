import { pathToFileURL } from 'url';

import type { Command } from 'commander';

import type { UnifiedCliContext } from './types.js';

export function registerExtensionCommands(program: Command, ctx: UnifiedCliContext): void {
  program
    .command('extensions')
    .description('Extension pack operations')
    .command('list')
    .description('List available extensions')
    .action(async () => {
      try {
        const { listExtensions } = await import('../../../../extensions/index.js');
        const { writeJsonToStdout } = await import('../../stdout-writer.js');
        const results = listExtensions().map(item => ({
          name: item.name,
          kind: item.kind,
          root: item.root
        }));
        await writeJsonToStdout({ type: 'response', data: results });
        ctx.deps.exit(0);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
      }
    });

  // NOTE: This MUST be registered last so built-in commands take precedence.
  // It provides lazy, direct-by-name dispatch for `llm-adapter <extName> ...`
  // without scanning extension directories at startup.
  program
    .command('*', { hidden: true })
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (_options, command) => {
      const extName = String(command.args[0]).trim();
      try {
        const { loadExtensionDefaults, resolveExtensionEntry } = await import('../../../../extensions/index.js');
        const resolved = resolveExtensionEntry(extName);

        if (!resolved) {
          ctx.deps.error(JSON.stringify({
            type: 'error',
            error: {
              message: `Extension '${extName}' not found. Run 'llm-adapter extensions list' to enumerate available extensions.`,
              code: 'extension_not_found'
            }
          }));
          ctx.deps.exit(1);
          return;
        }

        const importSpecifier =
          resolved.kind === 'builtin'
            ? `../../../extensions/${resolved.name}/index.js`
            : pathToFileURL(resolved.entryFilePath).href;

        const mod = await ctx.deps.importCliExtension(importSpecifier);
        const ext = (mod as any)?.default;
        if (!ext || typeof ext !== 'object') {
          throw new Error(`Extension '${resolved.name}' did not export a default extension object`);
        }
        if (typeof (ext as any).name !== 'string') {
          throw new Error(`Extension '${resolved.name}' missing required name`);
        }
        if ((ext as any).name !== resolved.name) {
          throw new Error(
            `Extension name mismatch: expected '${resolved.name}', got '${(ext as any).name}'`
          );
        }
        const runCli = (ext as any).runCli;
        if (typeof runCli !== 'function') {
          throw new Error(`Extension '${resolved.name}' did not export a runCli function`);
        }

        const rawArgs = command.parent!.rawArgs;
        const argv = rawArgs.slice(0, 2).concat(command.args.slice(1));
        const config = loadExtensionDefaults(resolved);
        await runCli({ argv, deps: ctx.deps, config });
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
      }
    });
}
