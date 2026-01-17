import type { Command } from 'commander';

import type { PluginRegistryLike } from './deps.js';
import type { UnifiedCliContext } from './types.js';

type RealtimeClientMessage =
  | { type: 'open'; protocolVersion: 1; spec: any }
  | { type: 'send_text'; text: string; role?: 'system' | 'user' }
  | { type: 'send_audio'; frame: { format: string; sampleRateHz: number; channels: 1 | 2; dataBase64: string; timestampMs?: number } }
  | { type: 'inject_context'; items: any[] }
  | { type: 'commit' }
  | { type: 'interrupt'; reason?: string }
  | { type: 'close' };

type RealtimeServerEnvelope =
  | { type: 'event'; event: any }
  | { type: 'error'; error: { message: string; code?: string } };

const writeEnvelope = (stdout: NodeJS.WritableStream, env: RealtimeServerEnvelope) => {
  stdout.write(`${JSON.stringify(env)}\n`);
};

type RealtimeClientSecretRequest = {
  provider: string;
  model?: unknown;
  systemPrompt?: unknown;
  expiresAfterSeconds?: unknown;
};

export function registerRealtimeCommands(program: Command, ctx: UnifiedCliContext): void {
  const realtime = program
    .command('realtime')
    .description('Realtime session over stdin/stdout JSON protocol')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    ;

  realtime
    .command('client-secret')
    .description('Mint a short-lived realtime WebRTC client secret')
    .option('-f, --file <path>', 'Path to request JSON file')
    .option('-s, --spec <json>', 'Request as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        const { loadSpec } = await import('../../spec-loader.js');
        const { writeJsonToStdout } = await import('../../stdout-writer.js');

        const makeValidationError = (message: string) => {
          const err: any = new Error(message);
          err.statusCode = 400;
          err.code = 'validation_error';
          return err;
        };

        const makeNotImplementedError = (message: string) => {
          const err: any = new Error(message);
          err.statusCode = 501;
          err.code = 'not_implemented';
          return err;
        };

        const makeUpstreamError = (message: string) => {
          const err: any = new Error(message);
          err.statusCode = 502;
          err.code = 'upstream_error';
          return err;
        };

        const body = await loadSpec<RealtimeClientSecretRequest>(options);
        const providerId = String((body as any)?.provider ?? '').trim();
        const model = (body as any)?.model !== undefined ? String((body as any).model) : undefined;
        const systemPrompt =
          (body as any)?.systemPrompt !== undefined ? String((body as any).systemPrompt) : undefined;

        const expiresAfterSecondsRaw = (body as any)?.expiresAfterSeconds;
        const expiresAfterSeconds =
          expiresAfterSecondsRaw === undefined || expiresAfterSecondsRaw === null
            ? undefined
            : Number(expiresAfterSecondsRaw);

        const MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS = 30;
        const MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS = 600;

        if (!providerId) {
          throw makeValidationError('Missing provider');
        }

        if (expiresAfterSeconds !== undefined) {
          if (!Number.isFinite(expiresAfterSeconds)) {
            throw makeValidationError('Invalid expiresAfterSeconds');
          }
          if (!Number.isInteger(expiresAfterSeconds)) {
            throw makeValidationError('expiresAfterSeconds must be an integer');
          }
          if (
            expiresAfterSeconds < MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS ||
            expiresAfterSeconds > MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS
          ) {
            throw makeValidationError(
              `expiresAfterSeconds must be between ${MIN_CLIENT_SECRET_EXPIRES_AFTER_SECONDS} and ${MAX_CLIENT_SECRET_EXPIRES_AFTER_SECONDS}`
            );
          }
        }

        const registry = await ctx.deps.createRegistry(options.plugins);
        if (typeof (registry as any).loadAll === 'function') {
          await (registry as any).loadAll();
        }

        const reg = registry as any;
        if (typeof reg.getRealtimeProvider !== 'function' || typeof reg.getRealtimeCompat !== 'function') {
          throw makeNotImplementedError('Registry does not support realtime client-secret minting');
        }

        const provider = await reg.getRealtimeProvider(providerId);
        const compatKind = provider?.compat;
        if (!compatKind) {
          throw makeNotImplementedError(`Realtime client-secret minting not supported for provider '${providerId}'`);
        }

        const compat = await reg.getRealtimeCompat(compatKind);
        if (!compat || typeof compat.mintClientSecret !== 'function') {
          throw makeNotImplementedError(`Realtime client-secret minting not supported for provider '${providerId}'`);
        }

        const result = await compat.mintClientSecret({
          provider,
          spec: {
            provider: providerId,
            ...(model ? { model } : {}),
            ...(systemPrompt ? { systemPrompt } : {}),
            transport: { type: 'webrtc' }
          },
          ...(expiresAfterSeconds !== undefined ? { expiresAfterSeconds } : {})
        });

        const clientSecret = String(result?.clientSecret ?? '');
        if (!clientSecret) {
          throw makeUpstreamError('Realtime client secret response missing client secret value');
        }

        await writeJsonToStdout(
          {
            clientSecret,
            ...(result?.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {})
          },
          { pretty: options.pretty }
        );

        ctx.deps.exit(0);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
      }
    });

  realtime
    .action(async (options) => {
      const { stdin, stdout, stderr } = ctx.deps.getRealtimeStdio();

      try {
        const { createInterface } = await import('readline');
        const rl = createInterface({ input: stdin, crlfDelay: Infinity });

        let exitCode = 0;
        let registry: PluginRegistryLike | undefined;
        let session: any | undefined;
        let eventsTask: Promise<void> | undefined;
        let openSeen = false;

        const fail = (message: string, code?: string) => {
          exitCode = 1;
          writeEnvelope(stdout, { type: 'error', error: { message, ...(code ? { code } : {}) } });
          try { void session?.close?.(); } catch {}
          try { rl.close(); } catch {}
        };

        const ensureOpen = () => {
          if (!openSeen || !session) {
            throw new Error('Session not open (expected open first)');
          }
        };

        const startEventPump = async () => {
          const localSession = session as any;
          const iterator = (localSession.events?.() as AsyncIterable<any>)[Symbol.asyncIterator]();

          const first = await iterator.next();
          if (first.done) {
            fail('Realtime session closed before ready', 'closed_before_ready');
            return;
          }
          if (first.value?.type !== 'ready') {
            fail('Realtime session did not emit ready first', 'missing_ready');
            return;
          }
          writeEnvelope(stdout, { type: 'event', event: first.value });

          for await (const event of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<any>) {
            writeEnvelope(stdout, { type: 'event', event });
          }
        };

        inputLoop: for await (const line of rl as any) {
          const trimmed = String(line).trim();
          if (!trimmed) continue;

          let msg: RealtimeClientMessage;
          try {
            msg = JSON.parse(trimmed);
          } catch {
            fail('Invalid JSON message', 'invalid_json');
            break inputLoop;
          }

          try {
            switch (msg.type) {
              case 'open': {
                if (openSeen) {
                  fail('Session already open', 'already_open');
                  break;
                }
                if (msg.protocolVersion !== 1) {
                  fail('Unsupported protocolVersion', 'unsupported_protocol');
                  break;
                }
                if (!ctx.deps.createRealtimeSession) {
                  fail('Realtime session factory unavailable', 'realtime_unavailable');
                  break;
                }
                registry = await ctx.deps.createRegistry(options.plugins);
                if (typeof (registry as any).loadAll === 'function') {
                  await (registry as any).loadAll();
                }
                session = await ctx.deps.createRealtimeSession(registry, msg.spec);
                openSeen = true;
                eventsTask = startEventPump()
                  .catch(err => {
                    fail(err?.message ?? String(err), err?.code);
                  })
                  .finally(() => {
                    try { rl.close(); } catch {}
                  });
                break;
              }
              case 'send_text': {
                ensureOpen();
                await session.sendText({ text: msg.text, role: msg.role });
                break;
              }
              case 'send_audio': {
                ensureOpen();
                await session.sendAudio(msg.frame);
                break;
              }
              case 'inject_context': {
                ensureOpen();
                await session.injectContext(msg.items);
                break;
              }
              case 'commit': {
                ensureOpen();
                await session.commit();
                break;
              }
              case 'interrupt': {
                ensureOpen();
                await session.interrupt({ reason: msg.reason });
                break;
              }
              case 'close': {
                ensureOpen();
                await session.close();
                try { rl.close(); } catch {}
                break;
              }
              default: {
                fail('Unknown message type', 'unknown_type');
                break;
              }
            }
          } catch (err: any) {
            fail(err?.message ?? String(err), err?.code);
            break inputLoop;
          }
        }

        void stderr; // reserved for protocol extensions

        await eventsTask;
        ctx.deps.exit(exitCode);
      } catch (error: any) {
        writeEnvelope(stdout, { type: 'error', error: { message: error?.message ?? String(error) } });
        ctx.deps.exit(1);
      }
    });
}
