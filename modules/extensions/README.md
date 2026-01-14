# Extensions Module

Resolves and enumerates *extension packs* across pack roots.

An extension pack root is a directory that contains `extensions/<name>/index.(js|ts)`.

## Pack root configuration

Pack roots are discovered via `llm-adapter.paths.json` (searched from `process.cwd()` and walking up), using:

- `paths.lookup.extensions.builtin` – include core/builtin extensions
- `paths.lookup.extensions.externalRoots` – additional pack roots (absolute or relative to `process.cwd()`)

When no `llm-adapter.paths.json` is present, the resolver falls back to builtin extensions only.

## Precedence and overrides

Roots are evaluated from low → high precedence:

1. builtin root (when enabled)
2. each `externalRoots[]` entry in order

If multiple roots contain the same extension name, the highest-precedence root wins.
When `paths.lookup.warnOnOverride` is enabled, an override emits a warning.

## Extension defaults

Extensions may ship a `extensions/<name>/defaults.json`.

This file is intended to be loaded only when an extension is enabled/invoked, and can be merged with
legacy configuration overlays provided by the server.

## Extension path resolution

Extensions should use `getExtensionPaths()` to resolve their plugin directories reliably:

```ts
import { getExtensionPaths } from '@/modules/extensions/index.js';

// Resolves extension root and plugins directory
const { extensionRoot, pluginsRoot } = getExtensionPaths('voice');

// Results are cached for performance (cache invalidates when cwd changes)
```

**Resolution order** (first match with existing plugins directory wins):
1. External roots from `llm-adapter.paths.json` (if configured via `paths.lookup.extensions.externalRoots`)
2. `PACKAGE_ROOT/extensions/{extensionId}/plugins` (production/dist)
3. `cwd/extensions/{extensionId}/plugins` (development/source fallback)

**Features:**
- Integrates with `getAdapterPathsConfig()` for external root support
- Cache invalidates automatically when `process.cwd()` changes
- Paths are canonicalized via `realpathSync` to handle symlinks (e.g., macOS `/var` → `/private/var`)

This handles the dist/source path discrepancy where TypeScript compiles to `dist/` but JSON manifests remain in source.
