import { getDefaults } from '../../../kernel/index.js';

import type { PluginRegistryLike } from '../../lifecycle/index.js';
import type { ServerDependencies } from './server-types.js';

/**
 * Default dependencies using shared factory functions.
 * This ensures CLI and server use identical coordinator creation logic.
 * All imports are dynamic to preserve lazy loading.
 */
export const defaultDependencies: ServerDependencies = {
  getDefaults,
  createRegistry: async (pluginsPath: string) => {
    const { createRegistry } = await import('../../lifecycle/index.js');
    return createRegistry(pluginsPath);
  },
  createCoordinator: async (registry: PluginRegistryLike) => {
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
  createRealtimeSession: async (registry: PluginRegistryLike, spec: any) => {
    const { createRealtimeSession } = await import('../../realtime/index.js');
    return createRealtimeSession(registry as any, spec as any);
  },
  closeLogger: async () => {
    const { closeLogger } = await import('../../lifecycle/index.js');
    return closeLogger();
  }
};
