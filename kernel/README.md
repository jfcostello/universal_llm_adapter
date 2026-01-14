# `kernel`

The kernel is the **always-available, provider-agnostic** foundation of the library.

It owns only the **core primitives** that the rest of the system builds on:
- Types (specs + responses)
- Errors and logging primitives
- Default settings + config loading helpers
- Plugin registry (manifest loading + compat discovery)
- Small, generic utilities used across layers (e.g. bounded maps/queues)

## Hard rules
- **No feature imports**: kernel must not import server/tools/MCP/vector/embeddings modules.
- **Index-only access**: production code should treat everything under `internal/**` as a black box (tests may import internals).
- **No provider/model/endpoint/API/SDK naming** in kernel code/docs (those belong under `plugins/**` only).

## What belongs here (and why)
Kernel code should be safe to load **unconditionally** and should remain stable as the system grows. In practice, that means:
- Pure types and normalization helpers used across multiple modules
- Deterministic utilities (no network access, no filesystem writes, no process spawning)
- Shared primitives needed for coordination (e.g. async queues, bounded maps)
- Spec/schema helpers (e.g. session defaults, validation, normalization)

## Layout
```text
kernel/
  index.ts
  README.md
  internal/
    adapter-paths.ts
    async-queue.ts
    config.ts
    defaults.ts
    extension-paths.ts
    logger.ts
    errors.ts
    lru-map.ts
    observability-spec-types.ts
    observability.ts
    registry.ts
    realtime-ready-fallback.ts
    realtime-session-settings.ts
    realtime-tool-call-tracking.ts
    realtime-types.ts
    safe-data.ts
    tool-names.ts
    types.ts
    embedding-spec-types.ts
    vector-spec-types.ts
    paths.ts
```

## Usage
```ts
import {
  PluginRegistry,
  getDefaults,
  ManifestError
} from '@/kernel/index.ts';

// Lazy by default (manifests + plugin code loaded on demand)
const registry = new PluginRegistry('./plugins');

// Optional fail-fast validation for long-lived processes
await registry.validateAll();
```

### Extension Paths
Extensions can use `getExtensionPaths()` to resolve their plugin directories reliably:

```ts
import { getExtensionPaths } from '@/kernel/index.ts';

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
