import type { Command } from 'commander';

import type { VoiceCliCommandContext } from '../types.js';
import { streamSseJsonLines } from '../sse.js';
import { readRequiredTrimmed, writeStructuredError } from '../utils.js';

export function registerEventsCommand(program: Command, ctx: VoiceCliCommandContext): void {
  program
    .command('events')
    .description('Stream voice call events (server-side SSE)')
    .option('--server-url <url>', 'Base URL of a running adapter server (e.g. http://127.0.0.1:3000)')
    .option('--api-key <key>', 'API key for server auth (sent as x-api-key by default)')
    .option('--api-key-header-name <name>', 'Header name for api key (default: x-api-key)', 'x-api-key')
    .option('--call-config-id <id>', 'Call config id to stream events for')
    .option('--include-deltas <0|1>', 'Include transcript deltas in the stream', (v) => String(v))
    .option('--event-types <csv>', 'Comma-separated allowlist of event types to include', (v) => String(v))
    .action(async (options) => {
      try {
        const serverUrl = readRequiredTrimmed(options.serverUrl, 'serverUrl');
        const callConfigId = readRequiredTrimmed(options.callConfigId, 'callConfigId');

        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
        const apiKeyHeaderName = String(options.apiKeyHeaderName).trim();
        if (apiKey) {
          headers[apiKeyHeaderName] = apiKey;
        }

        const url = new URL(`/voice/calls/${encodeURIComponent(callConfigId)}/events`, serverUrl);
        const includeDeltasRaw = typeof options.includeDeltas === 'string' ? options.includeDeltas.trim() : '';
        if (includeDeltasRaw === '0' || includeDeltasRaw === '1') {
          url.searchParams.set('includeDeltas', includeDeltasRaw);
        }
        const eventTypesRaw = typeof options.eventTypes === 'string' ? options.eventTypes.trim() : '';
        if (eventTypesRaw) {
          url.searchParams.set('eventTypes', eventTypesRaw);
        }

        const res = await fetch(url, { method: 'GET', headers });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          ctx.io.stderr.write(text.trimEnd() + '\n');
          ctx.deps.exit(1);
          return;
        }

        await streamSseJsonLines({
          res,
          onJson: async (value) => {
            await new Promise<void>(resolve => (ctx.io.stdout as any).write(JSON.stringify(value) + '\n', () => resolve()));
          }
        });

        ctx.deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(ctx.deps, error);
        ctx.deps.exit(1);
      }
    });
}
