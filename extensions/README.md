# Extensions

Extensions are **large, optional features** that bolt new “services” onto the adapter’s **server** and **CLI** without polluting core modules.

Key properties:
- **Default-off**: core behavior is unchanged unless an extension is enabled.
- **Strictly lazy-loaded**: extension code is loaded via `import()` only when enabled.
- **Removable**: you can delete an extension directory without breaking core (assuming nothing enables it).

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

## Tests

Extensions own their tests and they are **not** run by `npm test`.

- Core tests: `npm test`
- Extension tests: `npm run test:extensions`
- Voice extension tests: `npm run test:extensions:voice`

