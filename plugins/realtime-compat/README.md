# `plugins/realtime-compat/*`

Provider-specific realtime compatibility layers.

## Rules
- Realtime compats are provider/API specific and must live under this directory.
- Core code remains provider-agnostic and loads compats lazily via `PluginRegistry.getRealtimeCompat(kind)`.

## Layout
Each compat should be a self-contained module directory:

```
plugins/realtime-compat/<kind>/
  index.ts
  README.md
  internal/*
```

