# `modules/retry`

Retry policy + sequencing helpers used to run prioritized fallbacks safely.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/retry/index.ts` (tests may import internals).

