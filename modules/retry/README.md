# `modules/retry`

Retry policy + sequencing helpers used to run prioritized fallbacks safely.

## Hard rules
- Provider-agnostic only.
- Production code imports only `modules/retry/index.ts` (tests may import internals).

## Public surface
- `withRetries(sequence, policy?, logger?, options?)`
  - `options.signal`: aborts before attempt and during retry delays.
  - `options.isAbortLikeError`: custom abort classifier to short-circuit retries.
- `createDefaultRetryPolicy()` and retry policy helpers from `retry-policy.ts`.
