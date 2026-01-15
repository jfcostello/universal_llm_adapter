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

## Extension plugin roots resolution

Extensions should use `getExtensionPluginRoots()` to resolve ALL plugin directories in priority order:

```ts
import { getExtensionPluginRoots } from '@/modules/extensions/index.js';

// Returns all plugin roots that exist, in priority order
const pluginRoots: string[] = getExtensionPluginRoots('voice');
// e.g., ['/external/voice/plugins', '/dist/extensions/voice/plugins', '/src/extensions/voice/plugins']

// Callers iterate to find their files
for (const root of pluginRoots) {
  const files = glob.sync('providers/*.json', { cwd: root });
  if (files.length > 0) {
    // Found manifests in this root
    break;
  }
}
```

**Resolution order** (priority, highest first):
1. External roots from `llm-adapter.paths.json` (if configured via `paths.lookup.extensions.externalRoots`, returned in reverse order so later entries win)
2. `PACKAGE_ROOT/extensions/{extensionId}/plugins` (production/dist)
3. `cwd/extensions/{extensionId}/plugins` (development/source fallback)

**Features:**
- Returns ALL existing plugin directories so callers can search for their specific files
- Handles TypeScript projects where compiled JS may be in `dist/` but JSON manifests remain in source
- Integrates with `getAdapterPathsConfig()` for external root support
- Cache invalidates automatically when `process.cwd()` changes
- Paths are canonicalized via `realpathSync` to handle symlinks (e.g., macOS `/var` → `/private/var`)
- Deduplicates paths when multiple candidates resolve to the same location
