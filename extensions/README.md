# Extensions

Extensions are **large, optional features** that bolt new “services” onto the adapter’s **server** and **CLI** without polluting core modules.

Key properties:
- **Default-off**: core behavior is unchanged unless an extension is enabled.
- **Strictly lazy-loaded**: extension code is loaded via `import()` only when enabled.
- **Removable**: you can delete an extension directory without breaking core (assuming nothing enables it).

## External packs

Extensions can be resolved from **external pack roots** configured via `llm-adapter.paths.json` (or `LLM_ADAPTER_PATHS_FILE`).

See `README-PACKS.md`.

## How extensions differ from plugins

- **Plugins** add providers/compats on top of existing capabilities (LLM, realtime, vector, embeddings, observability).
- **Extensions** add **new capability surfaces** (new endpoints, new CLI commands), typically by composing existing modules/plugins.

## Enabling extensions

Extensions are enabled via `server.extensions.enabled` (defaults are loaded from `plugins/configs/defaults.json`).

Example:

```json
{
  "server": {
    "extensions": {
      "enabled": ["voice"]
    }
  }
}
```

## CLI

Extensions can expose CLI surfaces under:

- `llm-adapter <extensionName> ...`

Extension CLI code is also **lazy-loaded** (only imported when the extension command is invoked).

You can explicitly enumerate extensions (directory scan) with:

- `llm-adapter extensions list`

## Extension defaults

An extension pack may include `extensions/<name>/defaults.json`.

The server loads this only when the extension is enabled, and merges it with `server.extensions[<name>]` (legacy override wins).

## Extension plugin roots resolution

Extensions should use `getExtensionPluginRoots()` from `modules/extensions` to resolve their plugin directories:

```ts
import { getExtensionPluginRoots } from '@/modules/extensions/index.js';

// Returns all plugin roots that exist, in priority order
const pluginRoots: string[] = getExtensionPluginRoots('voice');

// Iterate to find files across all roots
for (const root of pluginRoots) {
  // Search for manifests, compats, etc. in this root
}
```

**Resolution order** (priority, highest first):
1. External roots from `llm-adapter.paths.json` (if configured)
2. `PACKAGE_ROOT/extensions/{extensionId}/plugins` (production/dist)
3. `cwd/extensions/{extensionId}/plugins` (development/source fallback)

This multi-root approach handles TypeScript projects where compiled JS may be in `dist/` but JSON manifests remain in source directories.

Results are cached for performance. See `modules/extensions/README.md` for full details.

## Tests

Extensions own their tests and they are **not** run by `npm test`.

- Core tests: `npm test`
- Extension tests: `npm run test:extensions`
