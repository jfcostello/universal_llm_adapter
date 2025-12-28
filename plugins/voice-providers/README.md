# `plugins/voice-providers`

Voice provider manifests consumed by the Voice extension.

Each `*.json` declares:
- `id` (provider id)
- `kind` (compat module name under `plugins/voice-compat/<kind>`)
- optional `defaults` (provider-specific defaults; env-substitution is supported)

