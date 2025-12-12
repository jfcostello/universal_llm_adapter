#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PluginRegistry } from './core/registry.js';
import { LLMCoordinator } from './coordinator/coordinator.js';
import { LLMCallSpec, LLMStreamEvent } from './core/types.js';
import { closeLogger } from './core/logging.js';
import { loadSpec, writeJsonToStdout } from './utils/cli/index.js';
import {
  runWithCoordinatorLifecycle,
  streamWithCoordinatorLifecycle
} from './utils/coordinator-lifecycle/index.js';
import type { ServerOptions, RunningServer } from './utils/server/index.js';

export interface CliDependencies {
  createRegistry: (pluginsPath: string) => PromiseLike<PluginRegistryLike> | PluginRegistryLike;
  createCoordinator: (registry: PluginRegistryLike) => PromiseLike<CoordinatorLike> | CoordinatorLike;
  createServer?: (options: ServerOptions) => PromiseLike<RunningServer> | RunningServer;
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
}

interface PluginRegistryLike {
  loadAll(): Promise<void>;
}

interface CoordinatorLike {
  run(spec: LLMCallSpec): Promise<unknown>;
  runStream(spec: LLMCallSpec): AsyncIterable<LLMStreamEvent>;
  close(): Promise<void>;
}

const defaultDependencies: CliDependencies = {
  createRegistry: (pluginsPath: string) => new PluginRegistry(pluginsPath),
  createCoordinator: (registry: PluginRegistryLike) => new LLMCoordinator(registry as PluginRegistry),
  createServer: async (options: ServerOptions) => {
    const module = await import('./utils/server/index.js');
    return module.createServer(options);
  },
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
  exit: (code: number) => process.exit(code)
};

export function createProgram(partialDeps: Partial<CliDependencies> = {}): Command {
  const deps: CliDependencies = { ...defaultDependencies, ...partialDeps };
  const program = new Command();

  program
    .name('llm-coordinator')
    .description('LLM Adapter CLI')
    .version('1.0.0');

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
        const spec = await loadSpec(options);
        const response = await runWithCoordinatorLifecycle<LLMCallSpec, any, any, unknown>({
          spec,
          pluginsPath: options.plugins ?? './plugins',
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createCoordinator,
            closeLogger
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
        const spec = await loadSpec(options);
        for await (const event of streamWithCoordinatorLifecycle<LLMCallSpec, any, any, LLMStreamEvent>({
          spec,
          pluginsPath: options.plugins ?? './plugins',
          batchId: options.batchId,
          closeLoggerAfter: true,
          deps: {
            createRegistry: deps.createRegistry,
            createCoordinator: deps.createCoordinator,
            closeLogger
          },
          stream: (coordinator, s) => coordinator.runStream(s)
        })) {
          deps.log(JSON.stringify(event));
        }
        deps.exit(0);
      } catch (error: any) {
        deps.error(JSON.stringify({ error: error?.message ?? String(error) }));
        deps.exit(1);
      }
    });

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
    .option('--auth-enabled', 'Enable API key/token auth')
    .option('--no-auth-allow-bearer', 'Disable Authorization: Bearer header support')
    .option('--no-auth-allow-api-key-header', 'Disable API key header support')
    .option('--auth-header-name <name>', 'API key header name')
    .option('--auth-realm <realm>', 'WWW-Authenticate realm')
    .option('--rate-limit-enabled', 'Enable in-memory rate limiting')
    .option(
      '--rate-limit-requests-per-minute <n>',
      'Allowed requests per minute per client',
      parseNumber
    )
    .option('--rate-limit-burst <n>', 'Burst capacity for rate limiter', parseNumber)
    .option(
      '--rate-limit-trust-proxy-headers',
      'Trust x-forwarded-for for rate limiting'
    )
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
          queueTimeoutMs: options.queueTimeoutMs
        };

        const authArgProvided = rawArgs.some(arg => arg.startsWith('--auth-'));
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

        const rateLimitArgProvided = rawArgs.some(arg => arg.startsWith('--rate-limit-'));
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

        if (rawArgs.includes('--cors-enabled')) {
          serverOptions.cors = { enabled: true };
        }

        if (
          rawArgs.includes('--security-headers-enabled') ||
          rawArgs.includes('--no-security-headers-enabled')
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

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

const isEntryPoint = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

export const __isEntryPoint = isEntryPoint;

if (isEntryPoint) {
  void runCli(process.argv);
}
