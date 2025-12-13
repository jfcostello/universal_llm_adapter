// Kernel module public surface (provider-agnostic).
// Production code should import only from this file, not `internal/**`.

export * from './internal/types.js';
export * from './internal/errors.js';
export * from './internal/defaults.js';
export * from './internal/config.js';
export * from './internal/registry.js';
export * from './internal/embedding-spec-types.js';
export * from './internal/vector-spec-types.js';

