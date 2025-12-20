# `modules/usage`

Helpers for normalizing and presenting usage/cost metadata.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/usage/index.ts` (tests may import internals).

## Exports
- `usageStatsToJson(usage)` – normalizes optional usage fields to explicit `null`s.
- `extractUsageStats(raw, spec)` – spec-driven extraction from provider-shaped usage payloads.
- `getGlobalUsageSpec()` – returns the shared usage-path mapping.
- `mergeUsageExtractionSpecs(base, override)` – merges override usage paths ahead of base paths.
