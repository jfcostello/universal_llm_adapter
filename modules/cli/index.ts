/**
 * CLI module exports.
 *
 * IMPORTANT: The primary exports are createUnifiedProgram and runUnifiedCli.
 * Legacy exports (loadSpec, writeJsonToStdout, legacy CLIs) are kept for
 * backwards compatibility but will be removed in a future version.
 */

// Primary exports - unified CLI
export type { UnifiedCliDependencies } from './internal/unified-cli.js';
export { createUnifiedProgram, runUnifiedCli } from './internal/unified-cli.js';

// Legacy exports - kept for backwards compatibility, will be removed
export { loadSpec } from './internal/spec-loader.js';
export { writeJsonToStdout } from './internal/stdout-writer.js';
export type { WriteJsonToStdoutOptions } from './internal/stdout-writer.js';

export type { LlmCliDependencies } from './internal/llm-coordinator-cli.js';
export { createLlmCoordinatorProgram, runLlmCoordinatorCli } from './internal/llm-coordinator-cli.js';

export type { VectorCliDependencies } from './internal/vector-store-cli.js';
export {
  createVectorStoreCoordinatorProgram,
  runVectorStoreCoordinatorCli
} from './internal/vector-store-cli.js';
