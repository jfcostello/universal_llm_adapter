import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { Command } from 'commander';

import { makeHttpError, normalizeFlag } from '../../../../../modules/shared/index.js';
import { mapErrorToHttp } from '../../../../../modules/transport/index.js';

type VoiceCliDeps = {
  error: (message: string) => void;
  exit: (code: number) => void;
};

type VoiceCliIo = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

function parseJsonOrThrow(raw: string, context: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    throw makeHttpError({ message: `Invalid JSON ${context}`, statusCode: 400, code: 'invalid_json' });
  }
}

async function readAllUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  let input = '';
  stream.setEncoding('utf-8');
  for await (const chunk of stream) {
    input += chunk;
  }
  return input;
}

async function readOptionalSystemPrompt(options: {
  systemPrompt?: unknown;
  systemPromptFile?: unknown;
  stdin: NodeJS.ReadableStream;
}): Promise<string | undefined> {
  if (options.systemPrompt !== undefined) {
    const value = String(options.systemPrompt);
    return value;
  }

  if (options.systemPromptFile !== undefined) {
    const filePath = String(options.systemPromptFile);
    return fs.readFileSync(filePath, 'utf-8');
  }

  const stdinIsTty = Boolean((options.stdin as any)?.isTTY);
  if (stdinIsTty) return undefined;

  const value = await readAllUtf8(options.stdin);
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

function readRequiredTrimmed(value: unknown, field: string): string {
  const s = String(value ?? '').trim();
  if (!s) {
    throw makeHttpError({ message: `Missing ${field}`, statusCode: 400, code: 'validation_error' });
  }
  return s;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readOptionalJsonObject(options: {
  json?: unknown;
  jsonFile?: unknown;
  context: string;
}): any | undefined {
  if (options.jsonFile !== undefined) {
    const filePath = String(options.jsonFile);
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parseJsonOrThrow(raw, `in file '${filePath}'`);
  }
  if (options.json !== undefined) {
    return parseJsonOrThrow(String(options.json), `in ${options.context}`);
  }
  return undefined;
}

function normalizeSseLine(line: string): { field: string; value: string } | undefined {
  const idx = line.indexOf(':');
  if (idx === -1) return undefined;
  const field = line.slice(0, idx).trim();
  if (!field) return undefined;
  const value = line.slice(idx + 1).replace(/^\s/, '');
  return { field, value };
}

async function streamSseJsonLines(options: {
  res: Response;
  onJson: (value: any) => Promise<void> | void;
}): Promise<void> {
  const body = options.res.body;
  if (!body) return;

  const stream = Readable.fromWeb(body as any);
  stream.setEncoding('utf-8');

  let buffer = '';
  let dataLines: string[] = [];

  const flush = async () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    const parsed = JSON.parse(raw);
    await options.onJson(parsed);
  };

  for await (const chunk of stream) {
    buffer += String(chunk).replace(/\r/g, '');

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const lines = block.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        if (line.startsWith(':')) continue;
        const kv = normalizeSseLine(line);
        if (!kv) continue;
        if (kv.field === 'data') {
          dataLines.push(kv.value);
        }
      }
      await flush();
    }
  }

  // Flush trailing buffered event if stream ended without a final blank line.
  if (buffer.trim()) {
    const lines = buffer.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line.startsWith(':')) continue;
      const kv = normalizeSseLine(line);
      if (!kv) continue;
      if (kv.field === 'data') {
        dataLines.push(kv.value);
      }
    }
    await flush();
  }
}

async function writeJson(stdout: NodeJS.WritableStream, value: unknown, options: { pretty: boolean }) {
  const text = options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await new Promise<void>(resolve => (stdout as any).write(text + '\n', () => resolve()));
}

async function writeStructuredError(deps: VoiceCliDeps, error: any) {
  const mapped = mapErrorToHttp(error);
  deps.error(JSON.stringify(mapped.body));
}

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

  const program = new Command();
  program
    .name('llm-adapter voice')
    .description('Voice extension commands')
    .version('1.0.0');
  program.exitOverride();

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
          stdin: io.stdin
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
          io.stderr.write(text.trimEnd() + '\n');
          deps.exit(1);
          return;
        }

        const parsed = JSON.parse(text);
        await writeJson(io.stdout, parsed, { pretty: options.pretty === true });
        deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(deps, error);
        deps.exit(1);
      }
    });

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
            if (!['immediate', 'after_assistant_audio', 'after_playback'].includes(modeRaw)) {
              throw makeHttpError({ message: 'Invalid mode', statusCode: 400, code: 'validation_error' });
            }
            out.mode = modeRaw;
          }

          const maxWaitMsRaw = typeof options.maxWaitMs === 'string' ? options.maxWaitMs.trim() : '';
          if (maxWaitMsRaw) {
            const n = Number(maxWaitMsRaw);
            const ms = Math.floor(n);
            if (!Number.isFinite(n) || ms < 0) {
              throw makeHttpError({ message: 'Invalid maxWaitMs', statusCode: 400, code: 'validation_error' });
            }
            out.maxWaitMs = ms;
          }

          if (options.cancelOnUserSpeech !== undefined) {
            const raw = String(options.cancelOnUserSpeech).trim().toLowerCase();
            if (!raw) {
              // ignore
            } else if (
              ['true', '1', 'yes', 'y', 'on'].includes(raw) ||
              ['false', '0', 'no', 'n', 'off'].includes(raw)
            ) {
              out.cancelOnUserSpeech = normalizeFlag(raw, false);
            } else {
              throw makeHttpError({ message: 'Invalid cancelOnUserSpeech', statusCode: 400, code: 'validation_error' });
            }
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
          io.stderr.write(text.trimEnd() + '\n');
          deps.exit(1);
          return;
        }

        const parsed = JSON.parse(text);
        await writeJson(io.stdout, parsed, { pretty: options.pretty === true });
        deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(deps, error);
        deps.exit(1);
      }
    });

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
            throw makeHttpError({ message: 'Invalid timeout (must be 1-600 seconds)', statusCode: 400, code: 'validation_error' });
          }
          body.timeout = t;
        }

        const res = await fetch(new URL(`/voice/calls/${encodeURIComponent(callConfigId)}/transfer`, serverUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });

        const text = await res.text();
        if (!res.ok) {
          io.stderr.write(text.trimEnd() + '\n');
          deps.exit(1);
          return;
        }

        const parsed = JSON.parse(text);
        await writeJson(io.stdout, parsed, { pretty: options.pretty === true });
        deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(deps, error);
        deps.exit(1);
      }
    });

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
          io.stderr.write(text.trimEnd() + '\n');
          deps.exit(1);
          return;
        }

        await streamSseJsonLines({
          res,
          onJson: async (value) => {
            await new Promise<void>(resolve => (io.stdout as any).write(JSON.stringify(value) + '\n', () => resolve()));
          }
        });

        deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(deps, error);
        deps.exit(1);
      }
    });

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
          io.stderr.write(text.trimEnd() + '\n');
          deps.exit(1);
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
            await pipeline(stream, io.stdout as any);
          }
        }

        deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(deps, error);
        deps.exit(1);
      }
    });

  try {
    await program.parseAsync(ctx.argv);
  } catch (error: any) {
    await writeStructuredError(deps, error);
    deps.exit(1);
  }
}
