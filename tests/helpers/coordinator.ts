import { PluginRegistry } from '@/kernel/index.ts';
import { LLMCoordinator } from '@/modules/llm/index.ts';
import { VectorStoreManager } from '@/modules/vector/index.ts';
import { createLoggingDeps } from '@/modules/logging/index.ts';
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
    vectorManager: options.vectorManager,
    logging: createLoggingDeps()
  });
}
