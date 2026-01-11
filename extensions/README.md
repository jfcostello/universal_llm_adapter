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

## Tests

Extensions own their tests and they are **not** run by `npm test`.

- Core tests: `npm test`
- Extension tests: `npm run test:extensions`
