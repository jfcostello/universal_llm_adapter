# Store Priority

Resolves and validates `vectorContexts[].storePriority` fallback chains for vector retrieval.

## Responsibilities
- Convert a logical `stores[]` entry into an ordered attempt chain.
- Enforce default behavior: fallback only on query failure/incomplete response.
- Support optional per-store `fallbackOnEmpty: true` override.
- Provide a runtime guard for detecting complete vector query responses.

## API
- `resolveStorePriorityChain(config, logicalStoreId)`:
  - Returns `{ fallbackOnEmpty, attempts }`.
  - Throws `config_error` for invalid explicit attempt config.
- `isCompleteVectorQueryResponse(response)`:
  - Returns `true` only for array responses.
