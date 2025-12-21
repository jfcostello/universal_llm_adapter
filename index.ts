// Package root entrypoint - all public modules accessible from here.
// ES modules are inherently lazy-loaded, so only imported code is executed.
// Subpath exports remain available for backwards compatibility.

// Kernel exports (types, registry, defaults, etc.)
export * from './modules/kernel/index.js';

// Feature modules
export * from './modules/llm/index.js';
export * from './modules/embeddings/index.js';
export * from './modules/vector/index.js';
export * from './modules/server/index.js';
export * from './modules/audio/index.js';
export * from './modules/realtime/index.js';
export * from './modules/mcp/index.js';
export * from './modules/tools/index.js';
export * from './modules/cli/index.js';

// Logging module - exclude AdapterLogger class to avoid conflict with kernel's interface.
// The kernel's AdapterLogger interface is the type contract; consumers wanting the class
// implementation should import from 'llm-adapter/logging' or use getLLMLogger().
export {
  // Logger classes
  BaseAdapterLogger,
  LLMLogger,
  EmbeddingLogger,
  VectorLogger,
  // Logger factory functions
  getLLMLogger,
  getEmbeddingLogger,
  getVectorLogger,
  getLogger,
  closeLogger,
  createLoggingDeps,
  // Retention utilities
  enforceRetention,
  readEnvInt,
  readEnvFloat,
  applyRetentionOnce,
  resetRetentionState
} from './modules/logging/index.js';

// Re-export types from logging
export type {
  RetentionOptions,
  ApplyRetentionOnceOptions
} from './modules/logging/index.js';
