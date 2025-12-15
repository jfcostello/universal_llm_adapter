# `modules/kernel`

The kernel is the **always-available, provider-agnostic** foundation of the library.

It owns only the “core” primitives that the rest of the system builds on:
- Types and errors
- Default settings loading / config helpers
- Plugin registry (manifest loading + compat discovery)

## Hard rules
- **No feature imports**: kernel must not import server/tools/MCP/vector/embeddings modules.
- **Index-only access**: production code should treat everything under `internal/**` as a black box (tests may import internals).
- **No provider/model/endpoint/API/SDK naming** in kernel code/docs (those belong under `plugins/**` only).

## Layout
```text
modules/kernel/
  index.ts
  README.md
  internal/
    config.ts
    defaults.ts
    errors.ts
    registry.ts
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
} from '@/modules/kernel/index.ts';
```

