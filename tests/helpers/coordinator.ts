import { PluginRegistry } from '@/core/registry.ts';
import { LLMCoordinator } from '@/coordinator/coordinator.ts';
import { VectorStoreManager } from '@/managers/vector-store-manager.ts';
import { resolveFixture } from './paths.ts';

interface CreateCoordinatorOptions {
  vectorManager?: VectorStoreManager;
}

export async function createFixtureRegistry(): Promise<PluginRegistry> {
  const pluginsDir = resolveFixture('plugins', 'basic');
  const registry = new PluginRegistry(pluginsDir);
  await registry.loadAll();
  return registry;
}

export async function createFixtureCoordinator(
  options: CreateCoordinatorOptions = {}
): Promise<LLMCoordinator> {
  const registry = await createFixtureRegistry();
  return new LLMCoordinator(registry, {
    vectorManager: options.vectorManager
  });
}
