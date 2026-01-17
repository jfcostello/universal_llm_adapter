import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import type { Command } from 'commander';

import type { VoiceCliCommandContext } from '../types.js';
import { readRequiredTrimmed, writeStructuredError } from '../utils.js';

export function registerRecordingCommand(program: Command, ctx: VoiceCliCommandContext): void {
  program
    .command('recording')
    .description('Download a voice call recording (server-side)')
    .option('--server-url <url>', 'Base URL of a running adapter server (e.g. http://127.0.0.1:3000)')
    .option('--api-key <key>', 'API key for server auth (sent as x-api-key by default)')
    .option('--api-key-header-name <name>', 'Header name for api key (default: x-api-key)', 'x-api-key')
    .option('--call-config-id <id>', 'Call config id to download recording for')
    .option('--output <path>', 'Write recording bytes to a file (defaults to stdout)')
    .action(async (options) => {
      try {
        const serverUrl = readRequiredTrimmed(options.serverUrl, 'serverUrl');
        const callConfigId = readRequiredTrimmed(options.callConfigId, 'callConfigId');

        const headers: Record<string, string> = {};
        const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
        const apiKeyHeaderName = String(options.apiKeyHeaderName).trim();
        if (apiKey) {
          headers[apiKeyHeaderName] = apiKey;
        }

        const res = await fetch(new URL(`/voice/calls/${encodeURIComponent(callConfigId)}/recording`, serverUrl), {
          method: 'GET',
          headers
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          ctx.io.stderr.write(text.trimEnd() + '\n');
          ctx.deps.exit(1);
          return;
        }

        const destPath = typeof options.output === 'string' ? options.output.trim() : '';
        if (destPath) {
          if (res.body) {
            const writable = fs.createWriteStream(destPath);
            const stream = Readable.fromWeb(res.body as any);
            await pipeline(stream, writable);
          } else {
            fs.writeFileSync(destPath, Buffer.from([]));
          }
        } else {
          if (res.body) {
            const stream = Readable.fromWeb(res.body as any);
            await pipeline(stream, ctx.io.stdout as any);
          }
        }

        ctx.deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(ctx.deps, error);
        ctx.deps.exit(1);
      }
    });
}
