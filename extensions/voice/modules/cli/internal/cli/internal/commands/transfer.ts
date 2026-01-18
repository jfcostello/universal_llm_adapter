import type { Command } from 'commander';

import {
  validateTransferMode,
  validateMaxWaitMs,
  validateCancelOnUserSpeechCli
} from '../../../../../graceful-mode-validation/index.js';

import type { VoiceCliCommandContext } from '../types.js';
import { readRequiredTrimmed, writeJson, writeStructuredError } from '../utils.js';

export function registerTransferCommand(program: Command, ctx: VoiceCliCommandContext): void {
  program
    .command('transfer')
    .description('Transfer a voice call to another number (server-side)')
    .option('--server-url <url>', 'Base URL of a running adapter server (e.g. http://127.0.0.1:3000)')
    .option('--api-key <key>', 'API key for server auth (sent as x-api-key by default)')
    .option('--api-key-header-name <name>', 'Header name for api key (default: x-api-key)', 'x-api-key')
    .option('--call-config-id <id>', 'Call config id to transfer')
    .option('--target-number <number>', 'Target phone number in E.164 format (+[country code][number])')
    .option('--caller-id <number>', 'Optional caller ID to show the target (E.164 format)')
    .option('--timeout <seconds>', 'Ring timeout in seconds (1-600, server default from voice config)')
    .option('--mode <mode>', 'Transfer mode (immediate|after_playback)')
    .option('--max-wait-ms <ms>', 'Max wait time (ms) for graceful transfer')
    .option('--cancel-on-user-speech <0|1>', 'Cancel graceful transfer when user speech starts (0|1)')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        const serverUrl = readRequiredTrimmed(options.serverUrl, 'serverUrl');
        const callConfigId = readRequiredTrimmed(options.callConfigId, 'callConfigId');
        const targetNumber = readRequiredTrimmed(options.targetNumber, 'targetNumber');

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
        const apiKeyHeaderName = String(options.apiKeyHeaderName).trim();
        if (apiKey) {
          headers[apiKeyHeaderName] = apiKey;
        }

        const body: Record<string, any> = { targetNumber };

        const callerIdRaw = typeof options.callerId === 'string' ? options.callerId.trim() : '';
        if (callerIdRaw) {
          body.callerId = callerIdRaw;
        }

        const timeoutRaw = typeof options.timeout === 'string' ? options.timeout.trim() : '';
        if (timeoutRaw) {
          const n = Number(timeoutRaw);
          const t = Math.floor(n);
          if (!Number.isFinite(n) || t < 1 || t > 600) {
            const err = new Error('Invalid timeout (must be 1-600 seconds)');
            (err as any).statusCode = 400;
            (err as any).code = 'validation_error';
            throw err;
          }
          body.timeout = t;
        }

        const modeRaw = typeof options.mode === 'string' ? options.mode.trim() : '';
        if (modeRaw) {
          body.mode = validateTransferMode(modeRaw, 'immediate');
        }

        const maxWaitMsRaw = typeof options.maxWaitMs === 'string' ? options.maxWaitMs.trim() : '';
        if (maxWaitMsRaw) {
          body.maxWaitMs = validateMaxWaitMs(maxWaitMsRaw, 0);
        }

        const cancelOnUserSpeech = validateCancelOnUserSpeechCli(options.cancelOnUserSpeech);
        if (cancelOnUserSpeech !== undefined) {
          body.cancelOnUserSpeech = cancelOnUserSpeech;
        }

        const res = await fetch(new URL(`/voice/calls/${encodeURIComponent(callConfigId)}/transfer`, serverUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
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
