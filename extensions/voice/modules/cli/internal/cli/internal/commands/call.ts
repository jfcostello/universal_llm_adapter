import fs from 'fs';

import type { Command } from 'commander';

import type { VoiceCliCommandContext } from '../types.js';
import {
  parseJsonOrThrow,
  readOptionalJsonObject,
  readOptionalNumber,
  readOptionalSystemPrompt,
  readRequiredTrimmed,
  writeJson,
  writeStructuredError
} from '../utils.js';

export function registerCallCommand(program: Command, ctx: VoiceCliCommandContext): void {
  program
    .command('call')
    .description('Create an outbound voice call (server-side)')
    .option('--server-url <url>', 'Base URL of a running adapter server (e.g. http://127.0.0.1:3000)')
    .option('--api-key <key>', 'API key for server auth (sent as x-api-key by default)')
    .option('--api-key-header-name <name>', 'Header name for api key (default: x-api-key)', 'x-api-key')
    .option('--idempotency-key <key>', 'Optional idempotency key (sent as Idempotency-Key header)')
    .option('--ttl-seconds <seconds>', 'TTL for stored call config', (v) => Number(v))
    .option('--to <number>', 'Destination phone number')
    .option('--from <number>', 'Caller ID / from number')
    .option('--voice-provider <id>', 'Voice provider id (server plugin)')
    .option('--system-prompt <text>', 'System prompt text')
    .option('--system-prompt-file <path>', 'Path to a system prompt file')
    .option('--metadata <json>', 'Metadata JSON object (stored on the call config)')
    .option('--metadata-file <path>', 'Path to metadata JSON file')
    .option('--provider-config <json>', 'Provider config JSON object (stored on the call config)')
    .option('--provider-config-file <path>', 'Path to provider config JSON file')
    .option('--request-id <id>', 'Optional request id (sent as x-request-id and stored on the call config)')
    .option('--realtime-spec <json>', 'Realtime session spec as JSON string')
    .option('--realtime-spec-file <path>', 'Path to realtime session spec JSON file')
    .option('--assistant-first-turn <json>', 'assistantFirstTurn JSON object')
    .option('--assistant-first-turn-file <path>', 'Path to assistantFirstTurn JSON file')
    .option('--timeouts <json>', 'timeouts JSON object')
    .option('--timeouts-file <path>', 'Path to timeouts JSON file')
    .option('--recording <json>', 'recording JSON object')
    .option('--recording-file <path>', 'Path to recording JSON file')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        const serverUrl = readRequiredTrimmed(options.serverUrl, 'serverUrl');
        const to = readRequiredTrimmed(options.to, 'to');
        const from = readRequiredTrimmed(options.from, 'from');
        const voiceProvider = readRequiredTrimmed(options.voiceProvider, 'voiceProvider');

        const realtimeSpec = (() => {
          if (options.realtimeSpecFile) {
            const filePath = String(options.realtimeSpecFile);
            const raw = fs.readFileSync(filePath, 'utf-8');
            return parseJsonOrThrow(raw, `in file '${filePath}'`);
          }
          if (options.realtimeSpec) {
            return parseJsonOrThrow(String(options.realtimeSpec), 'in --realtime-spec');
          }
          const err = new Error('Missing realtimeSpec (expected --realtime-spec or --realtime-spec-file)');
          (err as any).statusCode = 400;
          (err as any).code = 'validation_error';
          throw err;
        })();

        const systemPrompt = await readOptionalSystemPrompt({
          systemPrompt: options.systemPrompt,
          systemPromptFile: options.systemPromptFile,
          stdin: ctx.io.stdin
        });

        const metadata = readOptionalJsonObject({ json: options.metadata, jsonFile: options.metadataFile, context: '--metadata' });
        const providerConfig = readOptionalJsonObject({
          json: options.providerConfig,
          jsonFile: options.providerConfigFile,
          context: '--provider-config'
        });
        const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
        const assistantFirstTurn = readOptionalJsonObject({
          json: options.assistantFirstTurn,
          jsonFile: options.assistantFirstTurnFile,
          context: '--assistant-first-turn'
        });
        const timeouts = readOptionalJsonObject({ json: options.timeouts, jsonFile: options.timeoutsFile, context: '--timeouts' });
        const recording = readOptionalJsonObject({ json: options.recording, jsonFile: options.recordingFile, context: '--recording' });

        const ttlSeconds = readOptionalNumber(options.ttlSeconds) ?? 900;

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
        const apiKeyHeaderName = String(options.apiKeyHeaderName).trim();
        if (apiKey) {
          headers[apiKeyHeaderName] = apiKey;
        }

        const idempotencyKey = typeof options.idempotencyKey === 'string' ? options.idempotencyKey.trim() : '';
        if (idempotencyKey) {
          headers['Idempotency-Key'] = idempotencyKey;
        }

        if (requestId) {
          headers['x-request-id'] = requestId;
        }

        const body = {
          to,
          from,
          voiceProvider,
          realtimeSpec,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(providerConfig !== undefined ? { providerConfig } : {}),
          ...(assistantFirstTurn !== undefined ? { assistantFirstTurn } : {}),
          ...(timeouts !== undefined ? { timeouts } : {}),
          ...(recording !== undefined ? { recording } : {}),
          ttlSeconds
        };

        const res = await fetch(new URL('/voice/calls', serverUrl), {
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
