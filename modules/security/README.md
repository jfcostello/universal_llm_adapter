# `modules/security`

Small, dependency-free security helpers used across the library.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/security/index.ts` (tests may import internals).

## Exports
- `genericRedactHeaders(headers)` – masks sensitive values in commonly used headers.

