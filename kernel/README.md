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
