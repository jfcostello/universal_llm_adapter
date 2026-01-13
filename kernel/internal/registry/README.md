# Plugin Registry (Kernel)

This directory contains the implementation of the kernel `PluginRegistry`.

## Why this exists

The registry is responsible for:
- Loading plugin manifests (providers, tools, MCP servers, vector stores, process routes, embeddings, observability).
- Resolving plugin **code** modules (compat layers) with multi-root precedence + prefer-same-root binding.
- Preserving ruthless lazy-loading: manifests and code are only loaded when requested, unless `validateAll()` is explicitly called.

The implementation was split out of `kernel/internal/registry.ts` to keep files small and cohesive.

## Structure

- `index.ts`: public entrypoint (re-exports public types + `PluginRegistry`).
- `internal/`: implementation details (lookup normalization, code-module resolution, per-area manifest loaders, and validation).

