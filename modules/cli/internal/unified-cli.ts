/**
 * Unified CLI for LLM Adapter.
 *
 * This module provides a single CLI that handles all operations:
 * - LLM run/stream (mirrors server /run and /stream)
 * - Vector run/stream (mirrors server /vector/run and /vector/stream)
 * - Embeddings run (mirrors server /embeddings/run)
 * - Server start (serve command)
 *
 * IMPORTANT: All imports except 'commander' and Node built-ins are dynamic to ensure lazy loading.
 * Running `llm-adapter --help` should ONLY load commander + Node built-ins, nothing else.
 */

import fs from 'fs';
import { Command } from 'commander';
import { pathToFileURL } from 'url';
import type { ServerOptions, RunningServer } from '../../server/index.js';
import type { LLMCallSpec, LLMStreamEvent, VectorCallSpec, VectorStreamEvent, EmbeddingCallSpec } from '../../../kernel/index.js';
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
  importCliExtension: (specifier: string) => Promise<any>;
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
  createRealtimeSession: async (registry: PluginRegistryLike, spec: any) => {
    const { createRealtimeSession } = await import('../../realtime/index.js');
    return createRealtimeSession(registry as any, spec as any);
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
  // Avoid hard process exits so short-lived commands can finish best-effort
  // background work (e.g., observability shutdown flush) without hanging.
  exit: (code: number) => {
    process.exitCode = code;
  },
  importCliExtension: async (specifier: string) => import(specifier)
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

  const writeStructuredError = async (error: any) => {
    try {
      const { mapErrorToHttp } = await import('../../transport/index.js');
      const mapped = mapErrorToHttp(error, { redactServerErrors: false });
      deps.error(JSON.stringify(mapped.body));
      return;
    } catch {
      const message = error?.message ?? String(error);
      const code = error?.code ? String(error.code) : 'internal';
      deps.error(JSON.stringify({ type: 'error', error: { message, code } }));
    }
  };

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
        const { assertValidSpec } = await import('../../transport/index.js');

        const spec = await loadSpec<LLMCallSpec>(options);
        assertValidSpec(spec);
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
        await writeStructuredError(error);
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
        const { assertValidSpec } = await import('../../transport/index.js');

        const spec = await loadSpec<LLMCallSpec>(options);
        assertValidSpec(spec);
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
        await writeStructuredError(error);
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
      const { assertValidVectorSpec } = await import('../../transport/index.js');

      const spec = await loadSpec<VectorCallSpec>(options);
      assertValidVectorSpec(spec);

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
      await writeStructuredError(error);
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
        const { assertValidEmbeddingSpec } = await import('../../transport/index.js');

        const spec = await loadSpec<EmbeddingCallSpec>(options);
        assertValidEmbeddingSpec(spec);
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
        await writeStructuredError(error);
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

  const collectString = (value: string, previous: string[]): string[] => {
    const next = previous.slice();
    next.push(String(value));
    return next;
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
    .option('--realtime-open-handshake-timeout-ms <ms>', 'Realtime WebSocket open handshake timeout', parseNumber)
    .option('--realtime-max-concurrent-sessions <n>', 'Max concurrent realtime sessions', parseNumber)
    .option('--realtime-max-audio-bytes-per-second <bytes>', 'Max audio throughput per session (bytes/sec)', parseNumber)
    .option('--realtime-max-session-duration-ms <ms>', 'Max realtime session duration', parseNumber)
    .option('--auth-mode <mode>', 'Auth mode (none|apiKey|jwt|proxySigned)')
    .option('--no-auth-allow-bearer', 'Disable Authorization: Bearer header support')
    .option('--no-auth-allow-header', 'Disable auth header token support')
    .option('--auth-header-name <name>', 'API key header name')
    .option('--auth-realm <realm>', 'WWW-Authenticate realm')
    .option('--rate-limit-enabled', 'Enable in-memory rate limiting')
    .option('--rate-limit-requests-per-minute <n>', 'Allowed requests per minute per client', parseNumber)
    .option('--rate-limit-burst <n>', 'Burst capacity for rate limiter', parseNumber)
    .option('--rate-limit-trust-proxy-headers', 'Trust x-forwarded-for for rate limiting')
    .option('--rate-limit-max-keys <n>', 'Max distinct identities tracked in memory', parseNumber)
    .option('--rate-limit-key-ttl-ms <ms>', 'Optional per-identity TTL in ms (0 disables)', parseNumber)
    .option('--cors-enabled', 'Enable CORS headers and OPTIONS preflight')
    .option('--no-security-headers-enabled', 'Disable default security headers')
    .option('--http-headers-timeout-ms <ms>', 'Node server.headersTimeout in ms', parseNumber)
    .option('--http-request-timeout-ms <ms>', 'Node server.requestTimeout in ms', parseNumber)
    .option('--http-keep-alive-timeout-ms <ms>', 'Node server.keepAliveTimeout in ms', parseNumber)
    .option('--http-max-headers-count <n>', 'Node server.maxHeadersCount', parseNumber)
    .option('--policy-documents-filepath-enabled', 'Allow documents with source.type="filepath"')
    .option('--policy-documents-filepath-root <path>', 'Allowed root for filepath docs (repeatable)', collectString, [])
    .option('--extension <name>', 'Enable a server extension (repeatable)', collectString, [])
    .action(async (options, command) => {
      try {
        const rawArgs = (command.parent as any).rawArgs as string[];
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
        const authArgProvided = rawArgs.some(arg => arg.startsWith('--auth-') || arg.startsWith('--no-auth-'));
        if (authArgProvided) {
          const auth: any = {};
          if (options.authMode) auth.mode = String(options.authMode);
          if (!auth.mode) {
            throw new Error('Auth mode is required when specifying auth options (use --auth-mode)');
          }
          if (
            rawArgs.includes('--auth-allow-bearer') ||
            rawArgs.includes('--no-auth-allow-bearer')
          ) {
            auth.allowBearer = options.authAllowBearer;
          }
          if (
            rawArgs.includes('--auth-allow-header') ||
            rawArgs.includes('--no-auth-allow-header')
          ) {
            auth.allowHeader = options.authAllowHeader;
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
          if (options.rateLimitMaxKeys !== undefined) {
            rateLimit.maxKeys = options.rateLimitMaxKeys;
          }
          if (options.rateLimitKeyTtlMs !== undefined) {
            rateLimit.keyTtlMs = options.rateLimitKeyTtlMs;
          }
          serverOptions.rateLimit = rateLimit;
        }

        // Parse CORS options
        if (rawArgs?.includes('--cors-enabled')) {
          serverOptions.cors = { enabled: true };
        }

        // Parse policy options
        const policyArgProvided = rawArgs.some(arg => arg.startsWith('--policy-'));
        if (policyArgProvided) {
          const allowedRoots = (options.policyDocumentsFilepathRoot as any[])
            .map((v: any) => String(v))
            .filter(Boolean);

          if (
            rawArgs.includes('--policy-documents-filepath-enabled') ||
            allowedRoots.length > 0
          ) {
            serverOptions.policy = {
              documents: {
                filepath: {
                  enabled: true,
                  ...(allowedRoots.length > 0 ? { allowedRoots } : {})
                }
              }
            };
          }
        }

        const realtimeArgProvided = rawArgs?.some(arg => arg.startsWith('--realtime-'));
        if (realtimeArgProvided) {
          const realtime: any = {
            enabled: rawArgs.includes('--realtime-enabled')
          };
          if (options.realtimeWsPath !== undefined) realtime.wsPath = options.realtimeWsPath;
          if (options.realtimeMaxWsMessageBytes !== undefined) realtime.maxWsMessageBytes = options.realtimeMaxWsMessageBytes;
          if (options.realtimeWsIdleTimeoutMs !== undefined) realtime.wsIdleTimeoutMs = options.realtimeWsIdleTimeoutMs;
          if (options.realtimeOpenHandshakeTimeoutMs !== undefined) realtime.openHandshakeTimeoutMs = options.realtimeOpenHandshakeTimeoutMs;
          if (options.realtimeMaxConcurrentSessions !== undefined) realtime.maxConcurrentSessions = options.realtimeMaxConcurrentSessions;
          if (options.realtimeMaxAudioBytesPerSecond !== undefined) realtime.maxAudioBytesPerSecond = options.realtimeMaxAudioBytesPerSecond;
          if (options.realtimeMaxSessionDurationMs !== undefined) realtime.maxSessionDurationMs = options.realtimeMaxSessionDurationMs;
          serverOptions.realtime = realtime;
        }

        // Parse security headers options
        if (
          rawArgs?.includes('--security-headers-enabled') ||
          rawArgs?.includes('--no-security-headers-enabled')
        ) {
          serverOptions.securityHeadersEnabled = options.securityHeadersEnabled;
        }

        const httpArgProvided = rawArgs?.some(arg => arg.startsWith('--http-'));
        if (httpArgProvided) {
          if (options.httpHeadersTimeoutMs !== undefined) {
            serverOptions.httpHeadersTimeoutMs = options.httpHeadersTimeoutMs;
          }
          if (options.httpRequestTimeoutMs !== undefined) {
            serverOptions.httpRequestTimeoutMs = options.httpRequestTimeoutMs;
          }
          if (options.httpKeepAliveTimeoutMs !== undefined) {
            serverOptions.httpKeepAliveTimeoutMs = options.httpKeepAliveTimeoutMs;
          }
          if (options.httpMaxHeadersCount !== undefined) {
            serverOptions.httpMaxHeadersCount = options.httpMaxHeadersCount;
          }
        }

        if (Array.isArray(options.extension) && options.extension.length > 0) {
          serverOptions.extensions = { enabled: options.extension.map((v: any) => String(v)) };
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
        await writeStructuredError(error);
        deps.exit(1);
      }
    });

  // ==================== Realtime Command ====================

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
        const { loadSpec } = await import('./spec-loader.js');
        const { writeJsonToStdout } = await import('./stdout-writer.js');

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

        const registry = await deps.createRegistry(options.plugins);
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

        deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(error);
        deps.exit(1);
      }
    });

  realtime
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

        await eventsTask;
        deps.exit(exitCode);
      } catch (error: any) {
        writeEnvelope(stdout, { type: 'error', error: { message: error?.message ?? String(error) } });
        deps.exit(1);
      }
    });

  // ==================== Extension Commands ====================
  program
    .command('extensions')
    .description('Extension pack operations')
    .command('list')
    .description('List available extensions')
    .action(async () => {
      try {
        const { listExtensions } = await import('../../extensions/index.js');
        const { writeJsonToStdout } = await import('./stdout-writer.js');
        const results = listExtensions().map(item => ({
          name: item.name,
          kind: item.kind,
          root: item.root
        }));
        await writeJsonToStdout({ type: 'response', data: results });
        deps.exit(0);
      } catch (error: any) {
        await writeStructuredError(error);
        deps.exit(1);
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
        const { loadExtensionDefaults, resolveExtensionEntry } = await import('../../extensions/index.js');
        const resolved = resolveExtensionEntry(extName);

        if (!resolved) {
          deps.error(JSON.stringify({
            type: 'error',
            error: {
              message: `Extension '${extName}' not found. Run 'llm-adapter extensions list' to enumerate available extensions.`,
              code: 'extension_not_found'
            }
          }));
          deps.exit(1);
          return;
        }

        const importSpecifier =
          resolved.kind === 'builtin'
            ? `../../../extensions/${resolved.name}/index.js`
            : pathToFileURL(resolved.entryFilePath).href;

        const mod = await deps.importCliExtension(importSpecifier);
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
        await runCli({ argv, deps, config });
      } catch (error: any) {
        await writeStructuredError(error);
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
