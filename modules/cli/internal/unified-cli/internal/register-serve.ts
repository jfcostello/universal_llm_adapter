import type { Command } from 'commander';

import type { ServerOptions } from '../../../../server/index.js';

import type { UnifiedCliContext } from './types.js';

export function registerServeCommand(program: Command, ctx: UnifiedCliContext): void {
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
    .option('--policy-documents-filepath-enabled', 'Allow documents with source.type=\"filepath\"')
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

        if (!ctx.deps.createServer) {
          throw new Error('createServer dependency missing');
        }
        const running = await ctx.deps.createServer(serverOptions);

        ctx.deps.log(`Server listening at ${running.url}`);

        let shuttingDown = false;
        const shutdown = async () => {
          if (shuttingDown) return;
          shuttingDown = true;
          try {
            await running.close();
          } finally {
            ctx.deps.exit(0);
          }
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (error: any) {
        await ctx.writeStructuredError(error);
        ctx.deps.exit(1);
      }
    });
}
