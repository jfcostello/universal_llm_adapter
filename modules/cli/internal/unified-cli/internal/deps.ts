import type { LLMCallSpec, LLMStreamEvent, VectorCallSpec, VectorStreamEvent, EmbeddingCallSpec } from '../../../../../kernel/index.js';
import type { ServerOptions, RunningServer } from '../../../../server/index.js';
import type {
  EmbeddingCoordinatorLike,
  FactoryPluginRegistryLike as PluginRegistryLike,
  LLMCoordinatorLike,
  VectorCoordinatorLike
} from '../../../../lifecycle/index.js';
import { importCliExtension } from '../../import-cli-extension.js';

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
    const { createRegistry } = await import('../../../../lifecycle/index.js');
    return createRegistry(pluginsPath);
  },
  createLlmCoordinator: async (registry: PluginRegistryLike) => {
    const { createLlmCoordinator } = await import('../../../../lifecycle/index.js');
    return createLlmCoordinator(registry);
  },
  createVectorCoordinator: async (registry: PluginRegistryLike) => {
    const { createVectorCoordinator } = await import('../../../../lifecycle/index.js');
    return createVectorCoordinator(registry);
  },
  createEmbeddingCoordinator: async (registry: PluginRegistryLike) => {
    const { createEmbeddingCoordinator } = await import('../../../../lifecycle/index.js');
    return createEmbeddingCoordinator(registry);
  },
  createServer: async (options: ServerOptions) => {
    const { createServer } = await import('../../../../server/index.js');
    return createServer(options);
  },
  createRealtimeSession: async (registry: PluginRegistryLike, spec: any) => {
    const { createRealtimeSession } = await import('../../../../realtime/index.js');
    return createRealtimeSession(registry as any, spec as any);
  },
  getRealtimeStdio: () => ({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  }),
  closeLogger: async () => {
    const { closeLogger } = await import('../../../../lifecycle/index.js');
    return closeLogger();
  },
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
  exit: (code: number) => {
    process.exitCode = code;
  },
  importCliExtension
};

export type { LLMCallSpec, LLMStreamEvent, VectorCallSpec, VectorStreamEvent, EmbeddingCallSpec, PluginRegistryLike };
