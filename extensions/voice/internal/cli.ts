import fs from 'fs';

import { Command } from 'commander';

import { mapErrorToHttp } from '../../../modules/transport/index.js';

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
    const error = new Error(`Invalid JSON ${context}`);
    (error as any).statusCode = 400;
    (error as any).code = 'invalid_json';
    throw error;
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
    const err = new Error(`Missing ${field}`);
    (err as any).statusCode = 400;
    (err as any).code = 'validation_error';
    throw err;
  }
  return s;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
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
    .option('--realtime-spec <json>', 'Realtime session spec as JSON string')
    .option('--realtime-spec-file <path>', 'Path to realtime session spec JSON file')
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

        const body = {
          to,
          from,
          voiceProvider,
          realtimeSpec,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
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

  try {
    await program.parseAsync(ctx.argv);
  } catch (error: any) {
    await writeStructuredError(deps, error);
    deps.exit(1);
  }
}
