# Query Priority Runtime

Shared runtime for `vectorContexts[].queryPriority` candidate execution.

## Purpose
- Validate query-priority config invariants (`config_error` with status 400).
- Execute candidates in order with failure-only fallback semantics.
- Reuse request-local embedding vectors by `query + embeddingPriority`.
- Emit consistent structured logs for auto-inject and vector-search tool paths.

## Contract
- Candidate fallback happens only when embed/query calls fail.
- Empty query results are treated as successful candidate execution.
- `locks.collection` with `queryPriority` is invalid and fails closed.
- If every candidate fails to complete, returns an empty result set without throwing.

## Internal API
- `hasQueryPriority()` checks whether query-priority execution is enabled.
- `validateQueryPriorityCandidates()` validates and normalizes candidates.
- `executeQueryPriorityCandidates()` runs candidate resolution and store queries.
- `resolveDefaultQueryPriorityCandidate()` applies candidate/context/default precedence.
