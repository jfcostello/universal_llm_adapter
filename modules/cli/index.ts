/**
 * CLI module exports.
 *
 * IMPORTANT: The only public surface is the unified CLI.
 *
 * This module must remain safe to import without loading any heavy modules.
 * In particular, `llm-adapter --help` should only load commander (and Node built-ins).
 */

export type { UnifiedCliDependencies } from './internal/unified-cli.js';
export { createUnifiedProgram, runUnifiedCli } from './internal/unified-cli.js';
