# Coordinator Lifecycle Helper

Centralizes the common setup/teardown flow for running coordinators in both CLI and upcoming server modes.

## Purpose

Both CLIs and server endpoints need to:

1. Optionally set runtime/batch environment before any logging or coordinator work.
2. Create or reuse a `PluginRegistry` and invoke `loadAll()` for backward‑compatibility.
3. Create a fresh coordinator per invocation.
4. Ensure `coordinator.close()` and (optionally) `closeLogger()` always run, even on errors.

This module provides thin helpers to do that reliably and consistently.

## Exports

From `utils/coordinator-lifecycle/index.ts`:

- `runWithCoordinatorLifecycle(options)` → Promise result.
- `streamWithCoordinatorLifecycle(options)` → async generator yielding stream events.

Types:

- `PluginRegistryLike`
- `CoordinatorLifecycleDeps`

## Usage

### Non‑streaming (CLI)

```ts
const result = await runWithCoordinatorLifecycle({
  spec,
  pluginsPath: options.plugins,
  batchId: options.batchId,
  deps: {
    createRegistry: (p) => new PluginRegistry(p),
    createCoordinator: (r) => new LLMCoordinator(r)
  },
  run: (coordinator, s) => coordinator.run(s)
});
```

### Streaming (CLI/server)

```ts
for await (const event of streamWithCoordinatorLifecycle({
  spec,
  registry, // pass a shared registry for server mode
  deps: { createCoordinator: (r) => new LLMCoordinator(r) },
  stream: (coordinator, s) => coordinator.runStream(s)
})) {
  // handle event
}
```

## Notes

- `closeLoggerAfter` defaults to `true` to preserve CLI behavior. Server callers can disable it to avoid per‑request logger flushing.
- Cleanup errors never mask primary execution errors. If no primary error occurred, cleanup errors are surfaced.
- The helper is fully provider‑agnostic and contains no plugin‑specific logic.

