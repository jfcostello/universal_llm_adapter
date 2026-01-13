/**
 * Shared factory functions for creating registries and coordinators.
 * Used by both CLI and server to ensure consistent defaults.
 * All imports are dynamic to preserve lazy loading.
 */

import type { PluginRegistry } from '../../../kernel/index.js';

/**
 * Registry-like interface for type safety without forcing an import.
 */
export interface PluginRegistryLike {
  loadAll?(): Promise<void>;
}

const DEFAULT_PLUGINS_PATH = './plugins';

export function resolveEffectivePluginsPath(options: { pluginsPath: string; configuredPluginsPath?: string }): string {
  const pluginsPath = options.pluginsPath.trim() || DEFAULT_PLUGINS_PATH;

  // Commander defaults make it hard to tell whether a value was explicitly provided.
  // Treat `./plugins` as the default and allow llm-adapter.paths.json to override it.
  if (pluginsPath === DEFAULT_PLUGINS_PATH) {
    const configured = (options.configuredPluginsPath ?? '').trim();
    if (configured) return configured;
  }

  return pluginsPath;
}

/**
 * Creates a PluginRegistry instance.
 * Uses dynamic import to preserve lazy loading.
 */
export async function createRegistry(pluginsPath: string): Promise<PluginRegistryLike> {
  const { PluginRegistry, getAdapterPathsConfig } = await import('../../../kernel/index.js');

  const pathsConfig = getAdapterPathsConfig();
  if (!pathsConfig) {
    return new PluginRegistry(pluginsPath);
  }

  const effectivePluginsPath = resolveEffectivePluginsPath({
    pluginsPath,
    configuredPluginsPath: pathsConfig.paths.plugins
  });

  return new PluginRegistry({
    pluginsPath: effectivePluginsPath,
    lookup: {
      warnOnOverride: pathsConfig.paths.lookup.warnOnOverride,
      builtinManifests: pathsConfig.paths.lookup.plugins.builtinManifests,
      builtinCode: pathsConfig.paths.lookup.plugins.builtinCode,
      local: pathsConfig.paths.lookup.plugins.local,
      externalRoots: pathsConfig.paths.lookup.plugins.externalRoots,
      areas: pathsConfig.paths.lookup.plugins.areas
    }
  });
}

/**
 * LLM Coordinator interface for type safety.
 */
export interface LLMCoordinatorLike {
  run(spec: unknown): Promise<unknown>;
  runStream(spec: unknown): AsyncIterable<unknown>;
  close(): Promise<void>;
}

/**
 * Creates an LLMCoordinator instance with logging configured.
 * Uses dynamic import to preserve lazy loading.
 */
export async function createLlmCoordinator(
  registry: PluginRegistryLike
): Promise<LLMCoordinatorLike> {
  const { LLMCoordinator } = await import('../../llm/index.js');
  const { createLoggingDeps } = await import('../../logging/index.js');
  return new LLMCoordinator(registry as PluginRegistry, {
    logging: createLoggingDeps()
  });
}

/**
 * Vector Coordinator interface for type safety.
 */
export interface VectorCoordinatorLike {
  execute(spec: unknown): Promise<unknown>;
  executeStream(spec: unknown): AsyncIterable<unknown>;
  close(): Promise<void>;
}

/**
 * Creates a VectorStoreCoordinator instance with logging configured.
 * Uses dynamic import to preserve lazy loading.
 */
export async function createVectorCoordinator(
  registry: PluginRegistryLike
): Promise<VectorCoordinatorLike> {
  const { VectorStoreCoordinator } = await import('../../vector/index.js');
  const { createLoggingDeps } = await import('../../logging/index.js');
  return new VectorStoreCoordinator(registry as PluginRegistry, {
    logging: createLoggingDeps()
  });
}

/**
 * Embedding Coordinator interface for type safety.
 */
export interface EmbeddingCoordinatorLike {
  execute(spec: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Creates an EmbeddingCoordinator instance with logging configured.
 * Uses dynamic import to preserve lazy loading.
 */
export async function createEmbeddingCoordinator(
  registry: PluginRegistryLike
): Promise<EmbeddingCoordinatorLike> {
  const { EmbeddingCoordinator } = await import('../../embeddings/index.js');
  const { createLoggingDeps } = await import('../../logging/index.js');
  return new EmbeddingCoordinator(registry as PluginRegistry, {
    logging: createLoggingDeps()
  });
}

/**
 * Closes the logger.
 * Uses dynamic import to preserve lazy loading.
 */
export async function closeLogger(): Promise<void> {
  const runtimeSymbol = Symbol.for('llm_adapter_observability_runtime');
  const runtime = (globalThis as any)[runtimeSymbol];
  if (runtime && typeof runtime.shutdownAll === 'function') {
    try {
      await runtime.shutdownAll();
    } catch {
      // Swallow observability shutdown failures; closing logging should still proceed.
    }
  }

  const { closeLogger: close } = await import('../../logging/index.js');
  return close();
}
