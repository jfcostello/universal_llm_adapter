/**
 * Unified CLI for LLM Adapter.
 *
 * This module provides a single CLI that handles all operations:
 * - LLM run/stream (mirrors server /run and /stream)
 * - Vector run/stream (mirrors server /vector/run and /vector/stream)
 * - Embeddings run (mirrors server /embeddings/run)
 * - Server start (serve command)
 *
 * IMPORTANT: All imports except 'commander' are dynamic to ensure lazy loading.
 * Running `llm-adapter --help` should ONLY load commander, nothing else.
 */

import { Command } from 'commander';
import type { ServerOptions, RunningServer } from '../../server/index.js';
import type { LLMCallSpec, LLMStreamEvent, VectorCallSpec, VectorStreamEvent, EmbeddingCallSpec } from '../../kernel/index.js';
import type { FactoryPluginRegistryLike as PluginRegistryLike, LLMCoordinatorLike, VectorCoordinatorLike, EmbeddingCoordinatorLike } from '../../lifecycle/index.js';

export interface UnifiedCliDependencies {
  createRegistry: (pluginsPath: string) => PromiseLike<PluginRegistryLike> | PluginRegistryLike;
  createLlmCoordinator: (registry: PluginRegistryLike) => PromiseLike<LLMCoordinatorLike> | LLMCoordinatorLike;
  createVectorCoordinator: (registry: PluginRegistryLike) => PromiseLike<VectorCoordinatorLike> | VectorCoordinatorLike;
  createEmbeddingCoordinator: (registry: PluginRegistryLike) => PromiseLike<EmbeddingCoordinatorLike> | EmbeddingCoordinatorLike;
  createServer?: (options: ServerOptions) => PromiseLike<RunningServer> | RunningServer;
  createRealtimeSession?: (registry: PluginRegistryLike, spec: any) => PromiseLike<any> | any;
  getRealtimeStdio: () => {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
  closeLogger: () => Promise<void>;
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
}

/**
 * Default dependencies that lazy-load all modules.
 * This ensures --help only loads commander.
 * Exported for testing purposes.
 */
export const defaultDependencies: UnifiedCliDependencies = {
  createRegistry: async (pluginsPath: string) => {
    const { createRegistry } = await import('../../lifecycle/index.js');
    return createRegistry(pluginsPath);
  },
  createLlmCoordinator: async (registry: PluginRegistryLike) => {
    const { createLlmCoordinator } = await import('../../lifecycle/index.js');
    return createLlmCoordinator(registry);
  },
  createVectorCoordinator: async (registry: PluginRegistryLike) => {
    const { createVectorCoordinator } = await import('../../lifecycle/index.js');
    return createVectorCoordinator(registry);
  },
  createEmbeddingCoordinator: async (registry: PluginRegistryLike) => {
    const { createEmbeddingCoordinator } = await import('../../lifecycle/index.js');
    return createEmbeddingCoordinator(registry);
  },
  createServer: async (options: ServerOptions) => {
    const { createServer } = await import('../../server/index.js');
    return createServer(options);
  },
  getRealtimeStdio: () => ({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  }),
  closeLogger: async () => {
    const { closeLogger } = await import('../../lifecycle/index.js');
    return closeLogger();
  },
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
  exit: (code: number) => process.exit(code)
};

/**
 * Creates the unified CLI program.
 * @param partialDeps - Optional partial dependencies for testing
 * @returns Commander program instance
 */
export function createUnifiedProgram(
  partialDeps: Partial<UnifiedCliDependencies> = {}
): Command {
  const deps: UnifiedCliDependencies = { ...defaultDependencies, ...partialDeps };
  const program = new Command();

  program
    .name('llm-adapter')
    .description('LLM Adapter CLI - Unified interface for LLM, Vector, and Embedding operations')
    .version('1.0.0');

  // ==================== LLM Commands ====================

  program
    .command('run')
    .description('Execute a non-streaming LLM call')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        // Lazy load spec-loader only when command runs
        const { loadSpec } = await import('./spec-loader.js');
        const { writeJsonToStdout } = await import('./stdout-writer.js');
        const { runWithCoordinatorLifecycle } = await import('../../lifecycle/index.js');

        const spec = await loadSpec<LLMCallSpec>(options);
        const response = await runWithCoordinatorLifecycle<LLMCallSpec, PluginRegistryLike, LLMCoordinatorLike, unknown>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createLlmCoordinator,
            closeLogger: deps.closeLogger
          },
          run: (coordinator, s) => coordinator.run(s)
        });

        const wrappedResponse = { type: 'response', data: response };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
        deps.exit(0);
      } catch (error: any) {
        deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
        deps.exit(1);
      }
    });

  program
    .command('stream')
    .description('Execute a streaming LLM call')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .action(async (options) => {
      try {
        const { loadSpec } = await import('./spec-loader.js');
        const { streamWithCoordinatorLifecycle } = await import('../../lifecycle/index.js');

        const spec = await loadSpec<LLMCallSpec>(options);
        for await (const event of streamWithCoordinatorLifecycle<LLMCallSpec, PluginRegistryLike, LLMCoordinatorLike, LLMStreamEvent>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createLlmCoordinator,
            closeLogger: deps.closeLogger
          },
          stream: (coordinator, s) => coordinator.runStream(s) as AsyncIterable<LLMStreamEvent>
        })) {
          deps.log(JSON.stringify(event));
        }
        deps.exit(0);
      } catch (error: any) {
        deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
        deps.exit(1);
      }
    });

  // ==================== Vector Commands ====================

  const vector = program
    .command('vector')
    .description('Vector store operations');

  // Helper for vector run/stream
  const handleVectorCommand = async (
    options: any,
    streaming: boolean,
    deps: UnifiedCliDependencies
  ) => {
    try {
      const { loadSpec } = await import('./spec-loader.js');
      const { writeJsonToStdout } = await import('./stdout-writer.js');
      const { runWithCoordinatorLifecycle, streamWithCoordinatorLifecycle } = await import('../../lifecycle/index.js');

      const spec = await loadSpec<VectorCallSpec>(options);

      if (streaming) {
        for await (const event of streamWithCoordinatorLifecycle<VectorCallSpec, PluginRegistryLike, VectorCoordinatorLike, VectorStreamEvent>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createVectorCoordinator,
            closeLogger: deps.closeLogger
          },
          stream: (coordinator, s) => coordinator.executeStream(s) as AsyncIterable<VectorStreamEvent>
        })) {
          deps.log(JSON.stringify(event));
        }
      } else {
        const result = await runWithCoordinatorLifecycle<VectorCallSpec, PluginRegistryLike, VectorCoordinatorLike, unknown>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createVectorCoordinator,
            closeLogger: deps.closeLogger
          },
          run: (coordinator, s) => coordinator.execute(s)
        });
        const wrappedResponse = { type: 'response', data: result };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
      }
      deps.exit(0);
    } catch (error: any) {
      deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
      deps.exit(1);
    }
  };

  vector
    .command('run')
    .description('Execute a non-streaming vector operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      await handleVectorCommand(options, false, deps);
    });

  vector
    .command('stream')
    .description('Execute a streaming vector operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .action(async (options) => {
      await handleVectorCommand(options, true, deps);
    });

  // Convenience commands (CLI-only shortcuts)
  const addVectorConvenienceCommand = (name: string, description: string, supportsStream: boolean = false) => {
    const cmd = vector
      .command(name)
      .description(description)
      .option('-f, --file <path>', 'Path to spec JSON file')
      .option('-s, --spec <json>', 'Spec as JSON string')
      .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
      .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
      .option('--pretty', 'Pretty print output');

    if (supportsStream) {
      cmd.option('--stream', 'Stream progress events');
    }

    cmd.action(async (options) => {
      await handleVectorCommand(options, options.stream === true, deps);
    });
  };

  addVectorConvenienceCommand('query', 'Query a vector store');
  addVectorConvenienceCommand('upsert', 'Upsert vectors to a store');
  addVectorConvenienceCommand('embed', 'Embed texts and upsert to a vector store', true);
  addVectorConvenienceCommand('delete', 'Delete vectors by ID');
  addVectorConvenienceCommand('collections', 'Manage collections (list, create, delete, exists)');

  // ==================== Embeddings Commands ====================

  const embeddings = program
    .command('embeddings')
    .description('Embedding operations');

  embeddings
    .command('run')
    .description('Execute an embedding operation')
    .option('-f, --file <path>', 'Path to spec JSON file')
    .option('-s, --spec <json>', 'Spec as JSON string')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--pretty', 'Pretty print output')
    .action(async (options) => {
      try {
        const { loadSpec } = await import('./spec-loader.js');
        const { writeJsonToStdout } = await import('./stdout-writer.js');
        const { runWithCoordinatorLifecycle } = await import('../../lifecycle/index.js');

        const spec = await loadSpec<EmbeddingCallSpec>(options);
        const result = await runWithCoordinatorLifecycle<EmbeddingCallSpec, PluginRegistryLike, EmbeddingCoordinatorLike, unknown>({
          spec,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createEmbeddingCoordinator,
            closeLogger: deps.closeLogger
          },
          run: (coordinator, s) => coordinator.execute(s)
        });

        const wrappedResponse = { type: 'response', data: result };
        await writeJsonToStdout(wrappedResponse, { pretty: options.pretty });
        deps.exit(0);
      } catch (error: any) {
        deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
        deps.exit(1);
      }
    });

  // ==================== Serve Command ====================

  const parseNumber = (value: string): number => {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid number: ${value}`);
    }
    return parsed;
  };

  program
    .command('serve')
    .description('Start the HTTP/SSE server')
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--port <port>', 'Port to listen on (0 = ephemeral)', parseNumber)
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .option('--batch-id <id>', 'Optional batch identifier for grouped logging')
    .option('--max-request-bytes <bytes>', 'Maximum JSON body size', parseNumber)
    .option('--body-read-timeout-ms <ms>', 'Timeout while reading request body', parseNumber)
    .option('--request-timeout-ms <ms>', 'Total request timeout (0 = disabled)', parseNumber)
    .option('--stream-idle-timeout-ms <ms>', 'Max idle gap between SSE events', parseNumber)
    .option('--max-concurrent-requests <n>', 'Concurrent /run executions', parseNumber)
    .option('--max-concurrent-streams <n>', 'Concurrent /stream executions', parseNumber)
    .option('--max-queue-size <n>', 'Queued requests per limiter', parseNumber)
    .option('--queue-timeout-ms <ms>', 'Max time a request waits in queue', parseNumber)
    .option('--max-concurrent-vector-requests <n>', 'Concurrent /vector/run executions', parseNumber)
    .option('--max-concurrent-vector-streams <n>', 'Concurrent /vector/stream executions', parseNumber)
    .option('--vector-max-queue-size <n>', 'Queued vector requests per limiter', parseNumber)
    .option('--vector-queue-timeout-ms <ms>', 'Max time a vector request waits in queue', parseNumber)
    .option('--max-concurrent-embedding-requests <n>', 'Concurrent /embeddings/run executions', parseNumber)
    .option('--embedding-max-queue-size <n>', 'Queued embedding requests per limiter', parseNumber)
    .option('--embedding-queue-timeout-ms <ms>', 'Max time an embedding request waits in queue', parseNumber)
    .option('--realtime-enabled', 'Enable realtime WebSocket endpoint')
    .option('--realtime-ws-path <path>', 'WebSocket path for realtime sessions')
    .option('--realtime-max-ws-message-bytes <bytes>', 'Maximum realtime WebSocket message size', parseNumber)
    .option('--realtime-ws-idle-timeout-ms <ms>', 'Realtime WebSocket idle timeout', parseNumber)
    .option('--auth-enabled', 'Enable API key/token auth')
    .option('--no-auth-allow-bearer', 'Disable Authorization: Bearer header support')
    .option('--no-auth-allow-api-key-header', 'Disable API key header support')
    .option('--auth-header-name <name>', 'API key header name')
    .option('--auth-realm <realm>', 'WWW-Authenticate realm')
    .option('--rate-limit-enabled', 'Enable in-memory rate limiting')
    .option('--rate-limit-requests-per-minute <n>', 'Allowed requests per minute per client', parseNumber)
    .option('--rate-limit-burst <n>', 'Burst capacity for rate limiter', parseNumber)
    .option('--rate-limit-trust-proxy-headers', 'Trust x-forwarded-for for rate limiting')
    .option('--cors-enabled', 'Enable CORS headers and OPTIONS preflight')
    .option('--no-security-headers-enabled', 'Disable default security headers')
    .action(async (options, command) => {
      try {
        const rawArgs = command.parent?.rawArgs as unknown as string[];
        const serverOptions: ServerOptions = {
          host: options.host,
          port: options.port,
          pluginsPath: options.plugins,
          batchId: options.batchId,
          maxRequestBytes: options.maxRequestBytes,
          bodyReadTimeoutMs: options.bodyReadTimeoutMs,
          requestTimeoutMs: options.requestTimeoutMs,
          streamIdleTimeoutMs: options.streamIdleTimeoutMs,
          maxConcurrentRequests: options.maxConcurrentRequests,
          maxConcurrentStreams: options.maxConcurrentStreams,
          maxQueueSize: options.maxQueueSize,
          queueTimeoutMs: options.queueTimeoutMs,
          maxConcurrentVectorRequests: options.maxConcurrentVectorRequests,
          maxConcurrentVectorStreams: options.maxConcurrentVectorStreams,
          vectorMaxQueueSize: options.vectorMaxQueueSize,
          vectorQueueTimeoutMs: options.vectorQueueTimeoutMs,
          maxConcurrentEmbeddingRequests: options.maxConcurrentEmbeddingRequests,
          embeddingMaxQueueSize: options.embeddingMaxQueueSize,
          embeddingQueueTimeoutMs: options.embeddingQueueTimeoutMs
        };

        // Parse auth options only if any auth arg was provided
        const authArgProvided = rawArgs?.some(arg => arg.startsWith('--auth-'));
        if (authArgProvided) {
          const auth: any = {};
          if (rawArgs.includes('--auth-enabled')) auth.enabled = true;
          if (
            rawArgs.includes('--auth-allow-bearer') ||
            rawArgs.includes('--no-auth-allow-bearer')
          ) {
            auth.allowBearer = options.authAllowBearer;
          }
          if (
            rawArgs.includes('--auth-allow-api-key-header') ||
            rawArgs.includes('--no-auth-allow-api-key-header')
          ) {
            auth.allowApiKeyHeader = options.authAllowApiKeyHeader;
          }
          if (options.authHeaderName) auth.headerName = options.authHeaderName;
          if (options.authRealm) auth.realm = options.authRealm;
          serverOptions.auth = auth;
        }

        // Parse rate limit options only if any rate-limit arg was provided
        const rateLimitArgProvided = rawArgs?.some(arg => arg.startsWith('--rate-limit-'));
        if (rateLimitArgProvided) {
          const rateLimit: any = {};
          if (rawArgs.includes('--rate-limit-enabled')) rateLimit.enabled = true;
          if (options.rateLimitRequestsPerMinute !== undefined) {
            rateLimit.requestsPerMinute = options.rateLimitRequestsPerMinute;
          }
          if (options.rateLimitBurst !== undefined) {
            rateLimit.burst = options.rateLimitBurst;
          }
          if (rawArgs.includes('--rate-limit-trust-proxy-headers')) {
            rateLimit.trustProxyHeaders = true;
          }
          serverOptions.rateLimit = rateLimit;
        }

        // Parse CORS options
        if (rawArgs?.includes('--cors-enabled')) {
          serverOptions.cors = { enabled: true };
        }

        const realtimeArgProvided = rawArgs?.some(arg => arg.startsWith('--realtime-'));
        if (realtimeArgProvided) {
          serverOptions.realtime = {
            enabled: rawArgs.includes('--realtime-enabled'),
            wsPath: options.realtimeWsPath,
            maxWsMessageBytes: options.realtimeMaxWsMessageBytes,
            wsIdleTimeoutMs: options.realtimeWsIdleTimeoutMs
          };
        }

        // Parse security headers options
        if (
          rawArgs?.includes('--security-headers-enabled') ||
          rawArgs?.includes('--no-security-headers-enabled')
        ) {
          serverOptions.securityHeadersEnabled = options.securityHeadersEnabled;
        }

        if (!deps.createServer) {
          throw new Error('createServer dependency missing');
        }
        const running = await deps.createServer(serverOptions);

        deps.log(`Server listening at ${running.url}`);

        let shuttingDown = false;
        const shutdown = async () => {
          if (shuttingDown) return;
          shuttingDown = true;
          try {
            await running.close();
          } finally {
            deps.exit(0);
          }
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (error: any) {
        deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
        deps.exit(1);
      }
    });

  // ==================== Realtime Command ====================

  type RealtimeClientMessage =
    | { type: 'open'; protocolVersion: 1; spec: any }
    | { type: 'send_text'; text: string; role?: 'system' | 'user' }
    | { type: 'send_audio'; frame: { format: string; sampleRateHz: number; channels: 1 | 2; dataBase64: string; timestampMs?: number } }
    | { type: 'commit' }
    | { type: 'interrupt'; reason?: string }
    | { type: 'close' };

  type RealtimeServerEnvelope =
    | { type: 'event'; event: any }
    | { type: 'error'; error: { message: string; code?: string } };

  const writeEnvelope = (stdout: NodeJS.WritableStream, env: RealtimeServerEnvelope) => {
    stdout.write(`${JSON.stringify(env)}\n`);
  };

  program
    .command('realtime')
    .description('Realtime session over stdin/stdout JSON protocol')
    .option('-p, --plugins <path>', 'Path to plugins directory', './plugins')
    .action(async (options) => {
      const { stdin, stdout, stderr } = deps.getRealtimeStdio();

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
                if (!deps.createRealtimeSession) {
                  fail('Realtime session factory unavailable', 'realtime_unavailable');
                  break;
                }
                registry = await deps.createRegistry(options.plugins);
                if (typeof (registry as any).loadAll === 'function') {
                  await (registry as any).loadAll();
                }
                session = await deps.createRealtimeSession(registry, msg.spec);
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

        await eventsTask;
        deps.exit(exitCode);
      } catch (error: any) {
        writeEnvelope(stdout, { type: 'error', error: { message: error?.message ?? String(error) } });
        deps.exit(1);
      }
    });

  return program;
}

/**
 * Runs the unified CLI with the provided arguments.
 * @param argv - Command line arguments (defaults to process.argv)
 */
export async function runUnifiedCli(argv: string[] = process.argv): Promise<void> {
  const program = createUnifiedProgram();
  await program.parseAsync(argv);
}
