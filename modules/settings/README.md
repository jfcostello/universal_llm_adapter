# `modules/settings`

Settings helpers used by coordinators/managers to split and merge call settings.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/settings/index.ts` (tests may import internals).

## Exports
- `partitionSettings(settings)` – splits settings into runtime vs call settings, and captures unknown extras.
- `mergeRuntimeSettings(target, overrides)` – merges runtime overrides.
- `mergeProviderSettings(global, overrides)` – deep merges settings overrides.

