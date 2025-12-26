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

/**
 * Creates a PluginRegistry instance.
 * Uses dynamic import to preserve lazy loading.
 */
export async function createRegistry(pluginsPath: string): Promise<PluginRegistryLike> {
  const { PluginRegistry } = await import('../../../kernel/index.js');
  return new PluginRegistry(pluginsPath);
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
