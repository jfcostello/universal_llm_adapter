# `modules/string`

Small, dependency-free string helpers used across the library.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/string/index.ts` (tests may import internals).

## Exports
- `interpolate(template, data)` – simple placeholder interpolation for templates.

