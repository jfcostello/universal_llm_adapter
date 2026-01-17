import type { Command } from 'commander';

import { validateEndMode, validateMaxWaitMs, validateCancelOnUserSpeechCli } from '../../../../../graceful-mode-validation/index.js';

import type { VoiceCliCommandContext } from '../types.js';
import { readRequiredTrimmed, writeJson, writeStructuredError } from '../utils.js';

export function registerEndCommand(program: Command, ctx: VoiceCliCommandContext): void {
  program
    .command('end')
    .description('End a voice call (server-side)')
    .option('--server-url <url>', 'Base URL of a running adapter server (e.g. http://127.0.0.1:3000)')
    .option('--api-key <key>', 'API key for server auth (sent as x-api-key by default)')
    .option('--api-key-header-name <name>', 'Header name for api key (default: x-api-key)', 'x-api-key')
    .option('--call-config-id <id>', 'Call config id to terminate')
    .option('--mode <mode>', 'End mode (immediate|after_assistant_audio|after_playback)')
    .option('--max-wait-ms <ms>', 'Max wait time (ms) for graceful end')
    .option('--cancel-on-user-speech <0|1>', 'Cancel graceful end when user speech starts (0|1)')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        const serverUrl = readRequiredTrimmed(options.serverUrl, 'serverUrl');
        const callConfigId = readRequiredTrimmed(options.callConfigId, 'callConfigId');

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
        const apiKeyHeaderName = String(options.apiKeyHeaderName).trim();
        if (apiKey) {
          headers[apiKeyHeaderName] = apiKey;
        }

        const body = (() => {
          const out: any = {};

          const modeRaw = typeof options.mode === 'string' ? options.mode.trim() : '';
          if (modeRaw) {
            out.mode = validateEndMode(modeRaw, 'immediate');
          }

          const maxWaitMsRaw = typeof options.maxWaitMs === 'string' ? options.maxWaitMs.trim() : '';
          if (maxWaitMsRaw) {
            out.maxWaitMs = validateMaxWaitMs(maxWaitMsRaw, 0);
          }

          const cancelOnUserSpeech = validateCancelOnUserSpeechCli(options.cancelOnUserSpeech);
          if (cancelOnUserSpeech !== undefined) {
            out.cancelOnUserSpeech = cancelOnUserSpeech;
          }

          if (Object.keys(out).length === 0) return undefined;
          return out;
        })();

        const res = await fetch(new URL(`/voice/calls/${encodeURIComponent(callConfigId)}/end`, serverUrl), {
          method: 'POST',
          headers,
          ...(body ? { body: JSON.stringify(body) } : {})
        });

        const text = await res.text();
        if (!res.ok) {
          ctx.io.stderr.write(text.trimEnd() + '\n');
          ctx.deps.exit(1);
          return;
        }

        const parsed = JSON.parse(text);
        await writeJson(ctx.io.stdout, parsed, { pretty: options.pretty === true });
        ctx.deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(ctx.deps, error);
        ctx.deps.exit(1);
      }
    });
}
