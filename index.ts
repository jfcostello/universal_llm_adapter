// Package root entrypoint is kernel-only to avoid loading any optional modules.
// Feature entrypoints are exposed via subpath exports (e.g. `llm-adapter/server`).

export * from './modules/kernel/index.js';
