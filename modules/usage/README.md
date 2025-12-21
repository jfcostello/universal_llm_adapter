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

## Usage spec extras
- Sum-mode candidates: `{ mode: 'sum', paths: [...] }` aggregates multiple fields (e.g., input + cache-read + cache-create). If any path is explicitly `null`, the sum returns `null`; if no values are found, it falls back to the next candidate.
- Prompt token accounting: set `promptTokensIncludeCached` in the spec to indicate whether `promptTokens` already includes cached tokens. This is stored as non-enumerable metadata on the usage object for cost calculation.
