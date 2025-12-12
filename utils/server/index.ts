import http from 'http';
import { AddressInfo } from 'net';
import { PluginRegistry } from '../../core/registry.js';
import { LLMCoordinator } from '../../coordinator/coordinator.js';
import { closeLogger } from '../../core/logging.js';
import type { LLMCallSpec, LLMStreamEvent } from '../../core/types.js';
import type {
  CoordinatorLifecycleDeps,
  PluginRegistryLike
} from '../coordinator-lifecycle/index.js';
import { createServerHandler } from './internal/handler.js';

export interface ServerDependencies
  extends CoordinatorLifecycleDeps<PluginRegistryLike, any> {
  createRegistry: (pluginsPath: string) => PromiseLike<PluginRegistryLike> | PluginRegistryLike;
  closeLogger: () => Promise<void>;
}

export interface ServerOptions {
  host?: string;
  port?: number;
  pluginsPath?: string;
  batchId?: string;
  closeLoggerAfterRequest?: boolean;
  deps?: Partial<ServerDependencies>;
  registry?: PluginRegistryLike;
}

export interface RunningServer {
  url: string;
  server: http.Server;
  close: () => Promise<void>;
}

const defaultDependencies: ServerDependencies = {
  createRegistry: (pluginsPath: string) => new PluginRegistry(pluginsPath),
  createCoordinator: (registry: PluginRegistryLike) =>
    new LLMCoordinator(registry as PluginRegistry),
  closeLogger
};

export function createServerHandlerWithDefaults(
  options: ServerOptions = {}
): http.RequestListener {
  const deps: ServerDependencies = { ...defaultDependencies, ...options.deps };
  if (!options.registry) {
    throw new Error('registry must be provided to createServerHandlerWithDefaults');
  }
  return createServerHandler({
    registry: options.registry,
    pluginsPath: options.pluginsPath ?? './plugins',
    batchId: options.batchId,
    closeLoggerAfterRequest: options.closeLoggerAfterRequest ?? false,
    deps
  });
}

export async function createServer(options: ServerOptions = {}): Promise<RunningServer> {
  const deps: ServerDependencies = { ...defaultDependencies, ...options.deps };
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const pluginsPath = options.pluginsPath ?? './plugins';

  const registry =
    options.registry ?? (await deps.createRegistry(pluginsPath));
  if (typeof (registry as any).loadAll === 'function') {
    await (registry as any).loadAll();
  }

  const handler = createServerHandler({
    registry,
    pluginsPath,
    batchId: options.batchId,
    closeLoggerAfterRequest: options.closeLoggerAfterRequest ?? false,
    deps
  });

  const server = http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(async (error) => {
          if (error) reject(error);
          else {
            await deps.closeLogger();
            resolve();
          }
        });
      })
  };
}

export type { LLMCallSpec, LLMStreamEvent };

