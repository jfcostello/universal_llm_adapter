export type { PluginRegistryLike, CoordinatorLifecycleDeps } from './internal/types.js';
export { runWithCoordinatorLifecycle } from './internal/run.js';
export { streamWithCoordinatorLifecycle } from './internal/stream.js';

// Shared factory functions for creating registries and coordinators
export type {
  PluginRegistryLike as FactoryPluginRegistryLike,
  LLMCoordinatorLike,
  VectorCoordinatorLike,
  EmbeddingCoordinatorLike
} from './internal/factories.js';
export {
  createRegistry,
  resolveEffectivePluginsPath,
  createLlmCoordinator,
  createVectorCoordinator,
  createEmbeddingCoordinator,
  closeLogger
} from './internal/factories.js';
