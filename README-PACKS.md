# External Packs + `llm-adapter.paths.json`

The adapter can load **plugins** and **extensions** from multiple roots so teams can keep their own packs in separate repos/directories and update the core safely.

This is configured via a user-owned `llm-adapter.paths.json` file (not `plugins/configs/defaults.json`).

## File discovery

The adapter looks for `llm-adapter.paths.json` in this order:

1. `LLM_ADAPTER_PATHS_FILE` (absolute, or relative to `process.cwd()`)
2. `./llm-adapter.paths.json` in `process.cwd()`
3. Walk up parent directories until found

If no file is found, the adapter falls back to the legacy single-root behavior.

> Note: the JSON loader supports `${ENV_VAR}` substitution (and `${ENV_VAR?}` for required env vars).

## What is a “pack root”?

- **Plugin roots** are directories that contain plugin areas like `providers/`, `tools/`, `compat/`, `configs/`, etc.
- **Extension pack roots** are directories that contain `extensions/<name>/index.(js|ts)`.

## Example `llm-adapter.paths.json`

```json
{
  "paths": {
    "plugins": "./plugins",
    "lookup": {
      "warnOnOverride": true,
      "plugins": {
        "builtinManifests": false,
        "builtinCode": true,
        "local": true,
        "externalRoots": ["../my-plugin-pack/plugins"],
        "areas": {
          "tools": { "local": false }
        }
      },
      "extensions": {
        "builtin": true,
        "externalRoots": ["../my-extension-pack"]
      },
      "configs": {
        "defaults": {
          "builtin": true,
          "local": true,
          "externalRoots": ["../my-plugin-pack/plugins"]
        },
        "usageCosts": {
          "builtin": true,
          "local": true,
          "externalRoots": ["../my-plugin-pack/plugins"]
        }
      }
    }
  }
}
```

Notes:
- `externalRoots` entries can be absolute or relative to `process.cwd()`; they are normalized and deduped.
- Higher-precedence roots override lower-precedence ones; when `warnOnOverride` is enabled the adapter logs warnings (e.g. `plugin_registry.override`, `extensions.override`, `usage_costs.override`).
- Config overlays are “baseline + user overlay”: values are merged from low → high precedence so new core fields can be inherited automatically.

## Running with a paths file

```bash
LLM_ADAPTER_PATHS_FILE=./llm-adapter.paths.json llm-adapter run --spec '{...}'
LLM_ADAPTER_PATHS_FILE=./llm-adapter.paths.json llm-adapter serve --port 3000
```

## Extensions: defaults

An extension can ship a per-extension defaults file:

- `extensions/<name>/defaults.json`

The server loads this only when the extension is enabled, and merges it with `server.extensions[<name>]` (legacy override wins).

