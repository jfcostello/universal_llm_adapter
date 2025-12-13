// Public, black-box entrypoint for programmatic usage.
// Consumers should import from the package root, not internal paths.

export { LLMCoordinator } from './coordinator/coordinator.js';
export { VectorStoreCoordinator } from './coordinator/vector-coordinator.js';
export { EmbeddingCoordinator } from './coordinator/embedding-coordinator.js';

export {
  createServer,
  createServerHandlerWithDefaults
} from './utils/server/index.js';
export type {
  ServerOptions,
  RunningServer,
  ServerAuthOptions,
  ServerRateLimitOptions,
  ServerCorsOptions
} from './utils/server/index.js';

export * from './core/types.js';
export * from './core/vector-spec-types.js';
export * from './core/embedding-spec-types.js';
